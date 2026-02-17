const { runAnalysis } = require('./analysis');
const { kvGet, kvSet } = require('./db');

const PARAMS_KEY = 'autotuner_params';
const LOG_KEY = 'autotuner_log';

/**
 * Dynamic strategy parameters — start with defaults, auto-tune based on analysis.
 * These are read by strategies on every evaluation.
 * PERSISTED to DB so they survive restarts/redeploys.
 */
const defaults = {
  ema: {
    // ACTION ITEM 2: EMA Distance Threshold - Increase minimum (losers averaged 9.3 bps)
    min_ema_dist_bps: 15,   // ENHANCED: from 40 → 15 bps minimum for cleaner signals
    min_slope_abs: 10.0,    // OPTIMIZED: winners averaged 14.3 vs losers 11.5 slope
    // ACTION ITEM 3: Entry Price Caps - User updated to 0.399 (Feb 17)
    max_entry_price: 0.399,  // USER REQUEST: increased from 0.30 → 0.399
    min_rr: 1.5,  // minimum R:R ratio — blocks coinflip trades
    min_entry_price: 0.0,
    entry_window_min: 220,  // OPTIMIZED: winners averaged 218s, favor early timing
    entry_window_max: 270,  // EXTENDED: allow more early entries
    side_bias: null,
    side_up_weight: 1.0,
    side_down_weight: 1.0,
    // ACTION ITEM 1: RSI Filter Enhancement - Block counter-trend trades
    rsi_down_max: 35,       // NEW: Block DOWN trades when RSI <35 (oversold bounce)
    rsi_up_min: 65,         // NEW: Block UP trades when RSI >65 (overbought drop)
    // ACTION ITEM 4: Momentum Confirmation - Price + EMA alignment required
    require_price_ema_alignment: true,  // NEW: Price must be on same side as trade direction
    min_momentum_acceleration: 2.0,     // NEW: Require accelerating momentum
    // Direction-specific: longs need strong signals (updated based on analysis)
    long_min_dist_bps: 15,  // ENHANCED: aligned with global minimum  
    long_min_slope: 10,     // ALIGNED: use global minimum for consistency
    // Direction-specific: shorts skip the mid-range death zone  
    short_dead_zone_lo: 10, // ENHANCED: tighter range to avoid weak signals
    short_dead_zone_hi: 15, // ENHANCED: aligned with new minimum
    short_dead_slope_lo: 8, // UPDATED: avoid weak momentum (was 3)
    short_dead_slope_hi: 10, // UPDATED: narrow dead zone (was 6)
    enabled: true,
  },
  session: {
    min_slope_abs: 10.0,    // OPTIMIZED: align with EMA strategy 
    max_entry_price: 0.399,  // USER REQUEST: increased from 0.30 → 0.399
    min_rr: 1.5,
    min_entry_price: 0.0,
    entry_window_min: 220,  // OPTIMIZED: favor early timing
    entry_window_max: 270,  // EXTENDED: allow more early entries
    side_bias: null,
    side_up_weight: 1.0,
    side_down_weight: 1.0,
    // ACTION ITEMS: Match EMA strategy enhancements
    rsi_down_max: 35,       // NEW: Block DOWN trades when RSI <35
    rsi_up_min: 65,         // NEW: Block UP trades when RSI >65
    require_price_ema_alignment: true,  // NEW: Price + EMA alignment
    min_momentum_acceleration: 2.0,     // NEW: Momentum requirement
    enabled: true,
  },
};

