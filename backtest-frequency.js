/**
 * Trade Frequency Analysis — how often should the bot execute under v3.1?
 * Simulates the full signal pipeline including both early and standard windows.
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

async function run() {
  console.log('Fetching klines...');
  const klines = await fetchKlines(1000);
  console.log(`Got ${klines.length} candles (~${(klines.length * 5 / 60).toFixed(0)} hours)\n`);
  
  const closes = klines.map(k => k.close);
  const ema9 = calcEMA(closes, 9);
  const ema200 = calcEMA(closes, 200);
  const rsi14 = calcRSI(closes, 14);
  
  const totalCandles = klines.length - 210;
  const totalHours = totalCandles * 5 / 60;
  const totalMarkets = totalCandles; // each candle ≈ one 5-min market
  
  let earlyBurst = 0, earlyAccel = 0, standardLong = 0, standardShort = 0;
  let totalSignals = 0;
  const hourlyBuckets = {};
  const signalTypes = [];
  
  // Track gaps between trades
  let lastTradeCandle = null;
  const gaps = [];
  
  for (let i = 210; i < closes.length; i++) {
    const price = closes[i];
    const fast = ema9[i], slow = ema200[i];
    const slope = fast - ema9[i-1];
    const slopeAbs = Math.abs(slope);
    const dist = Math.abs(((fast - slow) / slow) * 10000);
    const rsi = rsi14[i];
    const fastPrev2 = i > 2 ? ema9[i-2] : ema9[i-1];
    const slopePrev = ema9[i-1] - fastPrev2;
    
    let signalType = null;
    let side = null;
    
    // --- Early signals ---
    // Momentum burst
    const body = closes[i] - klines[i].open;
    const bodyBps = Math.abs(body / klines[i].open * 10000);
    const range = klines[i].high - klines[i].low;
    const bodyRatio = range > 0 ? Math.abs(body) / range : 0;
    const emaDist = ((fast - slow) / slow) * 10000;
    
    if (bodyBps >= 5 && bodyRatio >= 0.7) {
      if (body > 0 && emaDist > -3 && rsi > 45) { signalType = 'burst'; side = 'up'; earlyBurst++; }
      else if (body < 0 && emaDist < 3 && rsi < 55) { signalType = 'burst'; side = 'down'; earlyBurst++; }
    }
    
    // Slope acceleration (only if no burst)
    if (!signalType) {
      const accel = Math.abs(slope) - Math.abs(slopePrev);
      if (accel > 0 && slopeAbs >= 1) {
        if (slope > 0 && fast > slow && rsi > 45) { signalType = 'accel'; side = 'up'; earlyAccel++; }
        else if (slope < 0 && fast < slow && rsi < 55) { signalType = 'accel'; side = 'down'; earlyAccel++; }
      }
    }
    
    // --- Standard signals (only if no early) ---
    if (!signalType && dist >= 5 && slopeAbs >= 2) {
      // Long
      if (price > fast && fast > slow && slope > 0 && rsi > 50) {
        if (dist >= 8 && slopeAbs >= 6) { signalType = 'standard'; side = 'up'; standardLong++; }
      }
      // Short (with death zone filter)
      if (price < fast && fast < slow && slope < 0 && rsi < 50) {
        const inDistDead = dist >= 5 && dist < 8;
        const inSlopeDead = slopeAbs >= 3 && slopeAbs < 6;
        if (!(inDistDead && inSlopeDead)) { signalType = 'standard'; side = 'down'; standardShort++; }
      }
    }
    
    if (signalType) {
      totalSignals++;
      signalTypes.push({ candle: i, type: signalType, side });
      
      // Track gap
      if (lastTradeCandle !== null) {
        gaps.push(i - lastTradeCandle);
      }
      lastTradeCandle = i;
      
      // Hourly bucket
      const hour = Math.floor((i - 210) * 5 / 60);
      hourlyBuckets[hour] = (hourlyBuckets[hour] || 0) + 1;
    }
  }
  
  // Compute stats
  const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b) / gaps.length : 0;
  const medianGap = gaps.length > 0 ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
  const maxGap = gaps.length > 0 ? Math.max(...gaps) : 0;
  const minGap = gaps.length > 0 ? Math.min(...gaps) : 0;
  
  const hourlyValues = Object.values(hourlyBuckets);
  const avgPerHour = totalSignals / totalHours;
  const maxPerHour = hourlyValues.length > 0 ? Math.max(...hourlyValues) : 0;
  const hoursWithZero = Math.floor(totalHours) - hourlyValues.length;
  
  // Streaks of no trades
  let currentStreak = 0, maxStreak = 0, streaks = [];
  for (let i = 210; i < closes.length; i++) {
    const hasSignal = signalTypes.some(s => s.candle === i);
    if (!hasSignal) {
      currentStreak++;
    } else {
      if (currentStreak > 0) streaks.push(currentStreak);
      if (currentStreak > maxStreak) maxStreak = currentStreak;
      currentStreak = 0;
    }
  }
  if (currentStreak > 0) { streaks.push(currentStreak); if (currentStreak > maxStreak) maxStreak = currentStreak; }
  
  console.log('='.repeat(80));
  console.log('TRADE FREQUENCY ANALYSIS — v3.1 (EMA9/200 + RSI + Early Signals)');
  console.log(`Data: ${klines.length} candles (~${totalHours.toFixed(0)} hours)`);
  console.log('='.repeat(80));
  
  console.log(`\n📊 OVERALL FREQUENCY`);
  console.log(`  Total signals: ${totalSignals} in ${totalHours.toFixed(0)} hours`);
  console.log(`  Average: ${avgPerHour.toFixed(2)} trades/hour (1 every ${(60/avgPerHour).toFixed(0)} min)`);
  console.log(`  Per 24h: ~${(avgPerHour * 24).toFixed(0)} trades`);
  console.log(`  Per market (5 min): ${(totalSignals / totalMarkets * 100).toFixed(1)}% of markets traded`);
  
  console.log(`\n📈 BY SIGNAL TYPE`);
  console.log(`  Momentum Burst (early): ${earlyBurst} (${(earlyBurst/totalSignals*100).toFixed(1)}%)`);
  console.log(`  Slope Acceleration (early): ${earlyAccel} (${(earlyAccel/totalSignals*100).toFixed(1)}%)`);
  console.log(`  Standard Long: ${standardLong} (${(standardLong/totalSignals*100).toFixed(1)}%)`);
  console.log(`  Standard Short: ${standardShort} (${(standardShort/totalSignals*100).toFixed(1)}%)`);
  console.log(`  Early signals total: ${earlyBurst + earlyAccel} (${((earlyBurst+earlyAccel)/totalSignals*100).toFixed(1)}%)`);
  
  console.log(`\n⏱️  GAP ANALYSIS (candles between trades)`);
  console.log(`  Average gap: ${avgGap.toFixed(1)} candles (${(avgGap * 5).toFixed(0)} min)`);
  console.log(`  Median gap: ${medianGap} candles (${medianGap * 5} min)`);
  console.log(`  Shortest gap: ${minGap} candles (${minGap * 5} min) — back-to-back`);
  console.log(`  Longest gap: ${maxGap} candles (${maxGap * 5} min = ${(maxGap * 5 / 60).toFixed(1)} hours)`);
  console.log(`  Longest dry streak: ${maxStreak} candles (${(maxStreak * 5 / 60).toFixed(1)} hours)`);
  
  console.log(`\n📅 HOURLY DISTRIBUTION`);
  console.log(`  Hours with trades: ${hourlyValues.length}/${Math.floor(totalHours)} (${(hourlyValues.length/Math.floor(totalHours)*100).toFixed(0)}%)`);
  console.log(`  Hours with 0 trades: ${hoursWithZero}`);
  console.log(`  Max trades in 1 hour: ${maxPerHour}`);
  console.log(`  Busiest hours:`);
  const sortedHours = Object.entries(hourlyBuckets).sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [h, count] of sortedHours) {
    console.log(`    Hour ${h}: ${count} trades`);
  }
  
  console.log(`\n🔮 EXPECTED FREQUENCY`);
  console.log(`  Active trading day (16h): ~${(avgPerHour * 16).toFixed(0)} trades`);
  console.log(`  Quiet day (low vol): ~${Math.floor(avgPerHour * 16 * 0.4)} trades`);
  console.log(`  Hot day (high vol): ~${Math.ceil(avgPerHour * 16 * 1.8)} trades`);
  console.log(`  24/7 weekly: ~${(avgPerHour * 24 * 7).toFixed(0)} trades`);
  console.log(`  Days to 50 trades (Kelly): ~${(50 / (avgPerHour * 24)).toFixed(1)} days`);
  
  // Side distribution
  const upSignals = signalTypes.filter(s => s.side === 'up').length;
  const downSignals = signalTypes.filter(s => s.side === 'down').length;
  console.log(`\n📊 SIDE DISTRIBUTION`);
  console.log(`  Longs: ${upSignals} (${(upSignals/totalSignals*100).toFixed(1)}%)`);
  console.log(`  Shorts: ${downSignals} (${(downSignals/totalSignals*100).toFixed(1)}%)`);
}

run().catch(e => { console.error(e); process.exit(1); });
