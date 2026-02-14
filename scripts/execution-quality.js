/**
 * Execution Quality Analysis
 * Estimates real-world impact of slippage, spread, and liquidity constraints
 * using the last 22 trades' actual share sizes and entry prices.
 */

const positions = require('child_process').execSync('curl -s https://polymarket-bot-production-c26d.up.railway.app/api/positions').toString();
const allTrades = JSON.parse(positions).filter(t => t.status === 'resolved').sort((a, b) => a.id - b.id);
const trades = allTrades.slice(-22); // last 22

// Polymarket 5m BTC market typical liquidity profile (estimated from observation)
// These are rough estimates — real book depth varies
const BOOK_DEPTH = {
  // Price level: typical shares available at that level
  // Thin markets (5m BTC up/down) have limited depth
  thinBook: 500,    // shares available at best bid/ask
  midBook: 2000,    // shares within 1-2 cents of mid
  deepBook: 5000,   // shares within 3-5 cents of mid
  typicalSpread: 0.02, // 2 cents typical spread
  wideSpread: 0.04,    // 4 cents when volatile
};

console.log('═══════════════════════════════════════════════════');
console.log('  EXECUTION QUALITY ANALYSIS — Last 22 Trades');
console.log('═══════════════════════════════════════════════════\n');

let totalSlippageCost = 0;
let totalSpreadCost = 0;
let totalLiquidityImpact = 0;
let totalPaperPnl = 0;
let totalRealPnl = 0;
let tradesWithLiquidityIssues = 0;

const results = [];

for (const t of trades) {
  const shares = t.shares;
  const stake = t.stake_usd;
  const entryPrice = t.entry_price;
  const won = t.pnl > 0;
  
  // 1. SPREAD COST
  // Paper trading gets mid-market price. Real trading pays the spread.
  // Estimated: half-spread on entry
  const spread = entryPrice < 0.3 || entryPrice > 0.7 ? BOOK_DEPTH.wideSpread : BOOK_DEPTH.typicalSpread;
  const halfSpread = spread / 2;
  const spreadCostPerShare = halfSpread;
  const spreadCost = shares * spreadCostPerShare;
  
  // 2. MARKET IMPACT (liquidity)
  // If shares > available at best price, we walk the book
  let marketImpact = 0;
  let liquidityFlag = '';
  
  if (shares <= BOOK_DEPTH.thinBook) {
    // Fits in top of book — minimal impact
    marketImpact = 0;
  } else if (shares <= BOOK_DEPTH.midBook) {
    // Takes out top of book, walks 1-2 cents deeper
    const overflow = shares - BOOK_DEPTH.thinBook;
    marketImpact = overflow * 0.01; // ~1 cent worse per share overflow
    liquidityFlag = '⚠️ walks book';
  } else if (shares <= BOOK_DEPTH.deepBook) {
    // Significant book impact
    const overflow1 = BOOK_DEPTH.midBook - BOOK_DEPTH.thinBook;
    const overflow2 = shares - BOOK_DEPTH.midBook;
    marketImpact = overflow1 * 0.01 + overflow2 * 0.02;
    liquidityFlag = '🔴 heavy impact';
    tradesWithLiquidityIssues++;
  } else {
    // Would exhaust available liquidity
    const overflow1 = BOOK_DEPTH.midBook - BOOK_DEPTH.thinBook;
    const overflow2 = BOOK_DEPTH.deepBook - BOOK_DEPTH.midBook;
    const overflow3 = shares - BOOK_DEPTH.deepBook;
    marketImpact = overflow1 * 0.01 + overflow2 * 0.02 + overflow3 * 0.05;
    liquidityFlag = '🚨 EXCEEDS LIQUIDITY';
    tradesWithLiquidityIssues++;
  }
  
  // 3. FILL DELAY SLIPPAGE
  // In paper trading, we get instant fill at displayed price.
  // Real trading: 200-500ms delay, price may move 0.5-1 cent
  const fillDelaySlippage = shares * 0.005; // ~0.5 cents per share
  
  // 4. TOTAL EXECUTION COST
  const totalExecCost = spreadCost + marketImpact + fillDelaySlippage;
  
  // 5. ADJUSTED PNL
  // On entry: we pay more (buy) or receive less (sell) by totalExecCost
  // On exit: binary resolution, no exit slippage (market resolves to 0 or 1)
  const realPnl = t.pnl - totalExecCost;
  
  totalSlippageCost += fillDelaySlippage;
  totalSpreadCost += spreadCost;
  totalLiquidityImpact += marketImpact;
  totalPaperPnl += t.pnl;
  totalRealPnl += realPnl;
  
  results.push({
    id: t.id,
    side: t.side,
    shares: Math.round(shares),
    stake: stake,
    entryPrice,
    paperPnl: t.pnl,
    spreadCost: parseFloat(spreadCost.toFixed(2)),
    marketImpact: parseFloat(marketImpact.toFixed(2)),
    fillDelay: parseFloat(fillDelaySlippage.toFixed(2)),
    totalExecCost: parseFloat(totalExecCost.toFixed(2)),
    realPnl: parseFloat(realPnl.toFixed(2)),
    won,
    liquidityFlag,
  });
}

