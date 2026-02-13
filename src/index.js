const express = require('express');
const path = require('path');
const { getAllPositions, getOpenPositions, insertPosition, getRecentDecisions } = require('./db');
const { findCurrentMarket, fetchTokenPrices, getCachedMarket } = require('./market');
const { getBtcPrice, getPrevBtcPrice, startPricePolling, fetchBtcPrice } = require('./btcPrice');
const { startTrader } = require('./trader');

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
      by_strategy: byStrategy,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
