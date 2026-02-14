const positions = require('child_process').execSync('curl -s https://polymarket-bot-production-c26d.up.railway.app/api/positions').toString();
const trades = JSON.parse(positions).filter(t => t.status === 'resolved').sort((a, b) => a.id - b.id);

// Parse PA metrics from each trade
function parseMetrics(t) {
  const pa = {};
  const paMatch = (t.entry_reason || '').match(/PA\[([^\]]+)\]/);
  if (paMatch) {
    paMatch[1].split(',').forEach(part => {
      const [k, v] = part.split('=').map(s => s.trim());
      if (k && v) pa[k] = isNaN(v) ? v : parseFloat(v);
    });
  }
  
  let signalType = 'standard';
  if (t.entry_reason?.includes('SLOPE ACCEL')) signalType = 'slope_accel';
  else if (t.entry_reason?.includes('MOMENTUM BURST')) signalType = 'momentum_burst';
  else if (t.entry_reason?.includes('Session')) signalType = 'session';
  
  const btcMoveBps = t.btc_price_at_start ? ((t.btc_price_at_end - t.btc_price_at_start) / t.btc_price_at_start) * 10000 : 0;
  
  return {
    ...t,
    signalType,
    dist: pa.dist || pa.edist || null,
    edist: pa.edist || null,
    slope: pa.slope ? Math.abs(pa.slope) : null,
    rsi: pa.rsi || null,
    btcMoveBps: parseFloat(btcMoveBps.toFixed(1)),
    absBtcMove: Math.abs(btcMoveBps),
    won: t.pnl > 0,
  };
}

const parsed = trades.map(parseMetrics);
const wins = parsed.filter(t => t.won);
const losses = parsed.filter(t => !t.won);

console.log(`\n${'='.repeat(60)}`);
console.log(`TOTAL: ${trades.length} trades | ${wins.length}W/${losses.length}L (${(wins.length/trades.length*100).toFixed(1)}% WR)`);
console.log(`Total PnL: $${trades.reduce((s,t) => s+t.pnl, 0).toFixed(2)}`);
console.log(`${'='.repeat(60)}`);

// === BY SIGNAL TYPE ===
console.log('\n📊 BY SIGNAL TYPE:');
for (const type of ['standard', 'slope_accel', 'session']) {
  const t = parsed.filter(x => x.signalType === type);
  if (t.length === 0) continue;
  const w = t.filter(x => x.won);
  const l = t.filter(x => !x.won);
  const pnl = t.reduce((s,x) => s+x.pnl, 0);
  const avgWin = w.length > 0 ? w.reduce((s,x)=>s+x.pnl,0)/w.length : 0;
  const avgLoss = l.length > 0 ? l.reduce((s,x)=>s+x.pnl,0)/l.length : 0;
  console.log(`  ${type}: ${t.length} trades (${w.length}W/${l.length}L) WR=${(w.length/t.length*100).toFixed(0)}% | PnL=$${pnl.toFixed(0)} | AvgW=$${avgWin.toFixed(0)} AvgL=$${avgLoss.toFixed(0)}`);
}

// === BY SIDE ===
console.log('\n📊 BY SIDE:');
for (const side of ['up', 'down']) {
  const t = parsed.filter(x => x.side === side);
  const w = t.filter(x => x.won);
  const l = t.filter(x => !x.won);
  const pnl = t.reduce((s,x) => s+x.pnl, 0);
  console.log(`  ${side.toUpperCase()}: ${t.length} trades (${w.length}W/${l.length}L) WR=${(w.length/t.length*100).toFixed(0)}% | PnL=$${pnl.toFixed(0)}`);
}

// === BY SIDE + SIGNAL TYPE ===
console.log('\n📊 BY SIDE × SIGNAL TYPE:');
for (const side of ['up', 'down']) {
  for (const type of ['standard', 'slope_accel', 'session']) {
    const t = parsed.filter(x => x.side === side && x.signalType === type);
    if (t.length === 0) continue;
    const w = t.filter(x => x.won);
    const pnl = t.reduce((s,x) => s+x.pnl, 0);
    console.log(`  ${side.toUpperCase()} ${type}: ${t.length} trades (${w.length}W/${t.length-w.length}L) WR=${(w.length/t.length*100).toFixed(0)}% | PnL=$${pnl.toFixed(0)}`);
  }
}