// Load persisted params or use defaults
function loadParams() {
  try {
    const row = kvGet.get(PARAMS_KEY);
    if (row) {
      const saved = JSON.parse(row.value);
      // Merge: use MAX of saved vs default for filter params (they should only get tighter, never looser)
      const merged = JSON.parse(JSON.stringify(defaults));
      const filterMaxKeys = ['min_ema_dist_bps', 'min_slope_abs', 'min_entry_price'];
      const filterMinKeys = ['max_entry_price', 'entry_window_max'];
      for (const strat of Object.keys(merged)) {
        if (saved[strat]) {
          for (const [k, v] of Object.entries(saved[strat])) {
            if (filterMaxKeys.includes(k)) {
              // Take the stricter (higher) value
              merged[strat][k] = Math.max(merged[strat][k] || 0, v || 0);
            } else if (filterMinKeys.includes(k)) {
              // Take the stricter (lower) value
              merged[strat][k] = Math.min(merged[strat][k] || 1, v || 1);
            } else {
              merged[strat][k] = v;
            }
          }
        }
      }
      return merged;
    }
  } catch (e) {
    console.error('[AutoTuner] Failed to load params:', e.message);
  }
  return JSON.parse(JSON.stringify(defaults));
}

function loadLog() {
  try {
    const row = kvGet.get(LOG_KEY);
    if (row) return JSON.parse(row.value);
  } catch (e) {}
  return [];
}

const params = loadParams();
const tuneLog = loadLog();

function saveParams() {
  try {
    kvSet.run({ key: PARAMS_KEY, value: JSON.stringify(params) });
  } catch (e) {
    console.error('[AutoTuner] Failed to save params:', e.message);
  }
}

function saveLog() {
  try {
    kvSet.run({ key: LOG_KEY, value: JSON.stringify(tuneLog.slice(-50)) });
  } catch (e) {}
}

console.log('[AutoTuner] Loaded params:', JSON.stringify(params.ema));

