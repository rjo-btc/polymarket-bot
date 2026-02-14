const express = require('express');
const path = require('path');
const { getAllPositions, getOpenPositions, insertPosition, getRecentDecisions, updatePostMortem } = require('./db');
const { findCurrentMarket, fetchTokenPrices, getCachedMarket } = require('./market');
const { getBtcPrice, getPrevBtcPrice, startPricePolling, fetchBtcPrice } = require('./btcPrice');
const { startTrader, getBotStatus } = require('./trader');
const { buildWinProfile, TIER_MULTIPLIERS, TIER_THRESHOLDS } = require('./confidence');
const { drainNotifications } = require('./notify');
const { runAnalysis } = require('./analysis');
const { getParams, getTuneLog, resetParams, setParam } = require('./autotuner');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
const CAPITAL_START = parseFloat(process.env.CAPITAL_START_USD) || 1000;
const RISK_PCT = parseFloat(process.env.RISK_PCT) || 7;

// Cache for BTC price at market start
const marketStartPrices = new Map();

app.get('/api/market', async (req, res) => {
  try {
    const market = await findCurrentMarket();
    if (!market) {
      return res.json({ error: 'No active market found' });
    }

    const prices = await fetchTokenPrices();
    const btc = getBtcPrice();
    const prevBtc = getPrevBtcPrice();
    const secsToEnd = Math.floor((market.endMs - Date.now()) / 1000);

    // Track BTC price at market start
    if (!marketStartPrices.has(market.market_slug) && btc.price) {
      marketStartPrices.set(market.market_slug, btc.price);
      // Cleanup old entries
      if (marketStartPrices.size > 100) {
        const keys = [...marketStartPrices.keys()];
        for (let i = 0; i < keys.length - 50; i++) {
          marketStartPrices.delete(keys[i]);
        }
      }
    }

    const btcAtStart = marketStartPrices.get(market.market_slug) || btc.price;
    const ageMs = btc.updatedAt ? Date.now() - new Date(btc.updatedAt).getTime() : null;

    res.json({
      market_slug: market.market_slug,
      title: market.title,
      market_start_at: market.market_start_at,
      market_end_at: market.market_end_at,
      seconds_to_end: secsToEnd,
      up_price: prices.up,
      down_price: prices.down,
      resolution_source: market.resolution_source,
      btc_price_now: btc.price,
      btc_price_now_updated_at: btc.updatedAt,
      btc_price_now_age_secs: ageMs != null ? Math.round(ageMs / 1000) : null,
      btc_price_prev: prevBtc.price,
      btc_price_prev_updated_at: prevBtc.updatedAt,
      btc_price_at_market_start: btcAtStart,
      btc_start_price_source: 'tick_at_or_after',
    });
  } catch (e) {
    console.error('GET /api/market error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/positions', (req, res) => {
  try {
    const positions = getAllPositions.all();
    const btc = getBtcPrice();

    const result = positions.map(p => ({
      id: p.id,
      market_slug: p.market_slug,
      market_title: p.market_title,
      strategy: p.strategy,
      side: p.side,
      stake_usd: p.stake_usd,
      shares: p.shares,
      entry_price: p.entry_price,
      entered_at: p.entered_at,
      seconds_to_end_at_entry: p.seconds_to_end_at_entry,
      btc_price_at_entry: p.btc_price_at_entry,
      btc_price_at_start: p.btc_price_at_start,
      btc_price_at_end: p.btc_price_at_end,
      entry_reason: p.entry_reason,
      post_mortem: p.post_mortem,
      btc_price_now: btc.price,
      mark_price: p.mark_price,
      pnl: p.pnl,
      pnl_pct: p.pnl_pct,
      status: p.status,
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/positions', async (req, res) => {
  try {
    const { side, stake_usd, entry_price, reason } = req.body;
    if (!side || !stake_usd || !reason) {
      return res.status(400).json({ error: 'side, stake_usd, and reason are required' });
    }

    const market = getCachedMarket();
    if (!market) {
      return res.status(400).json({ error: 'No active market' });
    }

    const prices = await fetchTokenPrices();
    const btc = getBtcPrice();
    const ep = entry_price || (side === 'up' ? prices.up : prices.down) || 0.5;
    const shares = stake_usd / ep;
    const secsToEnd = Math.floor((market.endMs - Date.now()) / 1000);
    const btcAtStart = marketStartPrices.get(market.market_slug) || btc.price;

    const info = insertPosition.run({
      market_slug: market.market_slug,
      market_title: market.title,
      strategy: 'manual',
      side,
      stake_usd,
      shares: Math.round(shares * 100) / 100,
      entry_price: ep,
      entered_at: new Date().toISOString(),
      seconds_to_end_at_entry: secsToEnd,
      btc_price_at_entry: btc.price,
      btc_price_at_start: btcAtStart,
      entry_reason: reason,
      market_end_at: market.market_end_at,
    });

    res.json({ id: Number(info.lastInsertRowid), status: 'ok' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/summary', (req, res) => {
  try {
    const positions = getAllPositions.all();
    const resolved = positions.filter(p => p.status === 'resolved');
    const totalPnl = resolved.reduce((s, p) => s + (p.pnl || 0), 0);
    const totalStake = positions.reduce((s, p) => s + p.stake_usd, 0);
    const wins = resolved.filter(p => p.pnl > 0);
    const losses = resolved.filter(p => p.pnl <= 0);

    // By strategy
    const stratMap = {};
    for (const p of positions) {
      if (!stratMap[p.strategy]) {
        stratMap[p.strategy] = { strategy: p.strategy, total_pnl_usd: 0, total_stake_usd: 0, total_trades: 0, resolved_trades: 0, winning_trades: 0, losing_trades: 0 };
      }
      const s = stratMap[p.strategy];
      s.total_trades++;
      s.total_stake_usd += p.stake_usd;
      if (p.status === 'resolved') {
        s.resolved_trades++;
        s.total_pnl_usd += (p.pnl || 0);
        if (p.pnl > 0) s.winning_trades++;
        else s.losing_trades++;
      }
    }

    const byStrategy = Object.values(stratMap).map(s => ({
      ...s,
      total_pnl_usd: Math.round(s.total_pnl_usd * 100) / 100,
      total_stake_usd: Math.round(s.total_stake_usd * 100) / 100,
      win_rate_pct: s.resolved_trades > 0 ? Math.round((s.winning_trades / s.resolved_trades) * 1000) / 10 : null,
    }));

    res.json({
      capital_start_usd: CAPITAL_START,
      capital_per_trade_usd: Math.round((CAPITAL_START + totalPnl) * (RISK_PCT / 100) * 100) / 100,
      total_capital_usd: Math.round((CAPITAL_START + totalPnl) * 100) / 100,
      total_pnl_usd: Math.round(totalPnl * 100) / 100,
      total_stake_usd: Math.round(totalStake * 100) / 100,
      total_trades: positions.length,
      open_trades: positions.filter(p => p.status === 'open').length,
      resolved_trades: resolved.length,
      winning_trades: wins.length,
      losing_trades: losses.length,
      // Max drawdown: worst peak-to-trough in cumulative PnL
      max_drawdown_usd: (() => {
        let peak = 0, maxDD = 0, cumPnl = 0;
        // Sort by id ascending for chronological order
        const sorted = [...resolved].sort((a, b) => a.id - b.id);
        for (const p of sorted) {
          cumPnl += (p.pnl || 0);
          if (cumPnl > peak) peak = cumPnl;
          const dd = peak - cumPnl;
          if (dd > maxDD) maxDD = dd;
        }
        return Math.round(maxDD * 100) / 100;
      })(),
      // Best single trade
      best_trade: wins.length > 0 ? (() => {
        const best = wins.reduce((a, b) => (a.pnl > b.pnl ? a : b));
        return { id: best.id, pnl: Math.round(best.pnl * 100) / 100, side: best.side, strategy: best.strategy, return_pct: Math.round((best.pnl / best.stake_usd) * 1000) / 10 };
      })() : null,
      // Worst single trade
      worst_trade: losses.length > 0 ? (() => {
        const worst = losses.reduce((a, b) => (a.pnl < b.pnl ? a : b));
        return { id: worst.id, pnl: Math.round(worst.pnl * 100) / 100, side: worst.side, strategy: worst.strategy, return_pct: Math.round((worst.pnl / worst.stake_usd) * 1000) / 10 };
      })() : null,
      by_strategy: byStrategy,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/kelly', (req, res) => {
  try {
    const positions = getAllPositions.all();
    const resolved = positions.filter(p => p.status === 'resolved');
    const totalPnl = resolved.reduce((s, p) => s + (p.pnl || 0), 0);
    const currentCapital = CAPITAL_START + totalPnl;
    const MIN_TRADES = 50;
    const MAX_RISK = 0.20;

    const CURRENT_FILTER_VERSION = 2;

    function calcKelly(trades) {
      const n = trades.length;
      const wins = trades.filter(p => p.pnl > 0);
      const losses = trades.filter(p => p.pnl <= 0);

      // Weight trades by filter version — current version = 1.0, older = decayed
      // v2 (current) = 1.0, v1 = 0.5, v0 = 0.25
      function tradeWeight(p) {
        const v = p.filter_version || 0;
        if (v >= CURRENT_FILTER_VERSION) return 1.0;
        if (v === CURRENT_FILTER_VERSION - 1) return 0.5;
        return 0.25;
      }

      const totalWeight = trades.reduce((s, p) => s + tradeWeight(p), 0);
      const weightedWins = wins.reduce((s, p) => s + tradeWeight(p), 0);
      const winRate = totalWeight > 0 ? weightedWins / totalWeight : 0;

      // Weighted average payout ratio
      const winPayouts = wins.map(p => ({ payout: (1 / p.entry_price) - 1, w: tradeWeight(p) })).filter(x => isFinite(x.payout) && x.payout > 0);
      const totalPayoutWeight = winPayouts.reduce((s, x) => s + x.w, 0);
      const avgPayout = totalPayoutWeight > 0 ? winPayouts.reduce((s, x) => s + x.payout * x.w, 0) / totalPayoutWeight : 1;

      // Effective sample size (sum of weights) for confidence calc
      const effectiveN = totalWeight;

      const fullKelly = avgPayout > 0 ? (avgPayout * winRate - (1 - winRate)) / avgPayout : 0;
      const halfKelly = Math.max(0, fullKelly / 2);
      const confidence = Math.min(1, Math.sqrt(effectiveN / MIN_TRADES));
      const adjusted = halfKelly * confidence;
      const capped = Math.min(adjusted, MAX_RISK);

      // Count trades at current filter version for progress
      const currentVersionTrades = trades.filter(p => (p.filter_version || 0) >= CURRENT_FILTER_VERSION).length;

      // Sharpe ratio: weighted mean(return%) / stdev(return%)
      const returns = trades.map(p => ({ r: p.pnl / p.stake_usd, w: tradeWeight(p) }));
      const wTotal = returns.reduce((s, x) => s + x.w, 0);
      const meanReturn = wTotal > 0 ? returns.reduce((s, x) => s + x.r * x.w, 0) / wTotal : 0;
      const variance = wTotal > 1 ? returns.reduce((s, x) => s + x.w * (x.r - meanReturn) ** 2, 0) / (wTotal - 1) : 0;
      const stdReturn = Math.sqrt(variance);
      const sharpe = stdReturn > 0 ? meanReturn / stdReturn : 0;

      return {
        n,
        wins: wins.length,
        losses: losses.length,
        win_rate: Math.round(winRate * 1000) / 10,
        avg_payout_ratio: Math.round(avgPayout * 1000) / 1000,
        avg_entry_price: n > 0 ? Math.round((trades.reduce((s, p) => s + p.entry_price, 0) / n) * 1000) / 1000 : null,
        full_kelly_pct: Math.round(Math.max(0, fullKelly) * 1000) / 10,
        half_kelly_pct: Math.round(halfKelly * 1000) / 10,
        confidence: Math.round(confidence * 1000) / 10,
        adjusted_pct: Math.round(adjusted * 1000) / 10,
        capped_pct: Math.round(capped * 1000) / 10,
        sharpe_ratio: Math.round(sharpe * 100) / 100,
        effective_n: Math.round(effectiveN * 10) / 10,
        current_version_trades: currentVersionTrades,
        status: effectiveN >= MIN_TRADES ? 'active' : 'collecting_data',
        trades_needed: Math.max(0, Math.ceil(MIN_TRADES - effectiveN)),
      };
    }

    // Per strategy
    const strategies = {};
    const stratGroups = {};
    for (const p of resolved) {
      if (!stratGroups[p.strategy]) stratGroups[p.strategy] = [];
      stratGroups[p.strategy].push(p);
    }
    for (const [strat, trades] of Object.entries(stratGroups)) {
      strategies[strat] = calcKelly(trades);
    }

    // Combined
    const combined = calcKelly(resolved);

    res.json({
      current_capital: Math.round(currentCapital * 100) / 100,
      current_risk_pct: RISK_PCT,
      max_risk_cap_pct: MAX_RISK * 100,
      min_trades_threshold: MIN_TRADES,
      strategies,
      combined,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/autotuner/reset', (req, res) => {
  try {
    const params = resetParams();
    res.json({ ok: true, params });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/autotuner/set', (req, res) => {
  try {
    const { strat, key, value } = req.body;
    if (!strat || !key || value === undefined) return res.status(400).json({ error: 'need strat, key, value' });
    const ok = setParam(strat, key, value);
    if (!ok) return res.status(400).json({ error: `unknown param ${strat}.${key}` });
    res.json({ ok: true, params: getParams() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analysis', (req, res) => {
  try {
    res.json(runAnalysis());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tuner', (req, res) => {
  try {
    res.json({ params: getParams(), log: getTuneLog() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backfill win post-mortems for resolved wins missing them
app.post('/api/backfill-postmortems', (req, res) => {
  try {
    const positions = getAllPositions.all();
    const resolved = positions.filter(p => p.status === 'resolved' && p.pnl > 0 && !p.post_mortem);
    let count = 0;
    for (const pos of resolved) {
      const btcStart = pos.btc_price_at_start || pos.btc_price_at_entry;
      const btcEnd = pos.btc_price_at_end || 0;
      const btcWentUp = btcEnd >= btcStart;
      const returnPct = ((pos.pnl / pos.stake_usd) * 100).toFixed(1);
      const btcMoveBps = btcStart ? ((btcEnd - btcStart) / btcStart * 10000).toFixed(1) : '0';
      const postMortem = `WIN REVIEW: Bought ${pos.side.toUpperCase()} @ ${pos.entry_price.toFixed(3)}, ` +
        `BTC start=${btcStart.toFixed(2)} end=${btcEnd.toFixed(2)} (${btcWentUp ? 'UP' : 'DOWN'}). ` +
        `Strategy: ${pos.strategy}. Return: +${returnPct}% ($${pos.pnl.toFixed(2)}). ` +
        `BTC moved ${btcMoveBps} bps. Entry ${pos.seconds_to_end_at_entry}s before end.`;
      updatePostMortem.run({ id: pos.id, post_mortem: postMortem });
      count++;
    }
    res.json({ backfilled: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/notifications', (req, res) => {
  res.json(drainNotifications());
});

app.get('/api/confidence', (req, res) => {
  try {
    const profile = buildWinProfile();
    const positions = getAllPositions.all().filter(p => p.status === 'resolved');
    const kellyActive = positions.length >= 50;
    res.json({
      kelly_active: kellyActive,
      trades_resolved: positions.length,
      trades_needed: Math.max(0, 50 - positions.length),
      tiers: TIER_MULTIPLIERS,
      thresholds: TIER_THRESHOLDS,
      win_profile: profile,
      status: kellyActive ? 'active' : profile ? 'preview' : 'insufficient_data',
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/api/bot-status', (req, res) => {
  try {
    const s = getBotStatus();
    // If lastTick is stale (>30s), report error
    if (s.lastTick && Date.now() - s.lastTick > 30000) {
      s.state = 'error';
      s.detail = 'Trader loop stalled — no tick in ' + Math.round((Date.now() - s.lastTick) / 1000) + 's';
    }
    res.json(s);
  } catch (e) {
    res.json({ state: 'error', detail: e.message });
  }
});

app.get('/api/decisions', (req, res) => {
  try {
    const decisions = getRecentDecisions.all();
    res.json(decisions.map(d => ({
      strategy: d.strategy,
      market_slug: d.market_slug,
      market_end_at: d.market_end_at,
      last_checked_at: d.last_checked_at,
      seconds_to_end: d.seconds_to_end,
      action: d.action,
      side: d.side,
      reason: d.reason,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start everything
startPricePolling(2000);
startTrader(10000);

app.listen(PORT, () => {
  console.log(`🚀 Polymarket BTC 5m Paper Trader running on port ${PORT}`);
});