// === WINS ANALYSIS ===
console.log('\n\n✅ WINS ANALYSIS:');
console.log(`Count: ${wins.length} | Total: $${wins.reduce((s,t)=>s+t.pnl,0).toFixed(0)}`);
console.log(`Avg win: $${(wins.reduce((s,t)=>s+t.pnl,0)/wins.length).toFixed(0)}`);

// Entry price distribution for wins
const winEntryBuckets = { cheap: [], mid: [], expensive: [] };
for (const w of wins) {
  if (w.entry_price <= 0.40) winEntryBuckets.cheap.push(w);
  else if (w.entry_price <= 0.55) winEntryBuckets.mid.push(w);
  else winEntryBuckets.expensive.push(w);
}
console.log('\n  Entry Price Buckets:');
for (const [label, bucket] of Object.entries(winEntryBuckets)) {
  if (bucket.length === 0) continue;
  const pnl = bucket.reduce((s,t)=>s+t.pnl,0);
  const avgPnl = pnl/bucket.length;
  console.log(`    ${label} (≤${label==='cheap'?'0.40':label==='mid'?'0.55':'1.00'}): ${bucket.length} wins, PnL=$${pnl.toFixed(0)}, Avg=$${avgPnl.toFixed(0)}`);
}

// Timing distribution for wins
console.log('\n  Timing Buckets:');
const winTimeBuckets = { early: [], standard: [], late: [] };
for (const w of wins) {
  if (w.seconds_to_end_at_entry > 220) winTimeBuckets.early.push(w);
  else if (w.seconds_to_end_at_entry >= 160) winTimeBuckets.standard.push(w);
  else winTimeBuckets.late.push(w);
}
for (const [label, bucket] of Object.entries(winTimeBuckets)) {
  if (bucket.length === 0) continue;
  const pnl = bucket.reduce((s,t)=>s+t.pnl,0);
  console.log(`    ${label}: ${bucket.length} wins, PnL=$${pnl.toFixed(0)}, Avg=$${(pnl/bucket.length).toFixed(0)}`);
}

// BTC move magnitude for wins
console.log('\n  BTC Move (wins):');
const winMoves = wins.map(w => w.absBtcMove).sort((a,b) => a-b);
console.log(`    Min: ${winMoves[0]?.toFixed(1)} bps, Max: ${winMoves[winMoves.length-1]?.toFixed(1)} bps, Median: ${winMoves[Math.floor(winMoves.length/2)]?.toFixed(1)} bps`);
const bigWins = wins.filter(w => w.absBtcMove >= 10);
const smallWins = wins.filter(w => w.absBtcMove < 10);
console.log(`    BTC moved ≥10 bps: ${bigWins.length} wins ($${bigWins.reduce((s,t)=>s+t.pnl,0).toFixed(0)})`);
console.log(`    BTC moved <10 bps: ${smallWins.length} wins ($${smallWins.reduce((s,t)=>s+t.pnl,0).toFixed(0)})`);

// Slope for wins
console.log('\n  Slope (wins):');
const winSlopes = wins.filter(w => w.slope !== null);
if (winSlopes.length > 0) {
  const slopes = winSlopes.map(w => w.slope).sort((a,b) => a-b);
  console.log(`    Min: ${slopes[0]?.toFixed(1)}, Max: ${slopes[slopes.length-1]?.toFixed(1)}, Median: ${slopes[Math.floor(slopes.length/2)]?.toFixed(1)}`);
  const lowSlope = winSlopes.filter(w => w.slope < 5);
  const highSlope = winSlopes.filter(w => w.slope >= 5);
  console.log(`    Slope <5: ${lowSlope.length} wins ($${lowSlope.reduce((s,t)=>s+t.pnl,0).toFixed(0)})`);
  console.log(`    Slope ≥5: ${highSlope.length} wins ($${highSlope.reduce((s,t)=>s+t.pnl,0).toFixed(0)})`);
}

