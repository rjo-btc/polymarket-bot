/**
 * Slope Acceleration Filter Tuning
 * 
 * Tests different throttle levels for the slope acceleration signal:
 * - Min acceleration threshold (how much slope must increase per candle)
 * - Min absolute slope requirement
 * - RSI confirmation strictness
 * - Require 2 consecutive accelerating candles vs just 1
 * - Require EMA alignment (fast > slow) vs just direction
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

function impliedEntry(closes, i, side) {
  const lookback5 = closes[Math.max(0, i - 5)];
  const recentMoveBps = ((closes[i] - lookback5) / lookback5) * 10000;
  const absMove = Math.abs(recentMoveBps);
  const dirCorrect = (side === 'up' && recentMoveBps > 0) || (side === 'down' && recentMoveBps < 0);
  const premium = dirCorrect ? Math.min(0.15, absMove * 0.005) : -Math.min(0.10, absMove * 0.003);
  return Math.min(0.65, Math.max(0.20, 0.50 + premium - 0.06)); // early timing discount
}

async function run() {
  console.log('Fetching klines...');
  const klines = await fetchKlines(1000);
  console.log(`Got ${klines.length} candles (~${(klines.length * 5 / 60).toFixed(0)} hours)\n`);
  
  const closes = klines.map(k => k.close);
  const ema9 = calcEMA(closes, 9);
  const ema200 = calcEMA(closes, 200);
  const rsi14 = calcRSI(closes, 14);
  
  const totalHours = (klines.length - 212) * 5 / 60;
  
  // Pre-compute slopes and accelerations
  const slopes = [];
  const accels = [];
  for (let i = 0; i < closes.length; i++) {
    slopes[i] = i > 0 ? ema9[i] - ema9[i - 1] : 0;
    accels[i] = i > 1 ? Math.abs(slopes[i]) - Math.abs(slopes[i - 1]) : 0;
  }
  
  const configs = [
    // Current: accel > 0, slopeAbs >= 1, RSI 45/55, 1 candle
    { name: 'CURRENT (accel>0, slope≥1, RSI 45/55)', minAccel: 0.001, minSlope: 1, rsiLong: 45, rsiShort: 55, consecCandles: 1, requireAlign: true },
    
    // Throttle acceleration threshold
    { name: 'Accel ≥ 0.5', minAccel: 0.5, minSlope: 1, rsiLong: 45, rsiShort: 55, consecCandles: 1, requireAlign: true },
    { name: 'Accel ≥ 1.0', minAccel: 1.0, minSlope: 1, rsiLong: 45, rsiShort: 55, consecCandles: 1, requireAlign: true },
    { name: 'Accel ≥ 2.0', minAccel: 2.0, minSlope: 1, rsiLong: 45, rsiShort: 55, consecCandles: 1, requireAlign: true },
    { name: 'Accel ≥ 3.0', minAccel: 3.0, minSlope: 1, rsiLong: 45, rsiShort: 55, consecCandles: 1, requireAlign: true },
    { name: 'Accel ≥ 5.0', minAccel: 5.0, minSlope: 1, rsiLong: 45, rsiShort: 55, consecCandles: 1, requireAlign: true },
    
    // Throttle min slope
    { name: 'Slope ≥ 2.0', minAccel: 0.001, minSlope: 2, rsiLong: 45, rsiShort: 55, consecCandles: 1, requireAlign: true },
    { name: 'Slope ≥ 3.0', minAccel: 0.001, minSlope: 3, rsiLong: 45, rsiShort: 55, consecCandles: 1, requireAlign: true },
    { name: 'Slope ≥ 5.0', minAccel: 0.001, minSlope: 5, rsiLong: 45, rsiShort: 55, consecCandles: 1, requireAlign: true },
    
    // Tighter RSI
    { name: 'RSI 48/52 (tight)', minAccel: 0.001, minSlope: 1, rsiLong: 48, rsiShort: 52, consecCandles: 1, requireAlign: true },
    { name: 'RSI 50/50 (strict)', minAccel: 0.001, minSlope: 1, rsiLong: 50, rsiShort: 50, consecCandles: 1, requireAlign: true },
    
    // Require 2 consecutive accelerating candles
    { name: '2 consec accel candles', minAccel: 0.001, minSlope: 1, rsiLong: 45, rsiShort: 55, consecCandles: 2, requireAlign: true },
    { name: '3 consec accel candles', minAccel: 0.001, minSlope: 1, rsiLong: 45, rsiShort: 55, consecCandles: 3, requireAlign: true },
    
    // No EMA alignment required (just slope direction)
    { name: 'No EMA align required', minAccel: 0.001, minSlope: 1, rsiLong: 45, rsiShort: 55, consecCandles: 1, requireAlign: false },
    
    // Combined: tighter accel + tighter slope
    { name: 'COMBO: accel≥1 + slope≥2', minAccel: 1.0, minSlope: 2, rsiLong: 45, rsiShort: 55, consecCandles: 1, requireAlign: true },
    { name: 'COMBO: accel≥0.5 + slope≥2 + RSI50', minAccel: 0.5, minSlope: 2, rsiLong: 50, rsiShort: 50, consecCandles: 1, requireAlign: true },
    { name: 'COMBO: accel≥1 + slope≥2 + 2candles', minAccel: 1.0, minSlope: 2, rsiLong: 45, rsiShort: 55, consecCandles: 2, requireAlign: true },
    { name: 'COMBO: accel≥2 + slope≥3 + RSI48', minAccel: 2.0, minSlope: 3, rsiLong: 48, rsiShort: 52, consecCandles: 1, requireAlign: true },
    
    // Ultra selective
    { name: 'ULTRA: accel≥3 + slope≥3 + 2candles', minAccel: 3.0, minSlope: 3, rsiLong: 45, rsiShort: 55, consecCandles: 2, requireAlign: true },
    { name: 'ULTRA: accel≥2 + slope≥2 + RSI50 + 2c', minAccel: 2.0, minSlope: 2, rsiLong: 50, rsiShort: 50, consecCandles: 2, requireAlign: true },
  ];
  
  const results = [];
  
  for (const cfg of configs) {
    let trades = 0, wins = 0, entrySum = 0;
    let upTrades = 0, upWins = 0, dnTrades = 0, dnWins = 0;
    
    for (let i = 212; i < closes.length - 1; i++) {
      const fast = ema9[i], slow = ema200[i];
      const slope = slopes[i];
      const slopeAbs = Math.abs(slope);
      const accel = accels[i];
      const rsi = rsi14[i];
      
      // Min acceleration threshold
      if (accel < cfg.minAccel) continue;
      
      // Min slope
      if (slopeAbs < cfg.minSlope) continue;
      
      // Consecutive candles check
      if (cfg.consecCandles >= 2) {
        let ok = true;
        for (let j = 1; j < cfg.consecCandles; j++) {
          if (i - j < 1 || accels[i - j] < cfg.minAccel) { ok = false; break; }
        }
        if (!ok) continue;
      }
      
      // Determine side
      let side = null;
      if (cfg.requireAlign) {
        if (slope > 0 && fast > slow && rsi > cfg.rsiLong) side = 'up';
        if (slope < 0 && fast < slow && rsi < cfg.rsiShort) side = 'down';
      } else {
        if (slope > 0 && rsi > cfg.rsiLong) side = 'up';
        if (slope < 0 && rsi < cfg.rsiShort) side = 'down';
      }
      if (!side) continue;
      
      // Resolution
      const nextClose = closes[i + 1];
      const won = (side === 'up' && nextClose > closes[i]) || (side === 'down' && nextClose < closes[i]);
      const entry = impliedEntry(closes, i, side);
      
      trades++;
      entrySum += entry;
      if (won) wins++;
      if (side === 'up') { upTrades++; if (won) upWins++; }
      else { dnTrades++; if (won) dnWins++; }
    }
    
    const wr = trades > 0 ? wins / trades * 100 : 0;
    const avgEntry = trades > 0 ? entrySum / trades : 0;
    const ev = wr / 100 - avgEntry;
    const perHour = trades / totalHours;
    const perDay = perHour * 24;
    const upWR = upTrades > 0 ? (upWins / upTrades * 100).toFixed(1) : 'N/A';
    const dnWR = dnTrades > 0 ? (dnWins / dnTrades * 100).toFixed(1) : 'N/A';
    
    results.push({ ...cfg, trades, wr, avgEntry, ev, perHour, perDay, upTrades, upWR, dnTrades, dnWR });
  }
  
  // Sort by EV
  results.sort((a, b) => b.ev - a.ev);
  
  console.log('='.repeat(110));
  console.log('SLOPE ACCELERATION FILTER TUNING');
  console.log(`Data: ${klines.length} candles (~${totalHours.toFixed(0)} hours) · Early entry pricing (0.06 time discount)`);
  console.log('='.repeat(110));
  
  console.log('\n' + 
    'Rank'.padEnd(5) +
    'Config'.padEnd(42) +
    'Trades'.padEnd(8) +
    '/day'.padEnd(6) +
    'WR%'.padEnd(8) +
    'Entry'.padEnd(8) +
    'EV'.padEnd(10) +
    'Up(WR)'.padEnd(12) +
    'Dn(WR)'.padEnd(12)
  );
  console.log('-'.repeat(110));
  
  results.forEach((r, i) => {
    const evIcon = r.ev > 0 ? '✅' : r.ev > -0.05 ? '🟡' : '❌';
    const isCurrent = r.name.startsWith('CURRENT');
    const prefix = isCurrent ? '>>> ' : '    ';
    console.log(
      `${prefix}${String(i + 1).padEnd(1)} ` +
      `${r.name.padEnd(42)}` +
      `${String(r.trades).padEnd(8)}` +
      `${r.perDay.toFixed(0).padEnd(6)}` +
      `${r.wr.toFixed(1).padEnd(8)}` +
      `${r.avgEntry.toFixed(3).padEnd(8)}` +
      `${evIcon}${r.ev.toFixed(3).padEnd(9)}` +
      `${r.upTrades}(${r.upWR}%)`.padEnd(12) +
      `${r.dnTrades}(${r.dnWR}%)`.padEnd(12)
    );
  });
  
  // Find sweet spot
  console.log(`\n${'='.repeat(110)}`);
  console.log('ANALYSIS');
  console.log('='.repeat(110));
  
  // Group by filter type for comparison
  const accelGroup = results.filter(r => r.name.startsWith('Accel'));
  const slopeGroup = results.filter(r => r.name.startsWith('Slope'));
  const rsiGroup = results.filter(r => r.name.startsWith('RSI'));
  const consecGroup = results.filter(r => r.name.includes('consec'));
  
  console.log('\nAcceleration Threshold Impact:');
  for (const r of accelGroup) {
    const bar = '█'.repeat(Math.max(0, Math.round((r.ev + 0.2) * 50)));
    console.log(`  ${r.name.padEnd(20)} ${r.trades} trades, ${r.wr.toFixed(1)}% WR, EV ${r.ev.toFixed(3)} ${bar}`);
  }
  
  console.log('\nSlope Threshold Impact:');
  for (const r of slopeGroup) {
    const bar = '█'.repeat(Math.max(0, Math.round((r.ev + 0.2) * 50)));
    console.log(`  ${r.name.padEnd(20)} ${r.trades} trades, ${r.wr.toFixed(1)}% WR, EV ${r.ev.toFixed(3)} ${bar}`);
  }
  
  console.log('\nRSI Strictness Impact:');
  for (const r of rsiGroup) {
    const bar = '█'.repeat(Math.max(0, Math.round((r.ev + 0.2) * 50)));
    console.log(`  ${r.name.padEnd(25)} ${r.trades} trades, ${r.wr.toFixed(1)}% WR, EV ${r.ev.toFixed(3)} ${bar}`);
  }
  
  console.log('\nConsecutive Candles Impact:');
  for (const r of consecGroup) {
    const bar = '█'.repeat(Math.max(0, Math.round((r.ev + 0.2) * 50)));
    console.log(`  ${r.name.padEnd(25)} ${r.trades} trades, ${r.wr.toFixed(1)}% WR, EV ${r.ev.toFixed(3)} ${bar}`);
  }
  
  // Top 3 recommendation
  console.log('\n🏆 TOP 3 RECOMMENDED CONFIGS:');
  for (let i = 0; i < Math.min(3, results.length); i++) {
    const r = results[i];
    console.log(`  ${i+1}. ${r.name}`);
    console.log(`     ${r.trades} trades (${r.perDay.toFixed(0)}/day) | WR ${r.wr.toFixed(1)}% | Entry ${r.avgEntry.toFixed(3)} | EV ${r.ev.toFixed(3)}`);
    console.log(`     Longs: ${r.upTrades} (${r.upWR}%) | Shorts: ${r.dnTrades} (${r.dnWR}%)`);
  }
  
  // Current config position
  const currentIdx = results.findIndex(r => r.name.startsWith('CURRENT'));
  console.log(`\n📍 Current config ranked #${currentIdx + 1} of ${results.length}`);
}

run().catch(e => { console.error(e); process.exit(1); });
