const { getAllPositions } = require('./db');

/**
 * Parse PA data from entry_reason string
 */
function parsePA(reason) {
  if (!reason) return {};
  const match = reason.match(/PA\[([^\]]+)\]/);
  if (!match) return {};
  const pa = {};
  match[1].split(',').forEach(part => {
    const [k, v] = part.split('=').map(s => s.trim());
    if (k && v) pa[k] = isNaN(v) ? v : parseFloat(v);
  });
  return pa;
}

/**
 * Extract key metrics from a position for comparison
 */
function extractMetrics(p) {
  const pa = parsePA(p.entry_reason);
  const isLong = /LONG/i.test(p.entry_reason);
  const btcMove = p.btc_price_at_end && p.btc_price_at_start
    ? ((p.btc_price_at_end - p.btc_price_at_start) / p.btc_price_at_start) * 10000
    : null;
  const btcMoveFromEntry = p.btc_price_at_end && p.btc_price_at_entry
    ? ((p.btc_price_at_end - p.btc_price_at_entry) / p.btc_price_at_entry) * 10000
    : null;

  return {
    id: p.id,
    strategy: p.strategy,
    side: p.side,
    direction: isLong ? 'long' : 'short',
    entry_price: p.entry_price,
    stake_usd: p.stake_usd,
    pnl: p.pnl,
    won: p.pnl > 0,
    seconds_to_end: p.seconds_to_end_at_entry,
    dist_bps: pa.dist || null,
    slope: pa.slope || null,
    ema20: pa.ema20 || null,
    ema200: pa.ema200 || null,
    btc_move_bps: btcMove ? Math.round(btcMove * 10) / 10 : null,
    btc_move_from_entry_bps: btcMoveFromEntry ? Math.round(btcMoveFromEntry * 10) / 10 : null,
    entered_at: p.entered_at,
  };
}

/**
 * Compute averages for a group of metrics
 */
function avgMetrics(group) {
  if (group.length === 0) return null;
  const avg = (arr) => {
    const valid = arr.filter(x => x != null && isFinite(x));
    return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  };
  const round = (v, d = 2) => v != null ? Math.round(v * Math.pow(10, d)) / Math.pow(10, d) : null;

  return {
    count: group.length,
    avg_entry_price: round(avg(group.map(m => m.entry_price)), 3),
    avg_seconds_to_end: round(avg(group.map(m => m.seconds_to_end)), 0),
    avg_dist_bps: round(avg(group.map(m => m.dist_bps)), 1),
    avg_slope: round(avg(group.map(m => m.slope)), 4),
    avg_btc_move_bps: round(avg(group.map(m => m.btc_move_bps)), 1),
    avg_btc_move_from_entry_bps: round(avg(group.map(m => m.btc_move_from_entry_bps)), 1),
    sides: { up: group.filter(m => m.side === 'up').length, down: group.filter(m => m.side === 'down').length },
  };
}

/**
 * Run full win/loss comparison analysis
 */