function log(msg) {
  const entry = { time: new Date().toISOString(), msg };
  tuneLog.push(entry);
  if (tuneLog.length > 50) tuneLog.shift();
  console.log(`[AutoTuner] ${msg}`);
  saveLog();
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
  // === ENTRY WINDOW === (disabled — manual only; wider window = cheaper entries + better R:R)
  // const timingPattern = patterns.find(p => p.type === 'timing' && p.severity === 'high');
  // if (timingPattern && win_stats.avg_seconds_to_end != null && loss_stats.avg_seconds_to_end != null) {
  //   if (loss_stats.avg_seconds_to_end < win_stats.avg_seconds_to_end) {
  //     const newMin = Math.round((loss_stats.avg_seconds_to_end + win_stats.avg_seconds_to_end) / 2);
  //     if (newMin > params.ema.entry_window_min && newMin < 170) {
  //       const old = params.ema.entry_window_min;
  //       params.ema.entry_window_min = newMin;
  //       params.session.entry_window_min = newMin;
  //       log(`Entry window min: ${old}s → ${newMin}s`);
  //     }
  //   }
  // }

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

  // === STRATEGY DISABLE === (disabled during tuning phase — re-enable after 50+ trades)
  // for (const [strat, data] of Object.entries(by_strategy)) {
  //   if (data.recommendation.startsWith('DISABLE') && params[strat]) {
  //     if (params[strat].enabled !== false) {
  //       params[strat].enabled = false;
  //       log(`DISABLED strategy: ${strat} (win rate ${data.win_rate}% over ${data.total} trades)`);
  //     }
  //   }
  // }

  // === WIN OPTIMIZATION: Narrow toward winning entry window ===
  // If wins cluster in a tighter time range, narrow the window to the sweet spot
  if (win_stats && win_stats.count >= 3 && win_stats.avg_seconds_to_end != null) {
    // === WIN ENTRY WINDOW === (disabled — manual only)
    // Entry window narrowing caused higher entry prices and worse R:R
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

  // === WIN OPTIMIZATION: EMA distance sweet spot (active adjustment) ===
  if (win_stats && win_stats.count >= 3 && win_stats.avg_dist_bps != null) {
    const winMetrics = analysis.wins_detail || [];
    const winDists = winMetrics.filter(m => m.dist_bps != null);
    if (winDists.length >= 3) {
      const sorted = [...winDists].sort((a, b) => (b.pnl || 0) - (a.pnl || 0));
      const topHalf = sorted.slice(0, Math.ceil(sorted.length / 2));
      const avgTopDist = topHalf.reduce((s, m) => s + m.dist_bps, 0) / topHalf.length;
      const allAvgDist = winDists.reduce((s, m) => s + m.dist_bps, 0) / winDists.length;

      // If best wins cluster at a higher EMA distance, raise the minimum toward it
      if (avgTopDist > allAvgDist + 1 && avgTopDist > params.ema.min_ema_dist_bps) {
        // Set min to midpoint between current and top-win average (gradual)
        const newMin = Math.round(((params.ema.min_ema_dist_bps + avgTopDist) / 2) * 10) / 10;
        if (newMin > params.ema.min_ema_dist_bps) {
          const old = params.ema.min_ema_dist_bps;
          params.ema.min_ema_dist_bps = newMin;
          log(`WIN OPT — EMA dist threshold: ${old} → ${newMin} bps (best wins avg ${avgTopDist.toFixed(1)} bps)`);
        }
      }
      log(`WIN PROFILE — Best wins avg EMA dist: ${avgTopDist.toFixed(1)} bps (overall win avg: ${allAvgDist.toFixed(1)} bps)`);
    }
  }

  // === SIDE BIAS: Adjust weights based on win rate per side ===
  const allMetrics = [...(analysis.wins_detail || []), ...(analysis.losses_detail || [])];
  if (allMetrics.length >= 6) {
    const upTrades = allMetrics.filter(m => m.side === 'up');
    const downTrades = allMetrics.filter(m => m.side === 'down');
    const upWins = upTrades.filter(m => m.won).length;
    const downWins = downTrades.filter(m => m.won).length;
    const upWinRate = upTrades.length >= 3 ? upWins / upTrades.length : null;
    const downWinRate = downTrades.length >= 3 ? downWins / downTrades.length : null;

    if (upWinRate != null && downWinRate != null) {
      const gap = Math.abs(upWinRate - downWinRate);

      if (gap >= 0.25) {
        // Strong bias — heavily reduce the weaker side
        const weakSide = upWinRate < downWinRate ? 'up' : 'down';
        const strongSide = weakSide === 'up' ? 'down' : 'up';
        const weakRate = Math.min(upWinRate, downWinRate);
        const strongRate = Math.max(upWinRate, downWinRate);

        // Weight = weak side win rate / strong side win rate (proportional)
        const newWeight = Math.round(Math.max(0.2, weakRate / strongRate) * 100) / 100;
        const weightKey = `side_${weakSide}_weight`;
        const strongKey = `side_${strongSide}_weight`;

        if (params.ema[weightKey] !== newWeight) {
          const old = params.ema[weightKey];
          params.ema[weightKey] = newWeight;
          params.session[weightKey] = newWeight;
          params.ema[strongKey] = 1.0;
          params.session[strongKey] = 1.0;
          log(`SIDE BIAS — ${weakSide.toUpperCase()} weight: ${old} → ${newWeight} (${weakSide} WR ${(weakRate * 100).toFixed(0)}% vs ${strongSide} WR ${(strongRate * 100).toFixed(0)}%)`);
        }
      } else if (gap < 0.1) {
        // No meaningful bias — reset weights
        if (params.ema.side_up_weight !== 1.0 || params.ema.side_down_weight !== 1.0) {
          params.ema.side_up_weight = 1.0;
          params.ema.side_down_weight = 1.0;
          params.session.side_up_weight = 1.0;
          params.session.side_down_weight = 1.0;
          log(`SIDE BIAS — Reset to neutral (UP WR ${(upWinRate * 100).toFixed(0)}% ≈ DOWN WR ${(downWinRate * 100).toFixed(0)}%)`);
        }
      }
    }
  }

  // Persist params after every tune
  saveParams();
}

function getParams() {
  return { ...params };
}

function getTuneLog() {
  return [...tuneLog];
}

function resetParams() {
  // Reset to defaults, clear saved
  const fresh = JSON.parse(JSON.stringify(defaults));
  Object.assign(params, fresh);
  saveParams();
  return params;
}

function setParam(strat, key, value) {
  if (params[strat] && key in params[strat]) {
    params[strat][key] = value;
    saveParams();
    return true;
  }
  return false;
}

module.exports = { autoTune, getParams, getTuneLog, params, resetParams, setParam };
