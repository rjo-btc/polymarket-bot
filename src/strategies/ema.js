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

  // === EARLY ENTRY SIGNALS (240-270s before end) ===
  // These fire before standard EMA alignment to get cheaper entries
  if (isEarlyWindow && (p.early_signals_enabled ?? true)) {
    const fastPrev2 = emaFast.length > 2 ? emaFast[emaFast.length - 3] : fastPrev;
    const slopePrev = fastPrev - fastPrev2;
    
    // 1. MOMENTUM BURST: strong candle body suggesting continuation
    const lastCandle = klines[klines.length - 1];
    const body = lastCandle.close - lastCandle.open;
    const bodyBps = Math.abs(body / lastCandle.open * 10000);
    const range = lastCandle.high - lastCandle.low;
    const bodyRatio = range > 0 ? Math.abs(body) / range : 0;
    
    if (bodyBps >= 5 && bodyRatio >= 0.7 && absPriceDistBps >= (p.min_ema_dist_bps || 5)) {
      const emaDist = ((fast - slow) / slow) * 10000;
      if (body > 0 && emaDist > -3 && currentRSI > 45 && currentRSI < (p.rsi_long_max ?? 75)) {
        return { ...base, action: 'ENTER', side: 'up', 
          reason: `EARLY MOMENTUM BURST UP: body ${bodyBps.toFixed(1)} bps (${(bodyRatio*100).toFixed(0)}% body), RSI ${currentRSI.toFixed(1)}; ${paStr}` };
      }
      if (body < 0 && emaDist < 3 && currentRSI < 55) {
        return { ...base, action: 'ENTER', side: 'down',
          reason: `EARLY MOMENTUM BURST DOWN: body ${bodyBps.toFixed(1)} bps (${(bodyRatio*100).toFixed(0)}% body), RSI ${currentRSI.toFixed(1)}; ${paStr}` };
      }
    }
    
    // 2. SLOPE ACCELERATION: EMA9 slope getting steeper each candle
    const accel1 = Math.abs(slope) - Math.abs(slopePrev);
    // Count consecutive accelerating candles for future analysis
    let consecAccel = 0;
    if (accel1 > 0) {
      consecAccel = 1;
      for (let j = 2; j <= 5; j++) {
        const prev = emaFast.length > j + 1 ? emaFast[emaFast.length - j] : null;
        const prevPrev = emaFast.length > j + 2 ? emaFast[emaFast.length - j - 1] : null;
        if (!prev || !prevPrev) break;
        const s1 = emaFast[emaFast.length - j + 1] - prev;
        const s2 = prev - prevPrev;
        if (Math.abs(s1) - Math.abs(s2) > 0) consecAccel++;
        else break;
      }
    }
    if (accel1 > 0 && slopeAbs >= 1 && absPriceDistBps >= (p.min_ema_dist_bps || 5)) {
      if (slope > 0 && fast > slow && currentRSI > 45 && currentRSI < (p.rsi_long_max ?? 75)) {
        return { ...base, action: 'ENTER', side: 'up',
          reason: `EARLY SLOPE ACCEL UP: slope ${slope.toFixed(4)} accelerating (Δ${accel1.toFixed(4)}, ${consecAccel} consec), RSI ${currentRSI.toFixed(1)}; ${paStr}` };
      }
      if (slope < 0 && fast < slow && currentRSI < 55) {
        return { ...base, action: 'ENTER', side: 'down',
          reason: `EARLY SLOPE ACCEL DOWN: slope ${slope.toFixed(4)} accelerating (Δ${accel1.toFixed(4)}, ${consecAccel} consec), RSI ${currentRSI.toFixed(1)}; ${paStr}` };
      }
    }
    
    // No early signal found — don't fall through to standard checks (too early for those)
    return { ...base, action: 'SKIP', side: null, reason: `Early window (${secsToEnd}s) — no momentum burst or slope acceleration; ${paStr}` };
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

  // RSI confirmation thresholds
  const RSI_LONG_MIN = p.rsi_long_min ?? 50;
  const RSI_LONG_MAX = p.rsi_long_max ?? 75;  // overbought cap — RSI > 75 = reversal risk
  const RSI_SHORT_MAX = p.rsi_short_max ?? 50;

  // LONG: price > EMAfast > EMAslow, strong signal required + RSI confirmation
  if (price > fast && fast > slow && slope > 0) {
    const reasons = [];
    if (absEmaDistBps < LONG_MIN_DIST) reasons.push(`dist ${absEmaDistBps.toFixed(1)} < ${LONG_MIN_DIST} bps (long requires strong)`);
    if (slopeAbs < LONG_MIN_SLOPE) reasons.push(`slope ${slopeAbs.toFixed(2)} < ${LONG_MIN_SLOPE} (long requires strong)`);
    if (currentRSI < RSI_LONG_MIN) reasons.push(`RSI ${currentRSI.toFixed(1)} < ${RSI_LONG_MIN} (no momentum confirmation)`);
    if (currentRSI > RSI_LONG_MAX) reasons.push(`RSI ${currentRSI.toFixed(1)} > ${RSI_LONG_MAX} (overbought — reversal risk)`);
    if (reasons.length === 0) {
      return {
        ...base,
        action: 'ENTER',
        side: 'up',
        reason: `LONG signal: price ${price.toFixed(2)} > EMA${fastPeriod} ${fast.toFixed(2)} > EMA${slowPeriod} ${slow.toFixed(2)}; RSI ${currentRSI.toFixed(1)}; ${paStr}`,
      };
    }
    return { ...base, action: 'SKIP', side: null, reason: `LONG aligned but filtered: ${reasons.join(', ')}; ${paStr}` };
  }

  // SHORT: price < EMA20 < EMA200, skip the mid-range death zone
  if (price < fast && fast < slow && slope < 0) {
    const inDistDeadZone = absEmaDistBps >= SHORT_DEAD_ZONE_LO && absEmaDistBps < SHORT_DEAD_ZONE_HI;
    const inSlopeDeadZone = slopeAbs >= SHORT_DEAD_SLOPE_LO && slopeAbs < SHORT_DEAD_SLOPE_HI;

    // Block if in the mid-range dead zone for BOTH dist and slope
    if (inDistDeadZone || inSlopeDeadZone) {
      const reasons = [];
      if (inDistDeadZone) reasons.push(`dist ${absEmaDistBps.toFixed(1)} in dead zone ${SHORT_DEAD_ZONE_LO}-${SHORT_DEAD_ZONE_HI} bps`);
      if (inSlopeDeadZone) reasons.push(`slope ${slopeAbs.toFixed(2)} in dead zone ${SHORT_DEAD_SLOPE_LO}-${SHORT_DEAD_SLOPE_HI}`);
      return { ...base, action: 'SKIP', side: null, reason: `SHORT mid-range trap filtered: ${reasons.join(', ')}; ${paStr}` };
    }

    // Must still pass base filters + RSI
    const reasons = [];
    if (absEmaDistBps < p.min_ema_dist_bps) reasons.push(`dist ${absEmaDistBps.toFixed(1)} < ${p.min_ema_dist_bps} bps`);
    if (slopeAbs < p.min_slope_abs) reasons.push(`slope ${slopeAbs.toFixed(2)} < ${p.min_slope_abs}`);
    if (currentRSI > RSI_SHORT_MAX) reasons.push(`RSI ${currentRSI.toFixed(1)} > ${RSI_SHORT_MAX} (no bearish confirmation)`);
    if (reasons.length === 0) {
      return {
        ...base,
        action: 'ENTER',
        side: 'down',
        reason: `SHORT signal: price ${price.toFixed(2)} < EMA${fastPeriod} ${fast.toFixed(2)} < EMA${slowPeriod} ${slow.toFixed(2)}; RSI ${currentRSI.toFixed(1)}; ${paStr}`,
      };
    }
    return { ...base, action: 'SKIP', side: null, reason: `SHORT aligned but filtered: ${reasons.join(', ')}; ${paStr}` };
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