// Print per-trade results
console.log('Per-Trade Breakdown:');
console.log('─────────────────────────────────────────────────────────────────────────');
console.log('  #  | Side | Shares | Stake    | Spread | Impact | Delay  | Total Cost | Paper PnL  | Real PnL   | Flag');
console.log('─────────────────────────────────────────────────────────────────────────');

for (const r of results) {
  const flag = r.liquidityFlag || '';
  console.log(
    `  ${String(r.id).padStart(2)} | ${r.side.padEnd(4)} | ${String(r.shares).padStart(6)} | $${r.stake.toFixed(0).padStart(6)} | $${r.spreadCost.toFixed(1).padStart(5)} | $${r.marketImpact.toFixed(1).padStart(5)} | $${r.fillDelay.toFixed(1).padStart(5)} | $${r.totalExecCost.toFixed(1).padStart(9)} | ${(r.paperPnl >= 0 ? '+' : '') + '$' + r.paperPnl.toFixed(0).padStart(6)} | ${(r.realPnl >= 0 ? '+' : '') + '$' + r.realPnl.toFixed(0).padStart(6)} | ${flag}`
  );
}

console.log('\n\n═══════════════════════════════════════════════════');
console.log('  SUMMARY');
console.log('═══════════════════════════════════════════════════\n');

const totalExecCost = totalSpreadCost + totalLiquidityImpact + totalSlippageCost;

console.log(`Paper PnL:           $${totalPaperPnl.toFixed(2)}`);
console.log(`Estimated Real PnL:  $${totalRealPnl.toFixed(2)}`);
console.log(`Total Exec Cost:     -$${totalExecCost.toFixed(2)} (${(totalExecCost/totalPaperPnl*100).toFixed(1)}% of paper PnL)`);
console.log('');
console.log(`  Spread cost:       -$${totalSpreadCost.toFixed(2)} (${(totalSpreadCost/totalExecCost*100).toFixed(0)}% of exec cost)`);
console.log(`  Market impact:     -$${totalLiquidityImpact.toFixed(2)} (${(totalLiquidityImpact/totalExecCost*100).toFixed(0)}% of exec cost)`);
console.log(`  Fill delay:        -$${totalSlippageCost.toFixed(2)} (${(totalSlippageCost/totalExecCost*100).toFixed(0)}% of exec cost)`);

console.log(`\nTrades with liquidity issues: ${tradesWithLiquidityIssues}/${trades.length}`);

// Wins that would flip to losses
const flipped = results.filter(r => r.paperPnl > 0 && r.realPnl <= 0);
console.log(`Wins that flip to losses: ${flipped.length}`);
if (flipped.length > 0) {
  flipped.forEach(r => console.log(`  #${r.id}: paper +$${r.paperPnl.toFixed(0)} → real -$${Math.abs(r.realPnl).toFixed(0)}`));
}

// Size analysis
console.log('\n\n═══════════════════════════════════════════════════');
console.log('  SIZE vs LIQUIDITY');
console.log('═══════════════════════════════════════════════════\n');

const sharesBuckets = [
  { label: '≤500 shares', min: 0, max: 500 },
  { label: '500-1000', min: 500, max: 1000 },
  { label: '1000-2000', min: 1000, max: 2000 },
  { label: '2000-3000', min: 2000, max: 3000 },
  { label: '3000+', min: 3000, max: Infinity },
];

for (const b of sharesBuckets) {
  const bucket = results.filter(r => r.shares >= b.min && r.shares < b.max);
  if (bucket.length === 0) continue;
  const avgCost = bucket.reduce((s, r) => s + r.totalExecCost, 0) / bucket.length;
  const avgCostPct = bucket.reduce((s, r) => s + r.totalExecCost / r.stake * 100, 0) / bucket.length;
  const issues = bucket.filter(r => r.liquidityFlag).length;
  console.log(`  ${b.label.padEnd(12)}: ${bucket.length} trades | Avg exec cost: $${avgCost.toFixed(1)} (${avgCostPct.toFixed(1)}% of stake) | Liquidity issues: ${issues}`);
}

// Max safe position size recommendation
console.log('\n\n═══════════════════════════════════════════════════');
console.log('  RECOMMENDED MAX POSITION SIZE');
console.log('═══════════════════════════════════════════════════\n');

// At different entry prices, how many shares = $X
for (const maxStake of [100, 200, 500, 750]) {
  const atCheap = Math.round(maxStake / 0.25);
  const atMid = Math.round(maxStake / 0.45);
  const atExp = Math.round(maxStake / 0.60);
  const cheapFlag = atCheap > BOOK_DEPTH.midBook ? '🔴' : atCheap > BOOK_DEPTH.thinBook ? '⚠️' : '✅';
  const midFlag = atMid > BOOK_DEPTH.midBook ? '🔴' : atMid > BOOK_DEPTH.thinBook ? '⚠️' : '✅';
  console.log(`  $${maxStake} stake: ${atCheap} shares @ 0.25 ${cheapFlag} | ${atMid} shares @ 0.45 ${midFlag} | ${atExp} shares @ 0.60 ✅`);
}
