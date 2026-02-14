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

  // Only enter in dynamic window
  if (secsToEnd < p.entry_window_min || secsToEnd > p.entry_window_max) {
    return {
      ...base,
      action: 'SKIP',
      side: null,
      reason: `Outside entry window (${secsToEnd}s to end, need ${p.entry_window_min}-${p.entry_window_max}s)`,
    };
  }

  const klines = await fetchKlines(250);
  if (klines.length < 200) {
    return { ...base, action: 'SKIP', side: null, reason: `Not enough candles (${klines.length})` };
  }

  const closes = klines.map(k => k.close);
  const price = closes[closes.length - 1];
  const ema20 = calcEMA(closes, 20);
  const ema200 = calcEMA(closes, 200);

  const fast = ema20[ema20.length - 1];
  const slow = ema200[ema200.length - 1];
  const fastPrev = ema20[ema20.length - 2];
  const slope = fast - fastPrev;
  const distBps = ((price - fast) / fast) * 10000;
  const emaDistBps = ((fast - slow) / slow) * 10000;

  const paStr = `PA[dist=${Math.abs(distBps).toFixed(1)} bps,slope=${slope.toFixed(4)},ema20=${fast.toFixed(2)},ema200=${slow.toFixed(2)}]`;

  _latestState = {
    ema_dist_bps: parseFloat(Math.abs(emaDistBps).toFixed(1)),
    slope: parseFloat(slope.toFixed(4)),
    slope_abs: parseFloat(Math.abs(slope).toFixed(4)),
    ema20: parseFloat(fast.toFixed(2)),
    ema200: parseFloat(slow.toFixed(2)),
    min_dist_bps: p.min_ema_dist_bps ?? 5,
    min_slope: p.min_slope_abs ?? 2,
    long_min_dist: p.long_min_dist_bps ?? 8,
    long_min_slope: p.long_min_slope ?? 6,
    updated_at: new Date().toISOString(),
  };

  const slopeAbs = Math.abs(slope);
  const absEmaDistBps = Math.abs(emaDistBps);

  // Direction-specific filters:
  // LONGS: require strong signals (dist >= 8, slope >= 6) — weak longs lose
  // SHORTS: allow weak (<5) OR strong (>=8) dist — mid-range (5-8) is a death zone
  const LONG_MIN_DIST = p.long_min_dist_bps ?? 8;
  const LONG_MIN_SLOPE = p.long_min_slope ?? 6;
  const SHORT_DEAD_ZONE_LO = p.short_dead_zone_lo ?? 5;
  const SHORT_DEAD_ZONE_HI = p.short_dead_zone_hi ?? 8;
  const SHORT_DEAD_SLOPE_LO = p.short_dead_slope_lo ?? 3;
  const SHORT_DEAD_SLOPE_HI = p.short_dead_slope_hi ?? 6;

  // LONG: price > EMA20 > EMA200, strong signal required
  if (price > fast && fast > slow && slope > 0) {
    if (absEmaDistBps >= LONG_MIN_DIST && slopeAbs >= LONG_MIN_SLOPE) {
      return {
        ...base,
        action: 'ENTER',
        side: 'up',
        reason: `LONG signal: price ${price.toFixed(2)} > EMA20 ${fast.toFixed(2)} > EMA200 ${slow.toFixed(2)}; ${paStr}`,
      };
    }
    // Log why filtered
    const reasons = [];
    if (absEmaDistBps < LONG_MIN_DIST) reasons.push(`dist ${absEmaDistBps.toFixed(1)} < ${LONG_MIN_DIST} bps (long requires strong)`);
    if (slopeAbs < LONG_MIN_SLOPE) reasons.push(`slope ${slopeAbs.toFixed(2)} < ${LONG_MIN_SLOPE} (long requires strong)`);
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

    // Must still pass base filters
    if (absEmaDistBps >= p.min_ema_dist_bps && slopeAbs >= p.min_slope_abs) {
      return {
        ...base,
        action: 'ENTER',
        side: 'down',
        reason: `SHORT signal: price ${price.toFixed(2)} < EMA20 ${fast.toFixed(2)} < EMA200 ${slow.toFixed(2)}; ${paStr}`,
      };
    }

    const reasons = [];
    if (absEmaDistBps < p.min_ema_dist_bps) reasons.push(`dist ${absEmaDistBps.toFixed(1)} < ${p.min_ema_dist_bps} bps`);
    if (slopeAbs < p.min_slope_abs) reasons.push(`slope ${slopeAbs.toFixed(2)} < ${p.min_slope_abs}`);
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
function getLatestState() { return _latestState; }

module.exports = { evaluate, getLatestState };
