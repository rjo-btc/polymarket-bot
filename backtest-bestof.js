/**
 * "Best Of" Combined Strategy Backtest
 * 
 * Combines the winning elements:
 * - EMA9 as fast MA (faster reactions, best overall WR)
 * - EMA200 as slow MA (trend anchor)
 * - RSI14 confirmation (filters garbage)
 * - BB(20,2) breakout boost (high WR on shorts)
 * - Weak signal preference (5-8 bps = highest EV)
 * - Short bias (shorts outperform everywhere)
 * 
 * Tests multiple variants of the combined strategy.
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

function calcBB(closes, period, mult) {
  const upper = [], lower = [], mid = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { upper.push(null); lower.push(null); mid.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b) / period;
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    mid.push(mean); upper.push(mean + mult * std); lower.push(mean - mult * std);
  }
  return { upper, lower, mid };
}

function calcVWAP(klines, resetPeriod) {
  const vwap = [];
  let cumVol = 0, cumPV = 0;
  for (let i = 0; i < klines.length; i++) {
    if (i % resetPeriod === 0) { cumVol = 0; cumPV = 0; }
    const typical = (klines[i].high + klines[i].low + klines[i].close) / 3;
    const vol = klines[i].volume || 1;
    cumVol += vol; cumPV += typical * vol;
    vwap.push(cumPV / cumVol);
  }
  return vwap;
}

function impliedEntry(closes, i, side) {
  const lookback5 = closes[Math.max(0, i - 5)];
  const recentMoveBps = ((closes[i] - lookback5) / lookback5) * 10000;
  const absMove = Math.abs(recentMoveBps);
  const dirCorrect = (side === 'up' && recentMoveBps > 0) || (side === 'down' && recentMoveBps < 0);
  const premium = dirCorrect ? Math.min(0.15, absMove * 0.005) : -Math.min(0.10, absMove * 0.003);
  return Math.min(0.65, Math.max(0.25, 0.50 + premium));
}

function testStrategy(name, klines, closes, signalFn) {
  const all = [], up = [], down = [];
  for (let i = 210; i < closes.length - 1; i++) {
    const sig = signalFn(i);
    if (!sig) continue;
    const entry = impliedEntry(closes, i, sig.side);
    const nextClose = closes[i + 1];
    const won = (sig.side === 'up' && nextClose > closes[i]) || (sig.side === 'down' && nextClose < closes[i]);
    const rec = { ...sig, won, entry };
    all.push(rec);
    if (sig.side === 'up') up.push(rec); else down.push(rec);
  }
  
  const wr = all.length ? (all.filter(x => x.won).length / all.length * 100) : 0;
  const avgEntry = all.length ? all.reduce((s, x) => s + x.entry, 0) / all.length : 0;
  const ev = wr / 100 - avgEntry;
  const score = ev * Math.sqrt(all.length);
  const upWR = up.length ? (up.filter(x => x.won).length / up.length * 100) : 0;
  const downWR = down.length ? (down.filter(x => x.won).length / down.length * 100) : 0;
  const upEntry = up.length ? up.reduce((s, x) => s + x.entry, 0) / up.length : 0;
  const downEntry = down.length ? down.reduce((s, x) => s + x.entry, 0) / down.length : 0;
  
  // Confidence tiers
  const t1 = all.filter(x => x.confidence >= 70);
  const t2 = all.filter(x => x.confidence >= 40 && x.confidence < 70);
  const t3 = all.filter(x => x.confidence < 40);
  
  const tierStats = (arr) => {
    if (!arr.length) return 'N/A';
    const w = (arr.filter(x => x.won).length / arr.length * 100).toFixed(1);
    const e = (arr.reduce((s, x) => s + x.entry, 0) / arr.length).toFixed(3);
    const ev = (parseFloat(w)/100 - parseFloat(e)).toFixed(3);
    return `${arr.length} sig, ${w}% WR, ${e} entry, EV ${ev}`;
  };
  
  return { name, count: all.length, wr: wr.toFixed(1), avgEntry: avgEntry.toFixed(3), ev, score,
    upCount: up.length, upWR: upWR.toFixed(1), upEV: (upWR/100 - upEntry).toFixed(3),
    downCount: down.length, downWR: downWR.toFixed(1), downEV: (downWR/100 - downEntry).toFixed(3),
    t1: tierStats(t1), t2: tierStats(t2), t3: tierStats(t3) };
}

async function run() {
  console.log('Fetching klines...');
  const klines = await fetchKlines(1000);
  console.log(`Got ${klines.length} candles (~${(klines.length * 5 / 60).toFixed(0)} hours)\n`);
  
  const closes = klines.map(k => k.close);
  const ema9 = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema200 = calcEMA(closes, 200);
  const rsi14 = calcRSI(closes, 14);
  const bb20 = calcBB(closes, 20, 2);
  const vwap12 = calcVWAP(klines, 12);
  
  const results = [];
  
  // V1: EMA9/200 + RSI confirmation (best single combo from prior test)
  results.push(testStrategy('V1: EMA9/200 + RSI confirm', klines, closes, (i) => {
    const fast = ema9[i], slow = ema200[i], price = closes[i];
    const slope = fast - ema9[i-1], slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 3 || slopeAbs < 1) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0) side = 'up';
    if (price < fast && fast < slow && slope < 0) side = 'down';
    if (!side) return null;
    const rsi = rsi14[i];
    if (side === 'up' && rsi < 50) return null;
    if (side === 'down' && rsi > 50) return null;
    const confidence = Math.min(100, dist * 3 + (side === 'down' ? 15 : 0) + (rsi > 60 || rsi < 40 ? 10 : 0));
    return { side, strength: dist, confidence };
  }));
  
  // V2: EMA9/200 + RSI + BB boost
  results.push(testStrategy('V2: EMA9/200 + RSI + BB', klines, closes, (i) => {
    const fast = ema9[i], slow = ema200[i], price = closes[i];
    const slope = fast - ema9[i-1], slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 3 || slopeAbs < 1) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0) side = 'up';
    if (price < fast && fast < slow && slope < 0) side = 'down';
    if (!side) return null;
    const rsi = rsi14[i];
    if (side === 'up' && rsi < 50) return null;
    if (side === 'down' && rsi > 50) return null;
    // BB confirmation: price near or beyond band in signal direction = extra conviction
    const bbConf = bb20.upper[i] && ((side === 'up' && price >= bb20.upper[i]) || (side === 'down' && price <= bb20.lower[i]));
    const confidence = Math.min(100, dist * 3 + (side === 'down' ? 15 : 0) + (bbConf ? 20 : 0) + (rsi > 60 || rsi < 40 ? 10 : 0));
    return { side, strength: dist, confidence };
  }));
  
  // V3: EMA9/200 + RSI + short bias (reduce long sizing via confidence)
  results.push(testStrategy('V3: EMA9/200 + RSI + short bias', klines, closes, (i) => {
    const fast = ema9[i], slow = ema200[i], price = closes[i];
    const slope = fast - ema9[i-1], slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 3 || slopeAbs < 1) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0) side = 'up';
    if (price < fast && fast < slow && slope < 0) side = 'down';
    if (!side) return null;
    const rsi = rsi14[i];
    if (side === 'up' && rsi < 55) return null;  // stricter RSI for longs
    if (side === 'down' && rsi > 50) return null;
    // Longs get penalized confidence, shorts get boosted
    const confidence = Math.min(100, dist * 3 + (side === 'down' ? 25 : -10) + (rsi > 65 || rsi < 35 ? 15 : 0));
    return { side, strength: dist, confidence };
  }));
  
  // V4: Full combined — EMA9/200 + RSI + BB + VWAP triple confirm
  results.push(testStrategy('V4: Kitchen sink (EMA9+RSI+BB+VWAP)', klines, closes, (i) => {
    const fast = ema9[i], slow = ema200[i], price = closes[i];
    const slope = fast - ema9[i-1], slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 3 || slopeAbs < 1) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0) side = 'up';
    if (price < fast && fast < slow && slope < 0) side = 'down';
    if (!side) return null;
    const rsi = rsi14[i];
    if (side === 'up' && rsi < 50) return null;
    if (side === 'down' && rsi > 50) return null;
    // VWAP confirmation
    const vwap = vwap12[i];
    const vwapAligned = (side === 'up' && price > vwap) || (side === 'down' && price < vwap);
    if (!vwapAligned) return null;
    const bbConf = bb20.upper[i] && ((side === 'up' && price >= bb20.upper[i]) || (side === 'down' && price <= bb20.lower[i]));
    const confidence = Math.min(100, dist * 3 + (side === 'down' ? 15 : 0) + (bbConf ? 20 : 0) + 10);
    return { side, strength: dist, confidence };
  }));
  
  // V5: EMA9/200 minimal filters (dist≥3, slope≥1) — max opportunity
  results.push(testStrategy('V5: EMA9/200 minimal (d≥3, s≥1)', klines, closes, (i) => {
    const fast = ema9[i], slow = ema200[i], price = closes[i];
    const slope = fast - ema9[i-1], slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 3 || slopeAbs < 1) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0) side = 'up';
    if (price < fast && fast < slow && slope < 0) side = 'down';
    if (!side) return null;
    const confidence = Math.min(100, dist * 3 + (side === 'down' ? 15 : 0));
    return { side, strength: dist, confidence };
  }));
  
  // V6: EMA9/200 with current-style filters (dist≥5, slope≥2)
  results.push(testStrategy('V6: EMA9/200 standard (d≥5, s≥2)', klines, closes, (i) => {
    const fast = ema9[i], slow = ema200[i], price = closes[i];
    const slope = fast - ema9[i-1], slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 5 || slopeAbs < 2) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0) side = 'up';
    if (price < fast && fast < slow && slope < 0) side = 'down';
    if (!side) return null;
    const confidence = Math.min(100, dist * 3 + (side === 'down' ? 15 : 0));
    return { side, strength: dist, confidence };
  }));
  
  // V7: Shorts-only EMA9/200 + RSI (since longs are negative EV everywhere)
  results.push(testStrategy('V7: SHORTS ONLY — EMA9/200 + RSI', klines, closes, (i) => {
    const fast = ema9[i], slow = ema200[i], price = closes[i];
    const slope = fast - ema9[i-1], slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 3 || slopeAbs < 1) return null;
    if (!(price < fast && fast < slow && slope < 0)) return null;
    const rsi = rsi14[i];
    if (rsi > 50) return null;
    const confidence = Math.min(100, dist * 3 + 20 + (rsi < 35 ? 15 : 0));
    return { side: 'down', strength: dist, confidence };
  }));
  
  // V8: Current EMA20/200 baseline for comparison
  results.push(testStrategy('V8: BASELINE — Current EMA20/200', klines, closes, (i) => {
    const fast = ema20[i], slow = ema200[i], price = closes[i];
    const slope = fast - ema20[i-1], slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 5 || slopeAbs < 2) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0) side = 'up';
    if (price < fast && fast < slow && slope < 0) side = 'down';
    if (!side) return null;
    if (side === 'up' && (dist < 8 || slopeAbs < 6)) return null;
    if (side === 'down') {
      if (dist >= 5 && dist < 8 && slopeAbs >= 3 && slopeAbs < 6) return null;
    }
    const confidence = Math.min(100, dist * 3 + (side === 'down' ? 15 : 0));
    return { side, strength: dist, confidence };
  }));
  
  // Print
  console.log('='.repeat(95));
  console.log('COMBINED "BEST OF" STRATEGY BACKTEST');
  console.log(`${klines.length} candles (~${(klines.length * 5 / 60).toFixed(0)}h) · Momentum-based entry pricing`);
  console.log('='.repeat(95));
  
  results.sort((a, b) => b.ev - a.ev);
  
  for (const r of results) {
    const icon = r.ev > 0 ? '✅' : '❌';
    console.log(`\n${icon} ${r.name}`);
    console.log(`  Overall:  ${r.count} signals | WR ${r.wr}% | Avg Entry ${r.avgEntry} | EV ${r.ev.toFixed(3)} | Score ${r.score.toFixed(2)}`);
    console.log(`  Longs:    ${r.upCount} (WR ${r.upWR}%, EV ${r.upEV}) | Shorts: ${r.downCount} (WR ${r.downWR}%, EV ${r.downEV})`);
    console.log(`  Tier 1 (≥70): ${r.t1}`);
    console.log(`  Tier 2 (40-69): ${r.t2}`);
    console.log(`  Tier 3 (<40): ${r.t3}`);
  }
  
  console.log(`\n${'='.repeat(95)}`);
  console.log('RECOMMENDATION');
  console.log('='.repeat(95));
  const best = results[0];
  console.log(`\nBest strategy: ${best.name}`);
  console.log(`EV: ${best.ev.toFixed(3)} | ${best.count} signals | WR ${best.wr}% | Score ${best.score.toFixed(2)}`);
  console.log(`\nKey changes from current baseline:`);
  const baseline = results.find(r => r.name.includes('BASELINE'));
  if (baseline) {
    console.log(`  EV improvement: ${best.ev.toFixed(3)} vs ${baseline.ev.toFixed(3)} (${best.ev > baseline.ev ? '+' : ''}${((best.ev - baseline.ev) * 100).toFixed(1)}%)`);
    console.log(`  WR improvement: ${best.wr}% vs ${baseline.wr}%`);
    console.log(`  Signal count: ${best.count} vs ${baseline.count}`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
