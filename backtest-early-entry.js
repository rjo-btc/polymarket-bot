/**
 * Early Entry Optimization Backtest
 * 
 * Tests strategies for getting cheaper Polymarket entries:
 * 1. Predictive signals — enter BEFORE EMA alignment completes (anticipate crossover)
 * 2. Price momentum pre-signal — BTC starting to move but MAs haven't caught up
 * 3. Extended window (up to 4 min before end = 240s)
 * 4. Candle pattern detection — strong candle body suggests continuation
 * 5. Speed of approach — how fast price is approaching EMA alignment
 */

const { fetchKlines } = require('./src/btcPrice');

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i - 1] * (1 - k));
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

function impliedEntry(closes, i, side, timing) {
  // timing: 'early' (240-180s), 'mid' (180-150s), 'standard' (150-90s)
  const lookback5 = closes[Math.max(0, i - 5)];
  const recentMoveBps = ((closes[i] - lookback5) / lookback5) * 10000;
  const absMove = Math.abs(recentMoveBps);
  const dirCorrect = (side === 'up' && recentMoveBps > 0) || (side === 'down' && recentMoveBps < 0);
  
  // Earlier timing = cheaper entry (market hasn't priced in the move)
  let timeDiscount = 0;
  if (timing === 'early') timeDiscount = -0.08;      // 240-180s: very cheap
  else if (timing === 'mid') timeDiscount = -0.04;    // 180-150s: somewhat cheap
  // 'standard' = no discount
  
  const premium = dirCorrect ? Math.min(0.15, absMove * 0.005) : -Math.min(0.10, absMove * 0.003);
  return Math.min(0.65, Math.max(0.20, 0.50 + premium + timeDiscount));
}

function test(name, klines, closes, signalFn) {
  const all = [];
  for (let i = 210; i < closes.length - 1; i++) {
    const sig = signalFn(i);
    if (!sig) continue;
    const entry = impliedEntry(closes, i, sig.side, sig.timing || 'standard');
    const nextClose = closes[i + 1];
    const won = (sig.side === 'up' && nextClose > closes[i]) || (sig.side === 'down' && nextClose < closes[i]);
    all.push({ ...sig, won, entry });
  }
  const wr = all.length ? (all.filter(x => x.won).length / all.length * 100) : 0;
  const avgEntry = all.length ? all.reduce((s, x) => s + x.entry, 0) / all.length : 0;
  const ev = wr / 100 - avgEntry;
  const up = all.filter(x => x.side === 'up');
  const dn = all.filter(x => x.side === 'down');
  const upWR = up.length ? (up.filter(x => x.won).length / up.length * 100).toFixed(1) : 'N/A';
  const dnWR = dn.length ? (dn.filter(x => x.won).length / dn.length * 100).toFixed(1) : 'N/A';
  
  // By timing
  const early = all.filter(x => x.timing === 'early');
  const mid = all.filter(x => x.timing === 'mid');
  const std = all.filter(x => x.timing === 'standard');
  const tStats = (arr) => {
    if (!arr.length) return 'N/A';
    const w = (arr.filter(x => x.won).length / arr.length * 100).toFixed(1);
    const e = (arr.reduce((s, x) => s + x.entry, 0) / arr.length).toFixed(3);
    return `${arr.length} sig, ${w}% WR, ${e} entry, EV ${(parseFloat(w)/100 - parseFloat(e)).toFixed(3)}`;
  };
  
  return { name, count: all.length, wr: wr.toFixed(1), avgEntry: avgEntry.toFixed(3), ev, 
    upCount: up.length, upWR, dnCount: dn.length, dnWR,
    early: tStats(early), mid: tStats(mid), standard: tStats(std) };
}