// === LOSSES ANALYSIS ===
console.log('\n\n❌ LOSSES ANALYSIS:');
console.log(`Count: ${losses.length} | Total: -$${Math.abs(losses.reduce((s,t)=>s+t.pnl,0)).toFixed(0)}`);
console.log(`Avg loss: -$${Math.abs(losses.reduce((s,t)=>s+t.pnl,0)/losses.length).toFixed(0)}`);

// Entry price distribution for losses
const lossEntryBuckets = { cheap: [], mid: [], expensive: [] };
for (const l of losses) {
  if (l.entry_price <= 0.40) lossEntryBuckets.cheap.push(l);
  else if (l.entry_price <= 0.55) lossEntryBuckets.mid.push(l);
  else lossEntryBuckets.expensive.push(l);
}
console.log('\n  Entry Price Buckets:');
for (const [label, bucket] of Object.entries(lossEntryBuckets)) {
  if (bucket.length === 0) continue;
  const pnl = bucket.reduce((s,t)=>s+t.pnl,0);
  console.log(`    ${label}: ${bucket.length} losses, PnL=$${pnl.toFixed(0)}`);
}

// BTC move for losses
console.log('\n  BTC Move (losses):');
const lossMoves = losses.map(l => l.absBtcMove).sort((a,b) => a-b);
console.log(`    Min: ${lossMoves[0]?.toFixed(1)} bps, Max: ${lossMoves[lossMoves.length-1]?.toFixed(1)} bps, Median: ${lossMoves[Math.floor(lossMoves.length/2)]?.toFixed(1)} bps`);
const flatLosses = losses.filter(l => l.absBtcMove < 5);
const realLosses = losses.filter(l => l.absBtcMove >= 5);
console.log(`    Flat (<5 bps): ${flatLosses.length} losses ($${flatLosses.reduce((s,t)=>s+t.pnl,0).toFixed(0)}) — market chop`);
console.log(`    Real move (≥5 bps): ${realLosses.length} losses ($${realLosses.reduce((s,t)=>s+t.pnl,0).toFixed(0)}) — wrong direction`);

// Slope for losses
console.log('\n  Slope (losses):');
const lossSlopes = losses.filter(l => l.slope !== null);
if (lossSlopes.length > 0) {
  const slopes = lossSlopes.map(l => l.slope).sort((a,b) => a-b);
  console.log(`    Min: ${slopes[0]?.toFixed(1)}, Max: ${slopes[slopes.length-1]?.toFixed(1)}, Median: ${slopes[Math.floor(slopes.length/2)]?.toFixed(1)}`);
}

// Loss details
console.log('\n  Individual Losses:');
for (const l of losses) {
  console.log(`    #${l.id} ${l.side.toUpperCase()} ${l.signalType} @ ${l.entry_price} | dist=${l.dist||'?'} slope=${l.slope?.toFixed(1)||'?'} rsi=${l.rsi||'?'} | BTC ${l.btcMoveBps>0?'+':''}${l.btcMoveBps} bps | -$${Math.abs(l.pnl).toFixed(0)} | ${l.seconds_to_end_at_entry}s`);
}

// === COMBINED PATTERNS ===
console.log('\n\n🔍 EDGE LEAK PATTERNS:');

// 1. Cheap entries vs expensive
console.log('\n  1. ENTRY PRICE R:R:');
for (const threshold of [0.30, 0.40, 0.50]) {
  const cheap = parsed.filter(t => t.entry_price <= threshold);
  const exp = parsed.filter(t => t.entry_price > threshold);
  if (cheap.length === 0 || exp.length === 0) continue;
  const cheapWR = cheap.filter(t=>t.won).length/cheap.length*100;
  const expWR = exp.filter(t=>t.won).length/exp.length*100;
  const cheapPnl = cheap.reduce((s,t)=>s+t.pnl,0);
  const expPnl = exp.reduce((s,t)=>s+t.pnl,0);
  console.log(`    ≤${threshold}: ${cheap.length} trades, WR=${cheapWR.toFixed(0)}%, PnL=$${cheapPnl.toFixed(0)} | >${threshold}: ${exp.length} trades, WR=${expWR.toFixed(0)}%, PnL=$${expPnl.toFixed(0)}`);
}

