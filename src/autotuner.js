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
}

function getParams() {
  return { ...params };
}

function getTuneLog() {
  return [...tuneLog];
}

module.exports = { autoTune, getParams, getTuneLog, params };