async function run() {
  console.log('Fetching klines...');
  const klines = await fetchKlines(1000);
  console.log(`Got ${klines.length} candles\n`);
  
  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const ema9 = calcEMA(closes, 9);
  const ema200 = calcEMA(closes, 200);
  const rsi14 = calcRSI(closes, 14);

  const results = [];
  
  // S1: Current v3 (EMA9/200, window 150-240s)
  results.push(test('S1: v3 Standard (150-240s)', klines, closes, (i) => {
    const fast = ema9[i], slow = ema200[i], price = closes[i];
    const slope = fast - ema9[i-1], slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 5 || slopeAbs < 2) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0 && rsi14[i] > 50) side = 'up';
    if (price < fast && fast < slow && slope < 0 && rsi14[i] < 50) side = 'down';
    if (!side) return null;
    if (side === 'up' && (dist < 8 || slopeAbs < 6)) return null;
    return { side, strength: dist, timing: 'standard' };
  }));
  
  // S2: Predictive — enter when EMA9 is APPROACHING EMA200 but hasn't crossed yet
  // If EMA9 gap to EMA200 is shrinking fast, anticipate the crossover
  results.push(test('S2: Predictive crossover anticipation', klines, closes, (i) => {
    if (i < 3) return null;
    const fast = ema9[i], slow = ema200[i], price = closes[i];
    const fastPrev1 = ema9[i-1], fastPrev2 = ema9[i-2];
    const gap = fast - slow;
    const gapPrev = fastPrev1 - ema200[i-1];
    const gapPrev2 = fastPrev2 - ema200[i-2];
    
    // Gap is shrinking consistently (approaching crossover)
    const gapShrinking = Math.abs(gap) < Math.abs(gapPrev) && Math.abs(gapPrev) < Math.abs(gapPrev2);
    if (!gapShrinking) return null;
    
    // Gap is small enough that crossover is imminent (within ~2 bps)
    const gapBps = Math.abs(gap / slow * 10000);
    if (gapBps > 3) return null;
    
    // Direction of approach tells us which way it'll cross
    const slope = fast - fastPrev1;
    let side = null;
    if (slope > 0 && gap < 0 && rsi14[i] > 45) side = 'up';   // EMA9 rising toward EMA200 from below
    if (slope < 0 && gap > 0 && rsi14[i] < 55) side = 'down';  // EMA9 falling toward EMA200 from above
    if (!side) return null;
    
    return { side, strength: gapBps, timing: 'early' };
  }));
  
  // S3: Momentum burst — strong single-candle move suggesting continuation
  results.push(test('S3: Momentum burst (strong candle body)', klines, closes, (i) => {
    const fast = ema9[i], slow = ema200[i];
    const body = closes[i] - klines[i].open;
    const bodyBps = Math.abs(body / klines[i].open * 10000);
    const range = highs[i] - lows[i];
    const bodyRatio = range > 0 ? Math.abs(body) / range : 0;
    
    // Strong candle: large body (>5 bps) that's mostly body not wick (>70%)
    if (bodyBps < 5 || bodyRatio < 0.7) return null;
    
    // Must be in rough EMA direction (don't need perfect alignment)
    const dist = ((fast - slow) / slow) * 10000;
    let side = null;
    if (body > 0 && dist > -3 && rsi14[i] > 45) side = 'up';    // strong green candle, EMA not too bearish
    if (body < 0 && dist < 3 && rsi14[i] < 55) side = 'down';   // strong red candle, EMA not too bullish
    if (!side) return null;
    
    return { side, strength: bodyBps, timing: 'early' };
  }));
  
  // S4: Rate of change acceleration — EMA9 slope accelerating (2nd derivative)
  results.push(test('S4: Slope acceleration (2nd derivative)', klines, closes, (i) => {
    if (i < 3) return null;
    const fast = ema9[i], slow = ema200[i];
    const slope1 = ema9[i] - ema9[i-1];
    const slope2 = ema9[i-1] - ema9[i-2];
    const slope3 = ema9[i-2] - ema9[i-3];
    
    // Acceleration: slope is increasing in magnitude
    const accel1 = Math.abs(slope1) - Math.abs(slope2);
    const accel2 = Math.abs(slope2) - Math.abs(slope3);
    if (accel1 <= 0 || accel2 <= 0) return null; // need consistent acceleration
    
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    const slopeAbs = Math.abs(slope1);
    if (slopeAbs < 1) return null;
    
    let side = null;
    if (slope1 > 0 && fast > slow && rsi14[i] > 45) side = 'up';
    if (slope1 < 0 && fast < slow && rsi14[i] < 55) side = 'down';
    if (!side) return null;
    
    // Acceleration signals are early — we're catching the move as it builds
    return { side, strength: dist, timing: dist < 5 ? 'early' : 'mid' };
  }));
  
  // S5: Combined — all early signals merged with standard v3
  results.push(test('S5: Combined (predictive + burst + accel + v3)', klines, closes, (i) => {
    if (i < 3) return null;
    const fast = ema9[i], slow = ema200[i], price = closes[i];
    const slope = fast - ema9[i-1];
    const slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    const rsi = rsi14[i];
    
    // --- Try predictive first (earliest) ---
    const gap = fast - slow;
    const gapPrev = ema9[i-1] - ema200[i-1];
    const gapPrev2 = ema9[i-2] - ema200[i-2];
    const gapShrinking = Math.abs(gap) < Math.abs(gapPrev) && Math.abs(gapPrev) < Math.abs(gapPrev2);
    const gapBps = Math.abs(gap / slow * 10000);
    
    if (gapShrinking && gapBps <= 3) {
      if (slope > 0 && gap < 0 && rsi > 45) return { side: 'up', strength: gapBps, timing: 'early' };
      if (slope < 0 && gap > 0 && rsi < 55) return { side: 'down', strength: gapBps, timing: 'early' };
    }
    
    // --- Try momentum burst ---
    const body = closes[i] - klines[i].open;
    const bodyBps = Math.abs(body / klines[i].open * 10000);
    const range = highs[i] - lows[i];
    const bodyRatio = range > 0 ? Math.abs(body) / range : 0;
    
    if (bodyBps >= 5 && bodyRatio >= 0.7) {
      const emaDist = ((fast - slow) / slow) * 10000;
      if (body > 0 && emaDist > -3 && rsi > 45) return { side: 'up', strength: bodyBps, timing: 'early' };
      if (body < 0 && emaDist < 3 && rsi < 55) return { side: 'down', strength: bodyBps, timing: 'early' };
    }
    
    // --- Try acceleration ---
    const slope2 = ema9[i-1] - ema9[i-2];
    const slope3 = ema9[i-2] - ema9[i-3];
    const accel1 = Math.abs(slope) - Math.abs(slope2);
    const accel2 = Math.abs(slope2) - Math.abs(slope3);
    if (accel1 > 0 && accel2 > 0 && slopeAbs >= 1) {
      if (slope > 0 && fast > slow && rsi > 45) return { side: 'up', strength: dist, timing: 'mid' };
      if (slope < 0 && fast < slow && rsi < 55) return { side: 'down', strength: dist, timing: 'mid' };
    }
    
    // --- Fall back to standard v3 ---
    if (dist >= 5 && slopeAbs >= 2) {
      let side = null;
      if (price > fast && fast > slow && slope > 0 && rsi > 50) {
        if (dist >= 8 && slopeAbs >= 6) side = 'up';
      }
      if (price < fast && fast < slow && slope < 0 && rsi < 50) side = 'down';
      if (side) return { side, strength: dist, timing: 'standard' };
    }
    
    return null;
  }));
  
  // S6: Extended window only (240-150s, no new signal types)
  results.push(test('S6: v3 Extended window (150-240s)', klines, closes, (i) => {
    const fast = ema9[i], slow = ema200[i], price = closes[i];
    const slope = fast - ema9[i-1], slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 5 || slopeAbs < 2) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0 && rsi14[i] > 50) side = 'up';
    if (price < fast && fast < slow && slope < 0 && rsi14[i] < 50) side = 'down';
    if (!side) return null;
    if (side === 'up' && (dist < 8 || slopeAbs < 6)) return null;
    return { side, strength: dist, timing: 'mid' };  // treat as mid-timing for pricing
  }));
  
  // Print results
  console.log('='.repeat(95));
  console.log('EARLY ENTRY OPTIMIZATION BACKTEST');
  console.log('='.repeat(95));
  
  results.sort((a, b) => b.ev - a.ev);
  
  for (const r of results) {
    const icon = r.ev > 0 ? '✅' : '❌';
    console.log(`\n${icon} ${r.name}`);
    console.log(`  Overall:  ${r.count} signals | WR ${r.wr}% | Entry ${r.avgEntry} | EV ${r.ev.toFixed(3)}`);
    console.log(`  Longs: ${r.upCount} (${r.upWR}%) | Shorts: ${r.dnCount} (${r.dnWR}%)`);
    console.log(`  Early (240-180s): ${r.early}`);
    console.log(`  Mid (180-150s):   ${r.mid}`);
    console.log(`  Standard (150-90s): ${r.standard}`);
  }
  
  console.log(`\n${'='.repeat(95)}`);
  console.log('INSIGHTS');
  console.log('='.repeat(95));
  console.log('Compare: which early entry methods add value vs just extending the window?');
  console.log('Key metric: does the cheaper entry price offset any reduction in WR?');
}

run().catch(e => { console.error(e); process.exit(1); });
