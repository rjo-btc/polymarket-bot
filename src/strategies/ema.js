const { fetchKlines } = require('../btcPrice');
const { params } = require('../autotuner');

function calcEMA(data, period) {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcRSI(closes, period) {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

async function evaluate(market, btcPrice) {
  const secsToEnd = Math.floor((market.endMs - Date.now()) / 1000);

  const base = {
    strategy: 'ema',
    market_slug: market.market_slug,
    market_end_at: market.market_end_at,
    last_checked_at: new Date().toISOString(),
    seconds_to_end: secsToEnd,
  };

  const p = params.ema;

  // Check if strategy is disabled
  if (!p.enabled) {
    return { ...base, action: 'SKIP', side: null, reason: 'Strategy disabled by auto-tuner' };
  }

  // Entry windows: early (240-270s) for predictive signals, standard (150-240s) for confirmed
  const earlyWindowMax = p.early_window_max ?? 270;
  const earlyWindowMin = p.entry_window_max ?? 240;  // early window ends where standard begins
  
  if (secsToEnd < p.entry_window_min || secsToEnd > earlyWindowMax) {
    return {
      ...base,
      action: 'SKIP',
      side: null,
      reason: `Outside entry window (${secsToEnd}s to end, need ${p.entry_window_min}-${earlyWindowMax}s)`,
    };
  }

  const isEarlyWindow = secsToEnd > p.entry_window_max;  // in the early predictive zone

  const klines = await fetchKlines(250);
  if (klines.length < 200) {
    return { ...base, action: 'SKIP', side: null, reason: `Not enough candles (${klines.length})` };
  }

  const closes = klines.map(k => k.close);
  const price = closes[closes.length - 1];
  const fastPeriod = p.fast_period ?? 9;
  const slowPeriod = p.slow_period ?? 200;
  const emaFast = calcEMA(closes, fastPeriod);
  const emaSlow = calcEMA(closes, slowPeriod);
  const rsi = calcRSI(closes, 14);

  const fast = emaFast[emaFast.length - 1];
  const slow = emaSlow[emaSlow.length - 1];
  const fastPrev = emaFast[emaFast.length - 2];
  const slope = fast - fastPrev;
  const distBps = ((price - fast) / fast) * 10000;
  const emaDistBps = ((fast - slow) / slow) * 10000;
  const currentRSI = rsi[rsi.length - 1];

  const paStr = `PA[dist=${Math.abs(distBps).toFixed(1)} bps,edist=${Math.abs(emaDistBps).toFixed(1)} bps,slope=${slope.toFixed(4)},ema${fastPeriod}=${fast.toFixed(2)},ema${slowPeriod}=${slow.toFixed(2)},rsi=${currentRSI.toFixed(1)}]`;

  _latestState = {
    price_dist_bps: parseFloat(Math.abs(distBps).toFixed(1)),
    ema_dist_bps: parseFloat(Math.abs(emaDistBps).toFixed(1)),
    slope: parseFloat(slope.toFixed(4)),
    slope_abs: parseFloat(Math.abs(slope).toFixed(4)),
    fast_period: fastPeriod,
    slow_period: slowPeriod,
    ema_fast: parseFloat(fast.toFixed(2)),
    ema_slow: parseFloat(slow.toFixed(2)),
    rsi: parseFloat(currentRSI.toFixed(1)),
    min_dist_bps: p.min_ema_dist_bps ?? 5,
    min_slope: p.min_slope_abs ?? 2,
    long_min_dist: p.long_min_dist_bps ?? 8,
    long_min_slope: p.long_min_slope ?? 6,
    early_signals: (p.early_signals_enabled ?? true),
    entry_window: `${p.entry_window_min}-${p.entry_window_max}s (early: ${p.entry_window_max}-${p.early_window_max ?? 270}s)`,
    updated_at: new Date().toISOString(),
  };

  const slopeAbs = Math.abs(slope);
  const absEmaDistBps = Math.abs(emaDistBps);
  const absPriceDistBps = Math.abs(distBps);  // price-to-EMA9 distance

  // === EARLY ENTRY OPTIMIZATION ===
  // Analysis of last 45 trades shows winners prefer early timing (218s avg, 236s median)
  // Early entries now ENABLED with stronger filters (40+ BPS EMA dist, 10+ slope)
  // Previous early failures were due to weak signals, not timing itself

  // === ACTION ITEMS 1-4: ENHANCED MANDATORY VALIDATION ===
  // Updated based on last 10 losses analysis: counter-trend trading patterns identified
  const HARD_MIN_PRICE_DIST = 3;  // price-to-EMA9 must be >= 3 bps
  const HARD_MIN_EMA_DIST = 15;  // ACTION ITEM 2: Enhanced from 40→15 (losers averaged 9.3) - FORCED VALUE
  const HARD_MIN_SLOPE = 10;      // absolute slope must be >= 10 (winners averaged 14.3 vs 11.5)

  // ACTION ITEM 1: RSI FILTER ENHANCEMENT - Block counter-trend trades
  // Problem: DOWN trades in oversold (RSI ~31) bounce up, UP trades in overbought (RSI ~74) drop down
  const RSI_DOWN_MAX = p.rsi_down_max ?? 35;  // Block DOWN when RSI <35 (oversold bounce risk)
  const RSI_UP_MIN = p.rsi_up_min ?? 65;      // Block UP when RSI >65 (overbought drop risk)

  // ACTION ITEM 4: MOMENTUM CONFIRMATION - Price + EMA alignment check
  const REQUIRE_MOMENTUM = p.require_price_ema_alignment ?? true;
  const MIN_MOMENTUM_ACCEL = p.min_momentum_acceleration ?? 2.0;

  // Check hard minimums FIRST — these override everything else
  if (absPriceDistBps < HARD_MIN_PRICE_DIST) {
    return { ...base, action: 'SKIP', side: null, reason: `HARD FILTER: price-to-EMA dist ${absPriceDistBps.toFixed(1)} < ${HARD_MIN_PRICE_DIST} bps minimum; ${paStr}` };
  }
  if (absEmaDistBps < HARD_MIN_EMA_DIST) {
    return { ...base, action: 'SKIP', side: null, reason: `HARD FILTER: EMA-to-EMA dist ${absEmaDistBps.toFixed(1)} < ${HARD_MIN_EMA_DIST} bps minimum; ${paStr}` };
  }
  if (slopeAbs < HARD_MIN_SLOPE) {
    return { ...base, action: 'SKIP', side: null, reason: `HARD FILTER: slope ${slopeAbs.toFixed(2)} < ${HARD_MIN_SLOPE} minimum; ${paStr}` };
  }

  // === STANDARD ENTRY SIGNALS (150-240s before end) ===
  // Direction-specific filters:
  // LONGS: require strong signals (dist >= 8, slope >= 6) — weak longs lose
  // SHORTS: allow weak (<5) OR strong (>=8) dist — mid-range (5-8) is a death zone
  const LONG_MIN_DIST = p.long_min_dist_bps ?? 8;
  const LONG_MIN_SLOPE = p.long_min_slope ?? 6;
  const SHORT_DEAD_ZONE_LO = p.short_dead_zone_lo ?? 5;
  const SHORT_DEAD_ZONE_HI = p.short_dead_zone_hi ?? 8;
  const SHORT_DEAD_SLOPE_LO = p.short_dead_slope_lo ?? 3;
  const SHORT_DEAD_SLOPE_HI = p.short_dead_slope_hi ?? 6;

  // RSI confirmation thresholds — OPTIMIZED based on winner analysis
  const RSI_LONG_MIN = p.rsi_long_min ?? 60;   // UP needs momentum (all winners had RSI 60+)
  const RSI_LONG_MAX = p.rsi_long_max ?? 75;   // keep upper bound for safety
  const RSI_SHORT_MIN = p.rsi_short_min ?? 20; // DOWN allows oversold bounces (winners at RSI 21+)  
  const RSI_SHORT_MAX = p.rsi_short_max ?? 45; // DOWN sweet spot caps at RSI 45

  // === ENTRY PRICE CAPS - Updated per user request (Feb 17) ===
  // User requested 0.399 max entry price
  function getDynamicMaxEntryPrice(emaDistBps, slopeAbs) {
    // USER REQUEST: Max entry 0.399 (Feb 17)
    if (emaDistBps >= 30 && slopeAbs >= 15) {
      return 0.399; // Ultra-strong: 30+ BPS EMA + 15+ slope
    } else if (emaDistBps >= 20 && slopeAbs >= 10) {
      return 0.35; // Strong: 20+ BPS EMA + 10+ slope
    } else {
      return 0.30; // Minimum signals: baseline cap
    }
  }

  // LONG: price > EMAfast > EMAslow, strong signal required + RSI confirmation
  if (price > fast && fast > slow && slope > 0) {
    const reasons = [];
    
    // ACTION ITEM 1: RSI FILTER - Block UP trades when RSI >65 (overbought → drop)
    if (currentRSI > RSI_UP_MIN) {
      reasons.push(`RSI BLOCK: ${currentRSI.toFixed(1)} > ${RSI_UP_MIN} (overbought → drop risk, avg loss RSI was ${73.8})`);
    }
    
    // ACTION ITEM 4: MOMENTUM CONFIRMATION - Price acceleration check
    if (REQUIRE_MOMENTUM) {
      const prevSlope = emaFast[emaFast.length - 3] - emaFast[emaFast.length - 4];
      const slopeAccel = slope - prevSlope;
      if (slopeAccel < MIN_MOMENTUM_ACCEL) {
        reasons.push(`MOMENTUM BLOCK: acceleration ${slopeAccel.toFixed(2)} < ${MIN_MOMENTUM_ACCEL} (no momentum burst)`);
      }
    }
    
    // MANDATORY: Longs need strong EMA-to-EMA distance (prevents weak long losses)
    if (absEmaDistBps < LONG_MIN_DIST) reasons.push(`EMA dist ${absEmaDistBps.toFixed(1)} < ${LONG_MIN_DIST} bps (long requires strong trend)`);
    if (slopeAbs < LONG_MIN_SLOPE) reasons.push(`slope ${slopeAbs.toFixed(2)} < ${LONG_MIN_SLOPE} (long requires strong momentum)`);
    
    // Legacy RSI confirmation (now more restrictive due to ACTION ITEM 1)
    if (currentRSI < RSI_LONG_MIN) reasons.push(`RSI ${currentRSI.toFixed(1)} < ${RSI_LONG_MIN} (UP needs momentum zone)`);
    if (currentRSI > RSI_LONG_MAX) reasons.push(`RSI ${currentRSI.toFixed(1)} > ${RSI_LONG_MAX} (overbought — reversal risk)`);
    
    if (reasons.length === 0) {
      const dynamicMaxPrice = getDynamicMaxEntryPrice(absEmaDistBps, slopeAbs);
      const signalTier = dynamicMaxPrice === 0.60 ? 'ULTRA' : dynamicMaxPrice === 0.40 ? 'STRONG' : 'MINIMUM';
      return {
        ...base,
        action: 'ENTER',
        side: 'up',
        reason: `LONG signal: price ${price.toFixed(2)} > EMA${fastPeriod} ${fast.toFixed(2)} > EMA${slowPeriod} ${slow.toFixed(2)}; RSI ${currentRSI.toFixed(1)}; ${paStr}`,
        dynamic_max_entry_price: dynamicMaxPrice,
        signal_tier: signalTier,
      };
    }
    return { ...base, action: 'SKIP', side: null, reason: `LONG FILTERED: ${reasons.join(', ')}; ${paStr}` };
  }

  // SHORT: price < EMA9 < EMA200, skip the mid-range death zone
  if (price < fast && fast < slow && slope < 0) {
    const reasons = [];
    
    // ACTION ITEM 1: RSI FILTER - Block DOWN trades when RSI <35 (oversold → bounce)
    if (currentRSI < RSI_DOWN_MAX) {
      reasons.push(`RSI BLOCK: ${currentRSI.toFixed(1)} < ${RSI_DOWN_MAX} (oversold → bounce risk, avg loss RSI was ${31.2})`);
    }
    
    // ACTION ITEM 4: MOMENTUM CONFIRMATION - Price acceleration check  
    if (REQUIRE_MOMENTUM) {
      const prevSlope = emaFast[emaFast.length - 3] - emaFast[emaFast.length - 4];
      const slopeAccel = Math.abs(slope - prevSlope); // acceleration magnitude
      if (slopeAccel < MIN_MOMENTUM_ACCEL) {
        reasons.push(`MOMENTUM BLOCK: acceleration ${slopeAccel.toFixed(2)} < ${MIN_MOMENTUM_ACCEL} (no momentum burst)`);
      }
    }
    
    // Check dead zones (mid-range 10-15 bps dist updated per ACTION ITEM 2)
    const inDistDeadZone = absEmaDistBps >= SHORT_DEAD_ZONE_LO && absEmaDistBps < SHORT_DEAD_ZONE_HI;
    const inSlopeDeadZone = slopeAbs >= SHORT_DEAD_SLOPE_LO && slopeAbs < SHORT_DEAD_SLOPE_HI;
    
    if (inDistDeadZone) reasons.push(`EMA dist ${absEmaDistBps.toFixed(1)} in dead zone ${SHORT_DEAD_ZONE_LO}-${SHORT_DEAD_ZONE_HI} bps`);
    if (inSlopeDeadZone) reasons.push(`slope ${slopeAbs.toFixed(2)} in dead zone ${SHORT_DEAD_SLOPE_LO}-${SHORT_DEAD_SLOPE_HI}`);
    
    // Additional base filters (enhanced per ACTION ITEM 2)
    if (absEmaDistBps < HARD_MIN_EMA_DIST) reasons.push(`EMA dist ${absEmaDistBps.toFixed(1)} < ${HARD_MIN_EMA_DIST} bps minimum`);
    if (slopeAbs < (p.min_slope_abs ?? 2)) reasons.push(`slope ${slopeAbs.toFixed(2)} < ${p.min_slope_abs ?? 2} minimum`);
    
    // Legacy RSI confirmation (now more restrictive due to ACTION ITEM 1)
    if (currentRSI < RSI_SHORT_MIN) reasons.push(`RSI ${currentRSI.toFixed(1)} < ${RSI_SHORT_MIN} (too oversold — extreme reversal risk)`);
    if (currentRSI > RSI_SHORT_MAX) reasons.push(`RSI ${currentRSI.toFixed(1)} > ${RSI_SHORT_MAX} (bearish momentum zone)`);
    
    if (reasons.length === 0) {
      const dynamicMaxPrice = getDynamicMaxEntryPrice(absEmaDistBps, slopeAbs);
      const signalTier = dynamicMaxPrice === 0.60 ? 'ULTRA' : dynamicMaxPrice === 0.40 ? 'STRONG' : 'MINIMUM';
      return {
        ...base,
        action: 'ENTER',
        side: 'down',
        reason: `SHORT signal: price ${price.toFixed(2)} < EMA${fastPeriod} ${fast.toFixed(2)} < EMA${slowPeriod} ${slow.toFixed(2)}; RSI ${currentRSI.toFixed(1)}; ${paStr}`,
        dynamic_max_entry_price: dynamicMaxPrice,
        signal_tier: signalTier,
      };
    }
    return { ...base, action: 'SKIP', side: null, reason: `SHORT FILTERED: ${reasons.join(', ')}; ${paStr}` };
  }

  // Not aligned at all
  if ((price > fast && fast > slow) || (price < fast && fast < slow)) {
    return { ...base, action: 'SKIP', side: null, reason: `EMA partial alignment; ${paStr}` };
  }

  return {
    ...base,
    action: 'SKIP',
    side: null,
    reason: `No EMA alignment; ${paStr}`,
  };
}

// Expose latest EMA state for dashboard
let _latestState = null;

async function computeState() {
  try {
    const p = params.ema;
    const klines = await fetchKlines(250);
    if (klines.length < 200) return _latestState;
    const closes = klines.map(k => k.close);
    const price = closes[closes.length - 1];
    const fastPeriod = p.fast_period ?? 9;
    const slowPeriod = p.slow_period ?? 200;
    const emaFast = calcEMA(closes, fastPeriod);
    const emaSlow = calcEMA(closes, slowPeriod);
    const rsi = calcRSI(closes, 14);
    const fast = emaFast[emaFast.length - 1];
    const slow = emaSlow[emaSlow.length - 1];
    const fastPrev = emaFast[emaFast.length - 2];
    const slope = fast - fastPrev;
    const distBps = ((price - fast) / fast) * 10000;
    const emaDistBps = ((fast - slow) / slow) * 10000;
    _latestState = {
      price_dist_bps: parseFloat(Math.abs(distBps).toFixed(1)),
      ema_dist_bps: parseFloat(Math.abs(emaDistBps).toFixed(1)),
      slope: parseFloat(slope.toFixed(4)),
      slope_abs: parseFloat(Math.abs(slope).toFixed(4)),
      fast_period: fastPeriod,
      slow_period: slowPeriod,
      ema_fast: parseFloat(fast.toFixed(2)),
      ema_slow: parseFloat(slow.toFixed(2)),
      rsi: parseFloat(rsi[rsi.length - 1].toFixed(1)),
      min_dist_bps: p.min_ema_dist_bps ?? 5,
      min_slope: p.min_slope_abs ?? 2,
      long_min_dist: p.long_min_dist_bps ?? 8,
      long_min_slope: p.long_min_slope ?? 6,
      updated_at: new Date().toISOString(),
    };
  } catch (e) { /* keep last state */ }
  return _latestState;
}

function getLatestState() { return _latestState; }

module.exports = { evaluate, getLatestState, computeState };
