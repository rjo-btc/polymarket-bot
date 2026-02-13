const { runAnalysis } = require('./analysis');

/**
 * Dynamic strategy parameters — start with defaults, auto-tune based on analysis.
 * These are read by strategies on every evaluation.
 */
const params = {
  ema: {
    min_ema_dist_bps: 8,       // Minimum EMA distance to enter
    min_slope_abs: 0,           // Minimum absolute slope
    max_entry_price: 1.0,       // Max entry price (1.0 = no filter)
    min_entry_price: 0.0,       // Min entry price (0.0 = no filter)
    entry_window_min: 90,       // Earliest entry (secs to end)
    entry_window_max: 180,      // Latest entry (secs to end)
    enabled: true,
  },
  session: {
    min_slope_abs: 0,
    max_entry_price: 1.0,
    min_entry_price: 0.0,
    entry_window_min: 90,
    entry_window_max: 180,
    enabled: true,
  },
};

// Track what the tuner changed for the dashboard
const tuneLog = [];

function log(msg) {
  const entry = { time: new Date().toISOString(), msg };
  tuneLog.push(entry);
  if (tuneLog.length > 50) tuneLog.shift();
  console.log(`[AutoTuner] ${msg}`);
}

/**
 * Run auto-tuning based on current analysis.
 * Called after each position resolves.
 */