function runAnalysis() {
  const positions = getAllPositions.all().filter(p => p.status === 'resolved');
  if (positions.length < 2) return { insufficient_data: true, total_trades: positions.length };

  const metrics = positions.map(extractMetrics);
  const wins = metrics.filter(m => m.won);
  const losses = metrics.filter(m => !m.won);

  const winStats = avgMetrics(wins);
  const lossStats = avgMetrics(losses);

  // Find patterns in losses
  const patterns = [];

  if (winStats && lossStats) {
    // Compare entry timing
    if (lossStats.avg_seconds_to_end != null && winStats.avg_seconds_to_end != null) {
      const diff = lossStats.avg_seconds_to_end - winStats.avg_seconds_to_end;
      if (Math.abs(diff) > 10) {
        patterns.push({
          type: 'timing',
          finding: diff > 0
            ? `Losses enter earlier (${lossStats.avg_seconds_to_end}s vs wins ${winStats.avg_seconds_to_end}s) — consider tightening entry window`
            : `Losses enter later (${lossStats.avg_seconds_to_end}s vs wins ${winStats.avg_seconds_to_end}s) — earlier entries may be better`,
          severity: Math.abs(diff) > 20 ? 'high' : 'medium',
        });
      }
    }

    // Compare EMA distance
    if (lossStats.avg_dist_bps != null && winStats.avg_dist_bps != null) {
      const diff = lossStats.avg_dist_bps - winStats.avg_dist_bps;
      if (Math.abs(diff) > 1) {
        patterns.push({
          type: 'ema_distance',
          finding: diff < 0
            ? `Losses have smaller EMA distance (${lossStats.avg_dist_bps} bps vs wins ${winStats.avg_dist_bps} bps) — weak trend signals losing`
            : `Losses have larger EMA distance (${lossStats.avg_dist_bps} bps vs wins ${winStats.avg_dist_bps} bps) — overextended entries losing`,
          severity: Math.abs(diff) > 3 ? 'high' : 'medium',
        });
      }
    }

    // Compare slope strength
    if (lossStats.avg_slope != null && winStats.avg_slope != null) {
      const lossSlopeAbs = Math.abs(lossStats.avg_slope);
      const winSlopeAbs = Math.abs(winStats.avg_slope);
      if (Math.abs(lossSlopeAbs - winSlopeAbs) > 0.5) {
        patterns.push({
          type: 'slope',
          finding: lossSlopeAbs < winSlopeAbs
            ? `Losses have weaker slope (${lossSlopeAbs.toFixed(2)} vs wins ${winSlopeAbs.toFixed(2)}) — require stronger momentum`
            : `Losses have stronger slope (${lossSlopeAbs.toFixed(2)} vs wins ${winSlopeAbs.toFixed(2)}) — possible chop/reversal after strong moves`,
          severity: 'medium',
        });
      }
    }

    // Compare entry price (cost basis)
    if (lossStats.avg_entry_price != null && winStats.avg_entry_price != null) {
      const diff = lossStats.avg_entry_price - winStats.avg_entry_price;
      if (Math.abs(diff) > 0.05) {
        patterns.push({
          type: 'entry_price',
          finding: diff > 0
            ? `Losses pay more for entries (${lossStats.avg_entry_price} vs wins ${winStats.avg_entry_price}) — entering when market already priced in`
            : `Losses have cheaper entries (${lossStats.avg_entry_price} vs wins ${winStats.avg_entry_price}) — cheap entries = market disagrees`,
          severity: Math.abs(diff) > 0.1 ? 'high' : 'medium',
        });
      }
    }

    // BTC move analysis — are losses just bad luck or pattern?
    if (lossStats.avg_btc_move_bps != null && winStats.avg_btc_move_bps != null) {
      patterns.push({
        type: 'btc_move',
        finding: `Avg BTC move: Wins ${winStats.avg_btc_move_bps} bps, Losses ${lossStats.avg_btc_move_bps} bps`,
        severity: 'info',
      });
    }

    // Side bias
    if (losses.length >= 2) {
      const upLosses = losses.filter(m => m.side === 'up').length;
      const downLosses = losses.filter(m => m.side === 'down').length;
      const upWins = wins.filter(m => m.side === 'up').length;
      const downWins = wins.filter(m => m.side === 'down').length;

      const upWinRate = (upWins + upLosses) > 0 ? upWins / (upWins + upLosses) : null;
      const downWinRate = (downWins + downLosses) > 0 ? downWins / (downWins + downLosses) : null;

      if (upWinRate != null && downWinRate != null && Math.abs(upWinRate - downWinRate) > 0.15) {
        const better = upWinRate > downWinRate ? 'UP' : 'DOWN';
        const worse = upWinRate > downWinRate ? 'DOWN' : 'UP';
        const betterRate = Math.max(upWinRate, downWinRate);
        const worseRate = Math.min(upWinRate, downWinRate);
        patterns.push({
          type: 'side_bias',
          finding: `${better} trades win ${(betterRate * 100).toFixed(0)}% vs ${worse} at ${(worseRate * 100).toFixed(0)}% — consider reducing ${worse} trades`,
          severity: 'high',
        });
      }
    }
  }

  // Per-strategy analysis
  const byStrategy = {};
  const stratGroups = {};
  for (const m of metrics) {
    if (!stratGroups[m.strategy]) stratGroups[m.strategy] = [];
    stratGroups[m.strategy].push(m);
  }

  for (const [strat, group] of Object.entries(stratGroups)) {
    const sWins = group.filter(m => m.won);
    const sLosses = group.filter(m => !m.won);
    const winRate = group.length > 0 ? sWins.length / group.length : 0;

    byStrategy[strat] = {
      total: group.length,
      wins: sWins.length,
      losses: sLosses.length,
      win_rate: Math.round(winRate * 1000) / 10,
      win_stats: avgMetrics(sWins),
      loss_stats: avgMetrics(sLosses),
      recommendation: winRate < 0.4 && group.length >= 5
        ? 'DISABLE — win rate below 40% with sufficient sample'
        : winRate < 0.5 && group.length >= 10
        ? 'REVIEW — win rate below 50%, consider tightening params'
        : 'ACTIVE',
    };
  }

  // Suggested parameter tweaks
  const suggestions = [];
  for (const pattern of patterns) {
    if (pattern.severity === 'high') {
      if (pattern.type === 'ema_distance' && pattern.finding.includes('smaller')) {
        suggestions.push('Increase minimum EMA distance threshold (currently 8 bps)');
      }
      if (pattern.type === 'slope' && pattern.finding.includes('weaker')) {
        suggestions.push('Add minimum slope threshold for entries');
      }
      if (pattern.type === 'entry_price' && pattern.finding.includes('pay more')) {
        suggestions.push('Add max entry price filter (avoid entries > 0.70)');
      }
      if (pattern.type === 'side_bias') {
        suggestions.push(pattern.finding);
      }
    }
  }

  // Entry price bucket analysis for R:R optimization
  const buckets = [
    { label: 'cheap', min: 0, max: 0.5 },
    { label: 'mid', min: 0.5, max: 0.65 },
    { label: 'expensive', min: 0.65, max: 1.0 },
  ];
  const entryPriceBuckets = buckets.map(b => {
    const bucket = metrics.filter(m => m.entry_price >= b.min && m.entry_price < b.max);
    const bWins = bucket.filter(m => m.won);
    const avgReturn = bucket.length > 0
      ? bucket.reduce((s, m) => s + (m.pnl / (m.stake_usd || 1)), 0) / bucket.length * 100
      : 0;
    const avgMaxPayout = bucket.length > 0
      ? bucket.reduce((s, m) => s + ((1 / m.entry_price - 1) * 100), 0) / bucket.length
      : 0;
    return {
      label: b.label,
      range: `${b.min}-${b.max}`,
      trades: bucket.length,
      wins: bWins.length,
      win_rate: bucket.length > 0 ? Math.round((bWins.length / bucket.length) * 1000) / 10 : 0,
      avg_return_pct: Math.round(avgReturn * 10) / 10,
      avg_max_payout_pct: Math.round(avgMaxPayout * 10) / 10,
    };
  }).filter(b => b.trades > 0);

  return {
    total_trades: positions.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: Math.round((wins.length / positions.length) * 1000) / 10,
    win_stats: winStats,
    loss_stats: lossStats,
    wins_detail: wins,
    losses_detail: losses,
    entry_price_buckets: entryPriceBuckets,
    patterns,
    by_strategy: byStrategy,
    suggestions,
    last_updated: new Date().toISOString(),
  };
}

module.exports = { runAnalysis };
