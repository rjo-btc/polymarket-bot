/**
 * Alternative Indicator Backtest
 * 
 * Tests:
 * 1. Loosened long filters (dist ≥5 instead of ≥8)
 * 2. VWAP as fast indicator instead of EMA20
 * 3. RSI-based signals
 * 4. EMA9 (faster) as fast MA
 * 5. Bollinger Band breakouts
 * 6. Price vs VWAP + EMA200 combo
 */

const { fetchKlines } = require('./src/btcPrice');

function calcEMA(data, period) {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

// Rolling VWAP (volume-weighted average price) — resets every N candles
function calcVWAP(klines, resetPeriod) {
  const vwap = [];
  let cumVol = 0, cumPV = 0;
  for (let i = 0; i < klines.length; i++) {
    if (i % resetPeriod === 0) { cumVol = 0; cumPV = 0; }
    const typical = (klines[i].high + klines[i].low + klines[i].close) / 3;
    const vol = klines[i].volume || 1;
    cumVol += vol;
    cumPV += typical * vol;
    vwap.push(cumPV / cumVol);
  }
  return vwap;
}

// RSI
function calcRSI(closes, period) {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return rsi;
  
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

// Bollinger Bands
function calcBB(closes, period, mult) {
  const upper = [], lower = [], mid = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { upper.push(null); lower.push(null); mid.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b) / period;
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    mid.push(mean);
    upper.push(mean + mult * std);
    lower.push(mean - mult * std);
  }
  return { upper, lower, mid };
}

function runStrategy(name, klines, closes, signalFn) {
  const results = { up: [], down: [], all: [] };
  const startIdx = 210;
  
  for (let i = startIdx; i < closes.length - 1; i++) {
    const signal = signalFn(i);
    if (!signal) continue;
    
    const { side, strength } = signal;
    
    // Momentum-based implied entry
    const lookback5 = closes[Math.max(0, i - 5)];
    const recentMoveBps = ((closes[i] - lookback5) / lookback5) * 10000;
    const absMove = Math.abs(recentMoveBps);
    const dirCorrect = (side === 'up' && recentMoveBps > 0) || (side === 'down' && recentMoveBps < 0);
    const momentumPremium = dirCorrect ? Math.min(0.15, absMove * 0.005) : -Math.min(0.10, absMove * 0.003);
    const impliedEntry = Math.min(0.65, Math.max(0.25, 0.50 + momentumPremium));
    
    // Resolution
    const nextClose = closes[i + 1];
    const resolution = nextClose > closes[i] ? 'up' : 'down';
    const won = resolution === side;
    
    const record = { side, won, impliedEntry, strength, absMove };
    results[side].push(record);
    results.all.push(record);
  }
  
  return results;
}

function printResults(name, results) {
  const all = results.all;
  if (all.length === 0) { console.log(`  ${name}: No signals\n`); return; }
  
  const wr = (all.filter(x => x.won).length / all.length * 100).toFixed(1);
  const avgEntry = (all.reduce((s, x) => s + x.impliedEntry, 0) / all.length).toFixed(3);
  const ev = (parseFloat(wr) / 100 - parseFloat(avgEntry)).toFixed(3);
  
  const upData = results.up;
  const downData = results.down;
  const upWR = upData.length > 0 ? (upData.filter(x => x.won).length / upData.length * 100).toFixed(1) : 'N/A';
  const downWR = downData.length > 0 ? (downData.filter(x => x.won).length / downData.length * 100).toFixed(1) : 'N/A';
  const upEntry = upData.length > 0 ? (upData.reduce((s, x) => s + x.impliedEntry, 0) / upData.length).toFixed(3) : 'N/A';
  const downEntry = downData.length > 0 ? (downData.reduce((s, x) => s + x.impliedEntry, 0) / downData.length).toFixed(3) : 'N/A';
  const upEV = upData.length > 0 ? (parseFloat(upWR)/100 - parseFloat(upEntry)).toFixed(3) : 'N/A';
  const downEV = downData.length > 0 ? (parseFloat(downWR)/100 - parseFloat(downEntry)).toFixed(3) : 'N/A';
  
  // Weak vs strong signal breakdown
  const weak = all.filter(x => x.strength < 8);
  const strong = all.filter(x => x.strength >= 8);
  const weakWR = weak.length > 0 ? (weak.filter(x => x.won).length / weak.length * 100).toFixed(1) : 'N/A';
  const strongWR = strong.length > 0 ? (strong.filter(x => x.won).length / strong.length * 100).toFixed(1) : 'N/A';
  const weakEntry = weak.length > 0 ? (weak.reduce((s, x) => s + x.impliedEntry, 0) / weak.length).toFixed(3) : 'N/A';
  const strongEntry = strong.length > 0 ? (strong.reduce((s, x) => s + x.impliedEntry, 0) / strong.length).toFixed(3) : 'N/A';
  const weakEV = weak.length > 0 ? (parseFloat(weakWR)/100 - parseFloat(weakEntry)).toFixed(3) : 'N/A';
  const strongEV = strong.length > 0 ? (parseFloat(strongWR)/100 - parseFloat(strongEntry)).toFixed(3) : 'N/A';
  
  const score = parseFloat(ev) * Math.sqrt(all.length);
  const evIcon = parseFloat(ev) > 0 ? '✅' : '❌';
  
  console.log(`  ${name}`);
  console.log(`    Overall:  ${all.length} signals | WR ${wr}% | Entry ${avgEntry} | ${evIcon} EV ${ev} | Score ${score.toFixed(2)}`);
  console.log(`    Longs:    ${upData.length} signals | WR ${upWR}% | Entry ${upEntry} | EV ${upEV}`);
  console.log(`    Shorts:   ${downData.length} signals | WR ${downWR}% | Entry ${downEntry} | EV ${downEV}`);
  console.log(`    Weak(<8): ${weak.length} signals | WR ${weakWR}% | Entry ${weakEntry} | EV ${weakEV}`);
  console.log(`    Strong(≥8): ${strong.length} signals | WR ${strongWR}% | Entry ${strongEntry} | EV ${strongEV}`);
  console.log('');
}

async function run() {
  console.log('Fetching klines...');
  const klines = await fetchKlines(1000);
  console.log(`Got ${klines.length} candles (~${(klines.length * 5 / 60).toFixed(0)} hours)\n`);
  
  const closes = klines.map(k => k.close);
  const ema9 = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const ema100 = calcEMA(closes, 100);
  const ema200 = calcEMA(closes, 200);
  const vwap12 = calcVWAP(klines, 12);  // Reset every hour (12 × 5min)
  const vwap60 = calcVWAP(klines, 60);  // Reset every 5 hours
  const rsi14 = calcRSI(closes, 14);
  const bb20 = calcBB(closes, 20, 2);
  
  console.log('='.repeat(90));
  console.log('STRATEGY COMPARISON — Momentum-Based Entry Pricing');
  console.log('Score = EV × √signals (balances edge quality with opportunity)');
  console.log('='.repeat(90));
  
  // --- 1. Current strategy (EMA20/200, strict long filters) ---
  console.log('\n--- GROUP A: CURRENT vs LOOSENED FILTERS ---\n');
  
  const currentStrict = runStrategy('EMA20/200 Strict', klines, closes, (i) => {
    const fast = ema20[i], slow = ema200[i], price = closes[i];
    const fastPrev = ema20[i-1], slope = fast - fastPrev, slopeAbs = Math.abs(slope);
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
    return { side, strength: dist };
  });
  printResults('A1. EMA20/200 — Current (long ≥8dist, ≥6slope)', currentStrict);
  
  // --- 2. Loosened longs (dist ≥5) ---
  const looseLong = runStrategy('EMA20/200 Loose Long', klines, closes, (i) => {
    const fast = ema20[i], slow = ema200[i], price = closes[i];
    const fastPrev = ema20[i-1], slope = fast - fastPrev, slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 5 || slopeAbs < 2) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0) side = 'up';
    if (price < fast && fast < slow && slope < 0) side = 'down';
    if (!side) return null;
    // Loosened: longs just need base filters (dist≥5, slope≥2)
    if (side === 'down') {
      if (dist >= 5 && dist < 8 && slopeAbs >= 3 && slopeAbs < 6) return null;
    }
    return { side, strength: dist };
  });
  printResults('A2. EMA20/200 — Loosened longs (≥5dist, ≥2slope)', looseLong);
  
  // --- 3. Loosened longs with slope ≥4 (middle ground) ---
  const midLong = runStrategy('EMA20/200 Mid Long', klines, closes, (i) => {
    const fast = ema20[i], slow = ema200[i], price = closes[i];
    const fastPrev = ema20[i-1], slope = fast - fastPrev, slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 5 || slopeAbs < 2) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0) side = 'up';
    if (price < fast && fast < slow && slope < 0) side = 'down';
    if (!side) return null;
    if (side === 'up' && (dist < 5 || slopeAbs < 4)) return null;
    if (side === 'down') {
      if (dist >= 5 && dist < 8 && slopeAbs >= 3 && slopeAbs < 6) return null;
    }
    return { side, strength: dist };
  });
  printResults('A3. EMA20/200 — Mid longs (≥5dist, ≥4slope)', midLong);

  // --- GROUP B: ALTERNATIVE FAST INDICATORS ---
  console.log('\n--- GROUP B: ALTERNATIVE FAST INDICATORS (all paired with EMA200) ---\n');
  
  // --- 4. EMA9/200 ---
  const ema9strat = runStrategy('EMA9/200', klines, closes, (i) => {
    const fast = ema9[i], slow = ema200[i], price = closes[i];
    const fastPrev = ema9[i-1], slope = fast - fastPrev, slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 5 || slopeAbs < 2) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0) side = 'up';
    if (price < fast && fast < slow && slope < 0) side = 'down';
    if (!side) return null;
    return { side, strength: dist };
  });
  printResults('B1. EMA9/200 — Faster reactions', ema9strat);
  
  // --- 5. VWAP(1hr)/EMA200 ---
  const vwapStrat = runStrategy('VWAP/200', klines, closes, (i) => {
    const fast = vwap12[i], slow = ema200[i], price = closes[i];
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    // VWAP slope: change over last 3 candles
    const fastPrev = vwap12[Math.max(0, i-3)];
    const slope = fast - fastPrev;
    const slopeAbs = Math.abs(slope);
    if (dist < 5 || slopeAbs < 2) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0) side = 'up';
    if (price < fast && fast < slow && slope < 0) side = 'down';
    if (!side) return null;
    return { side, strength: dist };
  });
  printResults('B2. VWAP(1hr reset)/EMA200 — Volume-weighted', vwapStrat);
  
  // --- 6. VWAP(5hr)/EMA200 ---
  const vwap5hStrat = runStrategy('VWAP5h/200', klines, closes, (i) => {
    const fast = vwap60[i], slow = ema200[i], price = closes[i];
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    const fastPrev = vwap60[Math.max(0, i-3)];
    const slope = fast - fastPrev;
    const slopeAbs = Math.abs(slope);
    if (dist < 5 || slopeAbs < 2) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0) side = 'up';
    if (price < fast && fast < slow && slope < 0) side = 'down';
    if (!side) return null;
    return { side, strength: dist };
  });
  printResults('B3. VWAP(5hr reset)/EMA200 — Longer volume anchor', vwap5hStrat);

  // --- 7. Price vs VWAP only (no EMA) ---
  const vwapOnly = runStrategy('VWAP-only', klines, closes, (i) => {
    const vwap = vwap12[i], price = closes[i];
    const dist = Math.abs(((price - vwap) / vwap) * 10000);
    const prevVwap = vwap12[Math.max(0, i-1)];
    const slope = vwap - prevVwap;
    const slopeAbs = Math.abs(slope);
    if (dist < 3 || slopeAbs < 1) return null;
    let side = null;
    if (price > vwap && slope > 0) side = 'up';
    if (price < vwap && slope < 0) side = 'down';
    if (!side) return null;
    return { side, strength: dist };
  });
  printResults('B4. Price vs VWAP(1hr) only — Pure volume signal', vwapOnly);

  // --- GROUP C: COMBO / CONFLUENCE ---
  console.log('\n--- GROUP C: CONFLUENCE STRATEGIES ---\n');
  
  // --- 8. EMA20/200 + RSI confirmation ---
  const emaRSI = runStrategy('EMA20/200+RSI', klines, closes, (i) => {
    const fast = ema20[i], slow = ema200[i], price = closes[i];
    const fastPrev = ema20[i-1], slope = fast - fastPrev, slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 5 || slopeAbs < 2) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0) side = 'up';
    if (price < fast && fast < slow && slope < 0) side = 'down';
    if (!side) return null;
    // RSI confirmation: longs need RSI > 50 (momentum), shorts need RSI < 50
    const rsi = rsi14[i];
    if (side === 'up' && rsi < 50) return null;
    if (side === 'down' && rsi > 50) return null;
    return { side, strength: dist };
  });
  printResults('C1. EMA20/200 + RSI14 confirmation (>50 long, <50 short)', emaRSI);
  
  // --- 9. EMA20/200 + RSI extremes (contrarian filter) ---
  const emaRSIext = runStrategy('EMA20/200+RSI-ext', klines, closes, (i) => {
    const fast = ema20[i], slow = ema200[i], price = closes[i];
    const fastPrev = ema20[i-1], slope = fast - fastPrev, slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 5 || slopeAbs < 2) return null;
    let side = null;
    if (price > fast && fast > slow && slope > 0) side = 'up';
    if (price < fast && fast < slow && slope < 0) side = 'down';
    if (!side) return null;
    // Block RSI extremes (overextended — likely to reverse)
    const rsi = rsi14[i];
    if (side === 'up' && rsi > 70) return null;   // overbought
    if (side === 'down' && rsi < 30) return null;  // oversold
    return { side, strength: dist };
  });
  printResults('C2. EMA20/200 + RSI filter (block overbought/oversold)', emaRSIext);
  
  // --- 10. VWAP + EMA20/200 triple confluence ---
  const tripleConf = runStrategy('Triple', klines, closes, (i) => {
    const fast = ema20[i], slow = ema200[i], vwap = vwap12[i], price = closes[i];
    const fastPrev = ema20[i-1], slope = fast - fastPrev, slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    if (dist < 5 || slopeAbs < 2) return null;
    let side = null;
    // Triple alignment: price vs EMA20 vs EMA200 vs VWAP all agree
    if (price > fast && fast > slow && price > vwap && slope > 0) side = 'up';
    if (price < fast && fast < slow && price < vwap && slope < 0) side = 'down';
    if (!side) return null;
    return { side, strength: dist };
  });
  printResults('C3. Triple: EMA20/200 + VWAP(1hr) alignment', tripleConf);
  
  // --- 11. Bollinger Band breakout + EMA200 trend ---
  const bbStrat = runStrategy('BB+EMA200', klines, closes, (i) => {
    if (!bb20.upper[i]) return null;
    const slow = ema200[i], price = closes[i];
    let side = null;
    // Price breaks above upper BB + above EMA200 = strong uptrend
    if (price > bb20.upper[i] && price > slow) side = 'up';
    // Price breaks below lower BB + below EMA200 = strong downtrend
    if (price < bb20.lower[i] && price < slow) side = 'down';
    if (!side) return null;
    const dist = Math.abs(((price - slow) / slow) * 10000);
    return { side, strength: dist };
  });
  printResults('C4. Bollinger(20,2) breakout + EMA200 trend', bbStrat);

  // --- FINAL RANKING ---
  console.log('\n' + '='.repeat(90));
  console.log('FINAL RANKING BY EV (positive = profitable)');
  console.log('='.repeat(90));
  
  const allStrats = [
    { name: 'A1. Current (strict)', ...summarize(currentStrict) },
    { name: 'A2. Loosened longs', ...summarize(looseLong) },
    { name: 'A3. Mid longs (≥5d,≥4s)', ...summarize(midLong) },
    { name: 'B1. EMA9/200', ...summarize(ema9strat) },
    { name: 'B2. VWAP(1hr)/200', ...summarize(vwapStrat) },
    { name: 'B3. VWAP(5hr)/200', ...summarize(vwap5hStrat) },
    { name: 'B4. VWAP only', ...summarize(vwapOnly) },
    { name: 'C1. EMA+RSI confirm', ...summarize(emaRSI) },
    { name: 'C2. EMA+RSI extremes', ...summarize(emaRSIext) },
    { name: 'C3. Triple confluence', ...summarize(tripleConf) },
    { name: 'C4. BB+EMA200', ...summarize(bbStrat) },
  ];
  
  allStrats.sort((a, b) => b.ev - a.ev);
  
  console.log('Rank | Strategy'.padEnd(40) + '| Signals | WR%    | Entry  | EV      | Score');
  console.log('-'.repeat(90));
  allStrats.forEach((s, i) => {
    const icon = s.ev > 0 ? '✅' : '❌';
    console.log(
      `${String(i+1).padStart(4)} | ${s.name.padEnd(33)}| ${String(s.count).padEnd(8)}| ${s.wr.padEnd(7)}| ${s.entry.padEnd(7)}| ${icon} ${s.ev.toFixed(3).padEnd(6)}| ${s.score.toFixed(2)}`
    );
  });
}

function summarize(results) {
  const all = results.all;
  if (all.length === 0) return { count: 0, wr: 'N/A', entry: 'N/A', ev: -999, score: -999 };
  const wr = (all.filter(x => x.won).length / all.length * 100).toFixed(1);
  const entry = (all.reduce((s, x) => s + x.impliedEntry, 0) / all.length).toFixed(3);
  const ev = parseFloat(wr) / 100 - parseFloat(entry);
  return { count: all.length, wr, entry, ev, score: ev * Math.sqrt(all.length) };
}

run().catch(e => { console.error(e); process.exit(1); });