function autoTune() {
  const analysis = runAnalysis();
  if (analysis.insufficient_data || analysis.total_trades < 4) return;

  const { win_stats, loss_stats, patterns, by_strategy } = analysis;
  if (!win_stats || !loss_stats) return;

  // === SLOPE FILTER ===
  // If losses have weaker slope, set minimum slope to midpoint between loss avg and win avg
  const slopePattern = patterns.find(p => p.type === 'slope' && p.finding.includes('weaker'));
  if (slopePattern && win_stats.avg_slope != null && loss_stats.avg_slope != null) {
    const winSlopeAbs = Math.abs(win_stats.avg_slope);
    const lossSlopeAbs = Math.abs(loss_stats.avg_slope);
    // Set min slope to halfway between loss and win averages
    const newMin = Math.round(((lossSlopeAbs + winSlopeAbs) / 2) * 1000) / 1000;
    if (newMin > params.ema.min_slope_abs && newMin < winSlopeAbs) {
      const old = params.ema.min_slope_abs;
      params.ema.min_slope_abs = newMin;
      params.session.min_slope_abs = newMin;
      log(`Slope filter: ${old} → ${newMin} (losses avg ${lossSlopeAbs.toFixed(2)}, wins avg ${winSlopeAbs.toFixed(2)})`);
    }
  }

  // === ENTRY PRICE FILTER ===
  // If losses have cheap entries (market disagrees), set minimum entry price
  const pricePattern = patterns.find(p => p.type === 'entry_price' && p.severity === 'high');
  if (pricePattern && win_stats.avg_entry_price != null && loss_stats.avg_entry_price != null) {
    if (loss_stats.avg_entry_price < win_stats.avg_entry_price) {
      // Set min entry price to midpoint — don't take trades the market clearly disagrees with
      const newMin = Math.round(((loss_stats.avg_entry_price + win_stats.avg_entry_price) / 2) * 1000) / 1000;
      if (newMin > params.ema.min_entry_price && newMin < 0.8) {
        const old = params.ema.min_entry_price;
        params.ema.min_entry_price = newMin;
        params.session.min_entry_price = newMin;
        log(`Min entry price: ${old} → ${newMin} (losses avg ${loss_stats.avg_entry_price}, wins avg ${win_stats.avg_entry_price})`);
      }
    }
    if (loss_stats.avg_entry_price > win_stats.avg_entry_price) {
      // Losses paying too much — cap entry price
      const newMax = Math.round(((loss_stats.avg_entry_price + win_stats.avg_entry_price) / 2) * 1000) / 1000;
      if (newMax < params.ema.max_entry_price && newMax > 0.2) {
        const old = params.ema.max_entry_price;
        params.ema.max_entry_price = newMax;
        params.session.max_entry_price = newMax;
        log(`Max entry price: ${old} → ${newMax} (losses avg ${loss_stats.avg_entry_price}, wins avg ${win_stats.avg_entry_price})`);
      }
    }
  }

  // === TIMING FILTER ===
  // Adjust entry window based on where wins vs losses cluster
  const timingPattern = patterns.find(p => p.type === 'timing' && p.severity === 'high');
  if (timingPattern && win_stats.avg_seconds_to_end != null && loss_stats.avg_seconds_to_end != null) {
    if (loss_stats.avg_seconds_to_end < win_stats.avg_seconds_to_end) {
      // Losses enter later — tighten the minimum (raise it)
      const newMin = Math.round((loss_stats.avg_seconds_to_end + win_stats.avg_seconds_to_end) / 2);
      if (newMin > params.ema.entry_window_min && newMin < 170) {
        const old = params.ema.entry_window_min;
        params.ema.entry_window_min = newMin;
        params.session.entry_window_min = newMin;
        log(`Entry window min: ${old}s → ${newMin}s (losses avg ${loss_stats.avg_seconds_to_end}s, wins avg ${win_stats.avg_seconds_to_end}s)`);
      }
    }
  }

  // === EMA DISTANCE ===
  // If losses have smaller distance, increase threshold
  const distPattern = patterns.find(p => p.type === 'ema_distance' && p.finding.includes('smaller'));
  if (distPattern && win_stats.avg_dist_bps != null && loss_stats.avg_dist_bps != null) {
    const newMin = Math.round(((loss_stats.avg_dist_bps + win_stats.avg_dist_bps) / 2) * 10) / 10;
    if (newMin > params.ema.min_ema_dist_bps) {
      const old = params.ema.min_ema_dist_bps;
      params.ema.min_ema_dist_bps = newMin;
      log(`EMA dist threshold: ${old} → ${newMin} bps`);
    }
  }

  // === STRATEGY DISABLE ===
  for (const [strat, data] of Object.entries(by_strategy)) {
    if (data.recommendation.startsWith('DISABLE') && params[strat]) {
      if (params[strat].enabled !== false) {
        params[strat].enabled = false;
        log(`DISABLED strategy: ${strat} (win rate ${data.win_rate}% over ${data.total} trades)`);
      }
    }
  }

  // === WIN OPTIMIZATION: Narrow toward winning entry window ===
  // If wins cluster in a tighter time range, narrow the window to the sweet spot
  if (win_stats && win_stats.count >= 3 && win_stats.avg_seconds_to_end != null) {
    // Find the optimal entry window from wins — use their range as guide
    const winMetrics = analysis.wins_detail || [];
    if (winMetrics.length >= 3) {
      const winSecs = winMetrics.map(m => m.seconds_to_end).filter(s => s != null).sort((a, b) => a - b);
      if (winSecs.length >= 3) {
        // Use p25-p75 of winning entries as ideal window
        const p25 = winSecs[Math.floor(winSecs.length * 0.25)];
        const p75 = winSecs[Math.floor(winSecs.length * 0.75)];
        // Only narrow if the win cluster is tighter than current window
        if (p25 > params.ema.entry_window_min && p25 < p75) {
          const newMin = Math.max(params.ema.entry_window_min, Math.round(p25 - 5));
          if (newMin > params.ema.entry_window_min) {
            const old = params.ema.entry_window_min;
            params.ema.entry_window_min = newMin;
            params.session.entry_window_min = newMin;
            log(`WIN OPT — Entry window min: ${old}s → ${newMin}s (wins cluster p25=${p25}s)`);
          }
        }
      }
    }
  }

  // === WIN OPTIMIZATION: Favor entry prices that produce best returns ===
  if (win_stats && win_stats.count >= 3 && win_stats.avg_entry_price != null) {
    const winMetrics = analysis.wins_detail || [];
    if (winMetrics.length >= 3) {
      // Find the entry price sweet spot — best pnl trades
      const sorted = [...winMetrics].sort((a, b) => (b.pnl || 0) - (a.pnl || 0));
      const topHalf = sorted.slice(0, Math.ceil(sorted.length / 2));
      const topAvgEntry = topHalf.reduce((s, m) => s + m.entry_price, 0) / topHalf.length;
      const bottomHalf = sorted.slice(Math.ceil(sorted.length / 2));
      
      if (bottomHalf.length > 0) {
        const bottomAvgEntry = bottomHalf.reduce((s, m) => s + m.entry_price, 0) / bottomHalf.length;
        // If best wins come from cheaper entries (higher payout), prefer those
        if (topAvgEntry < bottomAvgEntry - 0.05) {
          const idealMax = Math.round(((topAvgEntry + bottomAvgEntry) / 2 + 0.1) * 1000) / 1000;
          if (idealMax < params.ema.max_entry_price && idealMax > 0.3) {
            const old = params.ema.max_entry_price;
            params.ema.max_entry_price = idealMax;
            params.session.max_entry_price = idealMax;
            log(`WIN OPT — Max entry price: ${old} → ${idealMax} (best wins avg entry ${topAvgEntry.toFixed(3)} vs weaker ${bottomAvgEntry.toFixed(3)})`);
          }
        }
      }
    }
  }

  // === WIN OPTIMIZATION: EMA distance sweet spot ===
  if (win_stats && win_stats.count >= 3 && win_stats.avg_dist_bps != null) {
    const winMetrics = analysis.wins_detail || [];
    const winDists = winMetrics.map(m => m.dist_bps).filter(d => d != null);
    if (winDists.length >= 3) {
      // If best wins happen at a certain EMA distance range, log it
      const sorted = [...winMetrics].filter(m => m.dist_bps != null).sort((a, b) => (b.pnl || 0) - (a.pnl || 0));
      const topDists = sorted.slice(0, Math.ceil(sorted.length / 2)).map(m => m.dist_bps);
      const avgTopDist = topDists.reduce((a, b) => a + b, 0) / topDists.length;
      log(`WIN PROFILE — Best wins avg EMA dist: ${avgTopDist.toFixed(1)} bps (overall avg: ${win_stats.avg_dist_bps} bps)`);
    }
  }
}

function getParams() {
  return { ...params };
}

function getTuneLog() {
  return [...tuneLog];
}

module.exports = { autoTune, getParams, getTuneLog, params };
