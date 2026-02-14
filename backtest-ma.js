/**
 * Backtest EMA slow MA periods (50, 100, 200) against historical BTC 5m klines.
 * Simulates signal generation for each period and compares.
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

async function run() {
  console.log('Fetching klines...');
  const klines = await fetchKlines(1000); // get max history
  console.log(`Got ${klines.length} candles`);
  
  if (klines.length < 210) {
    console.log('Not enough data');
    process.exit(1);
  }

  const closes = klines.map(k => k.close);
  const times = klines.map(k => new Date(k.openTime).toISOString());
  
  const ema20 = calcEMA(closes, 20);
  const periods = [50, 100, 200];
  
  const results = {};
  
  for (const slowPeriod of periods) {
    const emaSlow = calcEMA(closes, slowPeriod);
    const signals = [];
    
    // Start from index where slow MA has enough data to be meaningful
    const startIdx = Math.max(slowPeriod + 10, 210);
    
    for (let i = startIdx; i < closes.length - 1; i++) {
      const price = closes[i];
      const fast = ema20[i];
      const slow = emaSlow[i];
      const fastPrev = ema20[i - 1];
      const slope = fast - fastPrev;
      const slopeAbs = Math.abs(slope);
      const emaDistBps = Math.abs(((fast - slow) / slow) * 10000);
      
      // Check alignment
      let side = null;
      if (price > fast && fast > slow && slope > 0) side = 'up';
      if (price < fast && fast < slow && slope < 0) side = 'down';
      
      if (!side) continue;
      
      // Apply base filters (min dist 5, min slope 2)
      if (emaDistBps < 5) continue;
      if (slopeAbs < 2) continue;
      
      // Direction-specific filters
      if (side === 'up') {
        if (emaDistBps < 8 || slopeAbs < 6) continue;
      }
      if (side === 'down') {
        // Death zone: dist 5-8 AND slope 3-6
        const inDistDead = emaDistBps >= 5 && emaDistBps < 8;
        const inSlopeDead = slopeAbs >= 3 && slopeAbs < 6;
        if (inDistDead && inSlopeDead) continue;
      }
      
      // Simulate outcome: did BTC go in the signal direction over next candle?
      const nextClose = closes[i + 1];
      const btcMove = nextClose - price;
      const win = (side === 'up' && btcMove > 0) || (side === 'down' && btcMove < 0);
      const moveBps = Math.abs(btcMove / price) * 10000;
      
      signals.push({
        time: times[i],
        side,
        dist: emaDistBps.toFixed(1),
        slope: slopeAbs.toFixed(2),
        win,
        moveBps: moveBps.toFixed(1),
        btcMove: btcMove.toFixed(2),
      });
    }
    
    const wins = signals.filter(s => s.win).length;
    const losses = signals.length - wins;
    const wr = signals.length > 0 ? (wins / signals.length * 100).toFixed(1) : 'N/A';
    
    const upSignals = signals.filter(s => s.side === 'up');
    const downSignals = signals.filter(s => s.side === 'down');
    const upWR = upSignals.length > 0 ? (upSignals.filter(s => s.win).length / upSignals.length * 100).toFixed(1) : 'N/A';
    const downWR = downSignals.length > 0 ? (downSignals.filter(s => s.win).length / downSignals.length * 100).toFixed(1) : 'N/A';
    
    // Signal frequency: signals per hour
    const totalHours = (klines.length - startIdx) * 5 / 60;
    const freqPerHour = (signals.length / totalHours).toFixed(2);
    
    // Avg dist and slope when signaling
    const avgDist = signals.length > 0 ? (signals.reduce((s, x) => s + parseFloat(x.dist), 0) / signals.length).toFixed(1) : 'N/A';
    const avgSlope = signals.length > 0 ? (signals.reduce((s, x) => s + parseFloat(x.slope), 0) / signals.length).toFixed(1) : 'N/A';
    
    results[slowPeriod] = { signals: signals.length, wins, losses, wr, upSignals: upSignals.length, upWR, downSignals: downSignals.length, downWR, freqPerHour, avgDist, avgSlope };
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('EMA SLOW MA BACKTEST — BTC 5m Klines');
  console.log(`Data: ${klines.length} candles (~${(klines.length * 5 / 60).toFixed(0)} hours)`);
  console.log('Filters: dist≥5, slope≥2, long dist≥8+slope≥6, short death zone blocked');
  console.log('='.repeat(70));
  
  console.log('\n' + '-'.repeat(70));
  console.log(
    'Period'.padEnd(10) +
    'Signals'.padEnd(10) +
    'W/L'.padEnd(10) +
    'WR%'.padEnd(8) +
    'Up(WR)'.padEnd(12) +
    'Down(WR)'.padEnd(12) +
    'Sig/hr'.padEnd(8) +
    'AvgDist'.padEnd(8) +
    'AvgSlp'.padEnd(8)
  );
  console.log('-'.repeat(70));
  
  for (const [period, r] of Object.entries(results)) {
    console.log(
      `EMA${period}`.padEnd(10) +
      `${r.signals}`.padEnd(10) +
      `${r.wins}/${r.losses}`.padEnd(10) +
      `${r.wr}%`.padEnd(8) +
      `${r.upSignals}(${r.upWR}%)`.padEnd(12) +
      `${r.downSignals}(${r.downWR}%)`.padEnd(12) +
      `${r.freqPerHour}`.padEnd(8) +
      `${r.avgDist}`.padEnd(8) +
      `${r.avgSlope}`.padEnd(8)
    );
  }
  console.log('-'.repeat(70));
  
  console.log('\nNOTE: "Win" = BTC moved in signal direction over the next 5m candle.');
  console.log('This is a directional accuracy test, not a P&L simulation (no entry pricing).');
}

run().catch(e => { console.error(e); process.exit(1); });
