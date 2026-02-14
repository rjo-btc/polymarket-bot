/**
 * Edge Leakage Analysis: How MA period affects entry pricing via trend timing
 * 
 * Key hypothesis: Faster MA signals earlier in a move → market hasn't priced
 * the trend yet → cheaper entry on Polymarket. Slower MA signals after the
 * move is underway → market price already reflects momentum → expensive entry.
 * 
 * This test measures:
 * 1. How far into a BTC move each MA signals (% of move captured)
 * 2. Implied entry price based on move progression (closer to 0.50 = market unsure = cheap)
 * 3. Combined EV factoring in realistic momentum-based pricing
 * 4. Signal persistence: how many consecutive candles does each MA stay aligned?
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
  const klines = await fetchKlines(1000);
  console.log(`Got ${klines.length} candles (~${(klines.length * 5 / 60).toFixed(0)} hours)\n`);

  const closes = klines.map(k => k.close);
  const ema20 = calcEMA(closes, 20);
  const periods = [50, 100, 200];
  const emas = {};
  for (const p of periods) emas[p] = calcEMA(closes, p);

  // --- Analysis 1: Signal Timing Within Moves ---
  // Find directional "moves" — sequences of candles trending in one direction
  // Then check when each MA gives its first signal during each move
  
  console.log('='.repeat(90));
  console.log('ANALYSIS 1: HOW EARLY DOES EACH MA CATCH A MOVE?');
  console.log('='.repeat(90));
  
  // Identify trending segments: 5+ consecutive candles in same direction
  const moves = [];
  let moveStart = 0;
  let moveDir = closes[1] > closes[0] ? 'up' : 'down';
  
  for (let i = 2; i < closes.length; i++) {
    // Use smoothed direction (3-candle avg) to avoid noise
    const dir = closes[i] > closes[Math.max(0, i - 3)] ? 'up' : 'down';
    if (dir !== moveDir || i === closes.length - 1) {
      const len = i - moveStart;
      if (len >= 5) {
        const moveBps = Math.abs((closes[i-1] - closes[moveStart]) / closes[moveStart]) * 10000;
        if (moveBps >= 10) { // Only meaningful moves (>10 bps)
          moves.push({ start: moveStart, end: i - 1, dir: moveDir, len, moveBps });
        }
      }
      moveStart = i;
      moveDir = dir;
    }
  }
  
  console.log(`Found ${moves.length} significant moves (≥5 candles, ≥10 bps)\n`);
  
  // For each move, find when each MA first signals
  const firstSignalTiming = {};
  for (const p of periods) firstSignalTiming[p] = [];
  
  for (const move of moves) {
    for (const slowPeriod of periods) {
      const slow = emas[slowPeriod];
      let firstSignalCandle = null;
      
      for (let i = move.start; i <= move.end; i++) {
        if (i < slowPeriod + 10 || i < 210) continue;
        const price = closes[i];
        const fast = ema20[i];
        const s = slow[i];
        const fastPrev = ema20[i - 1];
        const slope = fast - fastPrev;
        
        let side = null;
        if (price > fast && fast > s && slope > 0) side = 'up';
        if (price < fast && fast < s && slope < 0) side = 'down';
        
        if (side === move.dir) {
          firstSignalCandle = i - move.start;
          break;
        }
      }
      
      if (firstSignalCandle !== null) {
        const pctIntoMove = (firstSignalCandle / move.len * 100);
        firstSignalTiming[slowPeriod].push({
          pctIntoMove,
          candlesIn: firstSignalCandle,
          moveLen: move.len,
          moveBps: move.moveBps,
        });
      }
    }
  }
  
  console.log('MA Period  | Moves Caught | Avg % Into Move | Avg Candles In | Catch Rate');
  console.log('-'.repeat(80));
  for (const p of periods) {
    const t = firstSignalTiming[p];
    const caught = t.length;
    const avgPct = caught > 0 ? (t.reduce((s, x) => s + x.pctIntoMove, 0) / caught).toFixed(1) : 'N/A';
    const avgCandles = caught > 0 ? (t.reduce((s, x) => s + x.candlesIn, 0) / caught).toFixed(1) : 'N/A';
    const catchRate = (caught / moves.length * 100).toFixed(1);
    console.log(`EMA ${p}`.padEnd(11) + `| ${caught}`.padEnd(14) + `| ${avgPct}%`.padEnd(18) + `| ${avgCandles}`.padEnd(17) + `| ${catchRate}%`);
  }

  // --- Analysis 2: Momentum-Based Entry Pricing ---
  console.log(`\n${'='.repeat(90)}`);
  console.log('ANALYSIS 2: MOMENTUM-BASED ENTRY PRICING');
  console.log('How much has BTC already moved when each MA signals? (affects Polymarket price)');
  console.log('='.repeat(90));
  
  const momentumAtSignal = {};
  for (const p of periods) momentumAtSignal[p] = { up: [], down: [] };
  
  for (const slowPeriod of periods) {
    const slow = emas[slowPeriod];
    const startIdx = Math.max(slowPeriod + 10, 210);
    
    for (let i = startIdx; i < closes.length - 1; i++) {
      const price = closes[i];
      const fast = ema20[i];
      const s = slow[i];
      const fastPrev = ema20[i - 1];
      const slope = fast - fastPrev;
      const slopeAbs = Math.abs(slope);
      const emaDistBps = Math.abs(((fast - s) / s) * 10000);
      
      let side = null;
      if (price > fast && fast > s && slope > 0) side = 'up';
      if (price < fast && fast < s && slope < 0) side = 'down';
      if (!side) continue;
      if (emaDistBps < 5 || slopeAbs < 2) continue;
      if (side === 'up' && (emaDistBps < 8 || slopeAbs < 6)) continue;
      if (side === 'down') {
        const inDistDead = emaDistBps >= 5 && emaDistBps < 8;
        const inSlopeDead = slopeAbs >= 3 && slopeAbs < 6;
        if (inDistDead && inSlopeDead) continue;
      }
      
      // How much has BTC already moved in this direction over recent candles?
      // This approximates how "priced in" the move is on Polymarket
      const lookback5 = closes[Math.max(0, i - 5)];
      const lookback10 = closes[Math.max(0, i - 10)];
      const recentMoveBps5 = ((price - lookback5) / lookback5) * 10000;
      const recentMoveBps10 = ((price - lookback10) / lookback10) * 10000;
      
      // Implied Polymarket entry price: 
      // Bigger recent move in signal direction = market more confident = more expensive entry
      const absMove5 = Math.abs(recentMoveBps5);
      const dirCorrect5 = (side === 'up' && recentMoveBps5 > 0) || (side === 'down' && recentMoveBps5 < 0);
      
      // Model: base 0.50 + momentum premium
      // If BTC already moved 20bps in signal direction, market is ~0.60-0.65
      // If BTC barely moved, market is ~0.45-0.55
      const momentumPremium = dirCorrect5 ? Math.min(0.15, absMove5 * 0.005) : -Math.min(0.10, absMove5 * 0.003);
      const impliedEntry = Math.min(0.65, Math.max(0.25, 0.50 + momentumPremium));
      
      // Actual resolution
      const nextClose = closes[i + 1];
      const resolution = nextClose > price ? 'up' : 'down';
      const won = resolution === side;
      
      momentumAtSignal[slowPeriod][side].push({
        emaDistBps,
        slopeAbs,
        recentMoveBps5,
        recentMoveBps10,
        impliedEntry,
        won,
        absMove5,
      });
    }
  }
  
  console.log('\nMA Period  | Side  | Signals | Avg Recent Move | Avg Implied Entry | WR%    | EV (WR-Entry)');
  console.log('-'.repeat(95));
  for (const p of periods) {
    for (const side of ['up', 'down']) {
      const data = momentumAtSignal[p][side];
      if (data.length === 0) continue;
      const avgMove = (data.reduce((s, x) => s + x.recentMoveBps5, 0) / data.length).toFixed(1);
      const avgEntry = (data.reduce((s, x) => s + x.impliedEntry, 0) / data.length).toFixed(3);
      const wr = (data.filter(x => x.won).length / data.length * 100).toFixed(1);
      const ev = (parseFloat(wr) / 100 - parseFloat(avgEntry)).toFixed(3);
      console.log(
        `EMA ${p}`.padEnd(11) + 
        `| ${side.toUpperCase()}`.padEnd(8) + 
        `| ${data.length}`.padEnd(10) + 
        `| ${avgMove} bps`.padEnd(18) + 
        `| ${avgEntry}`.padEnd(20) + 
        `| ${wr}%`.padEnd(9) + 
        `| ${parseFloat(ev) > 0 ? '✅' : '❌'} ${ev}`
      );
    }
  }

  // --- Analysis 3: Signal Quality Buckets ---
  console.log(`\n${'='.repeat(90)}`);
  console.log('ANALYSIS 3: SIGNAL QUALITY vs ENTRY PRICING TRADEOFF');
  console.log('Does stronger signal = better outcome, or just more expensive entry?');
  console.log('='.repeat(90));
  
  for (const p of periods) {
    const allData = [...momentumAtSignal[p].up, ...momentumAtSignal[p].down];
    if (allData.length === 0) continue;
    
    // Bucket by EMA distance
    const buckets = [
      { name: 'Weak (5-8 bps)', filter: d => d.emaDistBps >= 5 && d.emaDistBps < 8 },
      { name: 'Mid (8-15 bps)', filter: d => d.emaDistBps >= 8 && d.emaDistBps < 15 },
      { name: 'Strong (15+ bps)', filter: d => d.emaDistBps >= 15 },
    ];
    
    console.log(`\nEMA 20/${p}:`);
    console.log('  Strength       | Count | WR%    | Avg Entry | EV     | Avg BTC Move');
    console.log('  ' + '-'.repeat(75));
    for (const b of buckets) {
      const filtered = allData.filter(b.filter);
      if (filtered.length === 0) { console.log(`  ${b.name.padEnd(17)}| 0`); continue; }
      const wr = (filtered.filter(x => x.won).length / filtered.length * 100).toFixed(1);
      const avgEntry = (filtered.reduce((s, x) => s + x.impliedEntry, 0) / filtered.length).toFixed(3);
      const ev = (parseFloat(wr) / 100 - parseFloat(avgEntry)).toFixed(3);
      const avgMove = (filtered.reduce((s, x) => s + x.absMove5, 0) / filtered.length).toFixed(1);
      console.log(
        `  ${b.name.padEnd(17)}| ${String(filtered.length).padEnd(6)}| ${(wr + '%').padEnd(9)}| ${avgEntry.padEnd(10)}| ${(parseFloat(ev) > 0 ? '✅' : '❌') + ' ' + ev}`.padEnd(60) + `| ${avgMove} bps`
      );
    }
  }

  // --- Analysis 4: Optimal MA recommendation ---
  console.log(`\n${'='.repeat(90)}`);
  console.log('RECOMMENDATION');
  console.log('='.repeat(90));
  
  // Calculate composite score: EV * sqrt(frequency) — balances edge and opportunity
  for (const p of periods) {
    const allData = [...momentumAtSignal[p].up, ...momentumAtSignal[p].down];
    if (allData.length === 0) continue;
    const wr = allData.filter(x => x.won).length / allData.length;
    const avgEntry = allData.reduce((s, x) => s + x.impliedEntry, 0) / allData.length;
    const ev = wr - avgEntry;
    const freq = allData.length;
    const score = ev * Math.sqrt(freq);
    console.log(`EMA 20/${p}: EV=${ev.toFixed(3)} × √${freq} signals = Score ${score.toFixed(2)}`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
