/**
 * Full Backtest: MA Period × Entry Window × Entry Price Simulation
 * 
 * Uses historical klines to generate signals, then simulates Polymarket-style
 * binary outcomes with realistic entry pricing based on observed trade data.
 * 
 * Key insight: on Polymarket, entry price determines R:R.
 *   Win payout  = (1 - entry_price) * position_size
 *   Loss payout = -entry_price * position_size
 *   EV = WR * (1 - entry) - (1 - WR) * entry
 *      = WR - entry
 * 
 * So a strategy is +EV when win_rate > entry_price.
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

// Model entry price based on observed data from actual trades
// Earlier entry (more seconds to end) = cheaper price
// This models the relationship we've seen in real trades
function modelEntryPrice(secsToEnd, signalStrength) {
  // From our actual trade data:
  // 170-180s to end: avg entry ~0.30-0.40 (cheap, market hasn't moved much yet)
  // 120-150s to end: avg entry ~0.40-0.55 (mid-range)
  // 90-120s to end:  avg entry ~0.50-0.65 (expensive, trend already priced in)
  // Signal strength affects it too — stronger signal = market already moved = higher price
  
  // Base price from timing (linear interpolation)
  const timeFactor = 1 - (secsToEnd - 90) / 90; // 0 at 180s, 1 at 90s
  const basePrice = 0.28 + timeFactor * 0.30; // 0.28-0.58 range from timing
  
  // Signal strength adjustment (stronger signals = market already moved more)
  const strengthAdj = Math.min(0.10, signalStrength * 0.005);
  
  const price = Math.min(0.65, Math.max(0.20, basePrice + strengthAdj + (Math.random() * 0.10 - 0.05)));
  return parseFloat(price.toFixed(3));
}

// Determine if a 5-minute market resolves up or down
// Uses BTC price at "market start" vs "market end" (5 min apart)
function resolveMarket(klines, marketStartIdx) {
  // Market is a 5-min window = 1 candle
  // BTC at start = open of candle, BTC at end = close of candle
  const candle = klines[marketStartIdx];
  if (!candle) return null;
  return candle.close > candle.open ? 'up' : 'down';
}

async function run() {
  console.log('Fetching klines...');
  const klines = await fetchKlines(1000);
  console.log(`Got ${klines.length} candles (~${(klines.length * 5 / 60).toFixed(0)} hours)\n`);
  
  if (klines.length < 210) {
    console.log('Not enough data');
    process.exit(1);
  }

  const closes = klines.map(k => k.close);
  const ema20 = calcEMA(closes, 20);
  
  const maPeriods = [50, 100, 200];
  // Entry windows: [min_secs, max_secs] — how early before market end we enter
  const entryWindows = [
    { name: 'Early (150-180s)', min: 150, max: 180 },
    { name: 'Mid (120-150s)',   min: 120, max: 150 },
    { name: 'Late (90-120s)',   min: 90,  max: 120 },
    { name: 'Full (90-180s)',   min: 90,  max: 180 },
  ];
  
  const allResults = [];
  
  for (const slowPeriod of maPeriods) {
    const emaSlow = calcEMA(closes, slowPeriod);
    const startIdx = Math.max(slowPeriod + 10, 210);
    
    for (const window of entryWindows) {
      // Simulate multiple runs for statistical significance (Monte Carlo on entry timing)
      const RUNS = 50;
      let totalTrades = 0, totalWins = 0, totalPnl = 0;
      let totalEntryPrice = 0;
      let longTrades = 0, longWins = 0, shortTrades = 0, shortWins = 0;
      let longPnl = 0, shortPnl = 0;
      
      for (let run = 0; run < RUNS; run++) {
        let capital = 1000;
        
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
          
          // Base filters
          if (emaDistBps < 5 || slopeAbs < 2) continue;
          
          // Direction-specific filters
          if (side === 'up' && (emaDistBps < 8 || slopeAbs < 6)) continue;
          if (side === 'down') {
            const inDistDead = emaDistBps >= 5 && emaDistBps < 8;
            const inSlopeDead = slopeAbs >= 3 && slopeAbs < 6;
            if (inDistDead && inSlopeDead) continue;
          }
          
          // Simulate random entry time within window
          const secsToEnd = window.min + Math.random() * (window.max - window.min);
          const signalStrength = emaDistBps;
          const entryPrice = modelEntryPrice(secsToEnd, signalStrength);
          
          // Max entry filter
          if (entryPrice > 0.65) continue;
          
          // Resolve: did this candle go up or down?
          const resolution = resolveMarket(klines, i);
          if (!resolution) continue;
          
          const won = resolution === side;
          const posSize = capital * 0.07; // 7% sizing
          const pnl = won ? posSize * (1 - entryPrice) / entryPrice : -posSize;
          
          totalTrades++;
          totalEntryPrice += entryPrice;
          if (won) totalWins++;
          totalPnl += pnl;
          
          if (side === 'up') { longTrades++; if (won) longWins++; longPnl += pnl; }
          else { shortTrades++; if (won) shortWins++; shortPnl += pnl; }
          
          capital += pnl;
        }
      }
      
      // Average across runs
      const avgTrades = totalTrades / RUNS;
      const wr = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;
      const avgEntry = totalTrades > 0 ? totalEntryPrice / totalTrades : 0;
      const avgPnlPerTrade = totalTrades > 0 ? totalPnl / totalTrades : 0;
      const ev = wr / 100 - avgEntry; // EV = WR - entry_price
      const longWR = longTrades > 0 ? (longWins / longTrades * 100) : 0;
      const shortWR = shortTrades > 0 ? (shortWins / shortTrades * 100) : 0;
      const longAvgPnl = longTrades > 0 ? longPnl / longTrades : 0;
      const shortAvgPnl = shortTrades > 0 ? shortPnl / shortTrades : 0;
      
      allResults.push({
        ma: slowPeriod,
        window: window.name,
        trades: avgTrades.toFixed(0),
        wr: wr.toFixed(1),
        avgEntry: avgEntry.toFixed(3),
        ev: ev.toFixed(3),
        avgPnl: avgPnlPerTrade.toFixed(2),
        totalPnl: (totalPnl / RUNS).toFixed(2),
        longTrades: (longTrades / RUNS).toFixed(0),
        longWR: longWR.toFixed(1),
        longAvgPnl: longAvgPnl.toFixed(2),
        shortTrades: (shortTrades / RUNS).toFixed(0),
        shortWR: shortWR.toFixed(1),
        shortAvgPnl: shortAvgPnl.toFixed(2),
      });
    }
  }
  
  // Print results
  console.log('='.repeat(90));
  console.log('FULL BACKTEST: MA Period × Entry Window × Entry Price Simulation');
  console.log(`Data: ${klines.length} candles (~${(klines.length * 5 / 60).toFixed(0)} hours) · 50 Monte Carlo runs each`);
  console.log('Sizing: 7% of capital · Max entry: 0.65 · All current filters applied');
  console.log('EV = Win Rate - Avg Entry Price (positive = profitable strategy)');
  console.log('='.repeat(90));
  
  // Group by MA period
  for (const ma of maPeriods) {
    const group = allResults.filter(r => r.ma === ma);
    console.log(`\n${'─'.repeat(90)}`);
    console.log(`EMA 20/${ma} (slow MA lookback: ${(ma * 5 / 60).toFixed(1)} hours)`);
    console.log('─'.repeat(90));
    console.log(
      'Window'.padEnd(18) +
      'Trades'.padEnd(8) +
      'WR%'.padEnd(8) +
      'AvgEntry'.padEnd(10) +
      'EV'.padEnd(8) +
      '$/Trade'.padEnd(10) +
      'Total$'.padEnd(10) +
      'L(WR/Avg$)'.padEnd(16) +
      'S(WR/Avg$)'.padEnd(16)
    );
    for (const r of group) {
      const evColor = parseFloat(r.ev) > 0 ? '✅' : '❌';
      console.log(
        r.window.padEnd(18) +
        r.trades.padEnd(8) +
        `${r.wr}%`.padEnd(8) +
        r.avgEntry.padEnd(10) +
        `${evColor}${r.ev}`.padEnd(8) +
        `$${r.avgPnl}`.padEnd(10) +
        `$${r.totalPnl}`.padEnd(10) +
        `${r.longTrades}(${r.longWR}%/$${r.longAvgPnl})`.padEnd(16) +
        `${r.shortTrades}(${r.shortWR}%/$${r.shortAvgPnl})`.padEnd(16)
      );
    }
  }
  
  // Summary: best combos
  console.log(`\n${'='.repeat(90)}`);
  console.log('TOP 5 COMBOS BY EV:');
  console.log('='.repeat(90));
  const sorted = [...allResults].sort((a, b) => parseFloat(b.ev) - parseFloat(a.ev));
  for (let i = 0; i < Math.min(5, sorted.length); i++) {
    const r = sorted[i];
    console.log(`${i+1}. EMA20/${r.ma} + ${r.window} → EV: ${r.ev} | WR: ${r.wr}% | AvgEntry: ${r.avgEntry} | ${r.trades} trades | $${r.avgPnl}/trade`);
  }
  
  console.log(`\nWORST 3 COMBOS BY EV:`);
  for (let i = sorted.length - 1; i >= Math.max(0, sorted.length - 3); i--) {
    const r = sorted[i];
    console.log(`  EMA20/${r.ma} + ${r.window} → EV: ${r.ev} | WR: ${r.wr}% | AvgEntry: ${r.avgEntry} | ${r.trades} trades | $${r.avgPnl}/trade`);
  }
  
  // Entry price analysis
  console.log(`\n${'='.repeat(90)}`);
  console.log('ENTRY PRICE IMPACT (across all MAs):');
  console.log('='.repeat(90));
  for (const window of ['Early (150-180s)', 'Mid (120-150s)', 'Late (90-120s)']) {
    const windowResults = allResults.filter(r => r.window === window);
    const avgEntry = (windowResults.reduce((s, r) => s + parseFloat(r.avgEntry), 0) / windowResults.length).toFixed(3);
    const avgWR = (windowResults.reduce((s, r) => s + parseFloat(r.wr), 0) / windowResults.length).toFixed(1);
    const avgEV = (windowResults.reduce((s, r) => s + parseFloat(r.ev), 0) / windowResults.length).toFixed(3);
    const avgPnl = (windowResults.reduce((s, r) => s + parseFloat(r.avgPnl), 0) / windowResults.length).toFixed(2);
    console.log(`${window}: Avg Entry ${avgEntry} | Avg WR ${avgWR}% | Avg EV ${avgEV} | Avg $/trade $${avgPnl}`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