// 2. Position sizing — are losses bigger than wins?
console.log('\n  2. POSITION SIZING:');
const avgWinStake = wins.reduce((s,t)=>s+t.stake_usd,0)/wins.length;
const avgLossStake = losses.reduce((s,t)=>s+t.stake_usd,0)/losses.length;
console.log(`    Avg win stake: $${avgWinStake.toFixed(0)} | Avg loss stake: $${avgLossStake.toFixed(0)}`);
console.log(`    Ratio: ${(avgLossStake/avgWinStake).toFixed(2)}x (losses ${avgLossStake>avgWinStake?'BIGGER':'smaller'} than wins)`);

// Biggest 5 wins and losses
console.log('\n    Top 5 Wins:');
const topWins = [...wins].sort((a,b) => b.pnl - a.pnl).slice(0,5);
topWins.forEach(t => console.log(`      #${t.id} +$${t.pnl.toFixed(0)} (${t.signalType} ${t.side}) stake=$${t.stake_usd.toFixed(0)}`));
console.log('    Top 5 Losses:');
const topLosses = [...losses].sort((a,b) => a.pnl - b.pnl).slice(0,5);
topLosses.forEach(t => console.log(`      #${t.id} -$${Math.abs(t.pnl).toFixed(0)} (${t.signalType} ${t.side}) stake=$${t.stake_usd.toFixed(0)}`));

// 3. Consecutive patterns
console.log('\n  3. STREAKS:');
let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
for (const t of parsed) {
  if (t.won) { curWin++; curLoss = 0; maxWinStreak = Math.max(maxWinStreak, curWin); }
  else { curLoss++; curWin = 0; maxLossStreak = Math.max(maxLossStreak, curLoss); }
}
console.log(`    Max win streak: ${maxWinStreak} | Max loss streak: ${maxLossStreak}`);

// 4. Dist + slope sweet spots
console.log('\n  4. EMA DIST SWEET SPOT (edist where available):');
const withDist = parsed.filter(t => (t.edist || t.dist) !== null);
for (const [lo, hi] of [[0,5],[5,15],[15,30],[30,50],[50,999]]) {
  const bucket = withDist.filter(t => {
    const d = t.edist || t.dist;
    return d >= lo && d < hi;
  });
  if (bucket.length === 0) continue;
  const w = bucket.filter(t=>t.won).length;
  const pnl = bucket.reduce((s,t)=>s+t.pnl,0);
  console.log(`    ${lo}-${hi} bps: ${bucket.length} trades (${w}W/${bucket.length-w}L) WR=${(w/bucket.length*100).toFixed(0)}% PnL=$${pnl.toFixed(0)}`);
}

// 5. Time of day / market regime
console.log('\n  5. COMPOUNDING EFFECT:');
const firstHalf = parsed.slice(0, Math.floor(parsed.length/2));
const secondHalf = parsed.slice(Math.floor(parsed.length/2));
console.log(`    First ${firstHalf.length} trades: ${firstHalf.filter(t=>t.won).length}W/${firstHalf.filter(t=>!t.won).length}L, PnL=$${firstHalf.reduce((s,t)=>s+t.pnl,0).toFixed(0)}, Avg stake=$${(firstHalf.reduce((s,t)=>s+t.stake_usd,0)/firstHalf.length).toFixed(0)}`);
console.log(`    Last ${secondHalf.length} trades: ${secondHalf.filter(t=>t.won).length}W/${secondHalf.filter(t=>!t.won).length}L, PnL=$${secondHalf.reduce((s,t)=>s+t.pnl,0).toFixed(0)}, Avg stake=$${(secondHalf.reduce((s,t)=>s+t.stake_usd,0)/secondHalf.length).toFixed(0)}`);

// 6. EMA dist for early signals specifically
console.log('\n  6. EARLY SIGNALS (slope_accel) — DIST ANALYSIS:');
const earlySignals = parsed.filter(t => t.signalType === 'slope_accel');
for (const t of earlySignals) {
  const d = t.edist || t.dist || '?';
  console.log(`    #${t.id} ${t.side.toUpperCase()} dist=${typeof d === 'number' ? d.toFixed(1) : d} slope=${t.slope?.toFixed(1)||'?'} entry=${t.entry_price} ${t.won?'✅':'❌'} $${t.won?'+':''}${t.pnl.toFixed(0)}`);
}
