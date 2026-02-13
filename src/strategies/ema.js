const { fetchKlines } = require('../btcPrice');

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

  // Only enter in 90-180s window
  if (secsToEnd < 90 || secsToEnd > 180) {
    return {
      ...base,
      action: 'SKIP',
      side: null,
      reason: `Outside entry window (${secsToEnd}s to end, need 90-180s)`,
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

  // LONG: price > EMA20 > EMA200, positive slope, dist >= 8 bps
  if (price > fast && fast > slow && slope > 0 && Math.abs(emaDistBps) >= 8) {
    return {
      ...base,
      action: 'ENTER',
      side: 'up',
      reason: `LONG signal: price ${price.toFixed(2)} > EMA20 ${fast.toFixed(2)} > EMA200 ${slow.toFixed(2)}; ${paStr}`,
    };
  }

  // SHORT: price < EMA20 < EMA200, negative slope, dist >= 8 bps
  if (price < fast && fast < slow && slope < 0 && Math.abs(emaDistBps) >= 8) {
    return {
      ...base,
      action: 'ENTER',
      side: 'down',
      reason: `SHORT signal: price ${price.toFixed(2)} < EMA20 ${fast.toFixed(2)} < EMA200 ${slow.toFixed(2)}; ${paStr}`,
    };
  }

  return {
    ...base,
    action: 'SKIP',
    side: null,
    reason: `No EMA alignment; ${paStr}`,
  };
}

module.exports = { evaluate };
