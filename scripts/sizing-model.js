/**
 * Dynamic Position Sizing Model
 * 
 * Goal: maximize stake while keeping estimated execution cost < target % of stake
 * 
 * Variables:
 *   - entry_price: determines shares/dollar (cheap = more shares = more book pressure)
 *   - seconds_to_end: markets closer to expiry have thinner books
 *   - side: up/down may have different liquidity profiles
 * 
 * Constraints:
 *   - Max execution cost: 5% of stake (configurable)
 *   - Never exceed Kelly/confidence sizing
 *   - Hard floor: $10 min stake
 */

const positions = require('child_process').execSync('curl -s https://polymarket-bot-production-c26d.up.railway.app/api/positions').toString();
const allTrades = JSON.parse(positions).filter(t => t.status === 'resolved').sort((a, b) => a.id - b.id);

// Polymarket 5m BTC book depth model (estimated)
// Book depth scales with time remaining — more time = more interest = deeper books
function estimateBookDepth(secsToEnd, entryPrice) {
  // Base depth at different price levels (shares available)
  // Extreme prices (< 0.20 or > 0.80) have thinner books
  // Mid prices (0.40-0.60) have deepest books
  let priceMultiplier;
  if (entryPrice <= 0.15) priceMultiplier = 0.3;
  else if (entryPrice <= 0.25) priceMultiplier = 0.5;
  else if (entryPrice <= 0.35) priceMultiplier = 0.7;
  else if (entryPrice <= 0.50) priceMultiplier = 1.0;
  else if (entryPrice <= 0.65) priceMultiplier = 0.9;
  else if (entryPrice <= 0.75) priceMultiplier = 0.7;
  else priceMultiplier = 0.4;

  // Time multiplier: earlier in market = thicker books
  // At 270s (4.5 min before end): full depth
  // At 150s (2.5 min): ~70% depth
  // At 90s: ~40% depth
  let timeMultiplier;
  if (secsToEnd >= 250) timeMultiplier = 1.0;
  else if (secsToEnd >= 200) timeMultiplier = 0.85;
  else if (secsToEnd >= 170) timeMultiplier = 0.70;
  else if (secsToEnd >= 150) timeMultiplier = 0.60;
  else timeMultiplier = 0.40;

  // Base book depth: ~800 shares at best bid/ask for a typical 5m BTC market
  const baseDepth = 800;
  return Math.round(baseDepth * priceMultiplier * timeMultiplier);
}

// Estimate execution cost for a given number of shares and book depth
function estimateExecCost(shares, bookDepth, entryPrice) {
  // Spread cost: half-spread per share
  const spread = (entryPrice < 0.3 || entryPrice > 0.7) ? 0.04 : 0.02;
  const spreadCost = shares * (spread / 2);

  // Market impact: if shares > book depth, we walk the book
  let marketImpact = 0;
  if (shares > bookDepth) {
    const tier1 = Math.min(shares - bookDepth, bookDepth); // next tier = same size
    const tier2 = Math.max(0, shares - bookDepth * 2);
    marketImpact = tier1 * 0.01 + tier2 * 0.03;
  }

  // Fill delay: ~0.5 cents per share
  const fillDelay = shares * 0.005;

  return { spreadCost, marketImpact, fillDelay, total: spreadCost + marketImpact + fillDelay };
}

// Calculate max stake given constraints
function calcMaxStake(entryPrice, secsToEnd, maxExecCostPct = 0.05) {
  const bookDepth = estimateBookDepth(secsToEnd, entryPrice);
  
  // Binary search for max stake where exec cost < target %
  let lo = 10, hi = 5000;
  let bestStake = 10;
  
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const shares = mid / entryPrice;
    const exec = estimateExecCost(shares, bookDepth, entryPrice);
    const costPct = exec.total / mid;
    
    if (costPct <= maxExecCostPct) {
      bestStake = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  
  return {
    maxStake: Math.round(bestStake),
    maxShares: Math.round(bestStake / entryPrice),
    bookDepth,
    execCostAtMax: estimateExecCost(Math.round(bestStake / entryPrice), bookDepth, entryPrice),
  };
}

// === BACKTEST: Apply dynamic sizing to last 22 trades ===
console.log('═══════════════════════════════════════════════════════════════');
console.log('  DYNAMIC SIZING MODEL — Backtest on Last 22 Trades');
console.log('═══════════════════════════════════════════════════════════════\n');

const last22 = allTrades.slice(-22);
let totalPaperPnl = 0;
let totalDynPnl = 0;
let totalDynExecCost = 0;

console.log('  #  | Entry | Secs | Book | MaxStake | ActStake | DynStake | Paper PnL | Dyn PnL  | Exec Cost | Cap?');
console.log('─'.repeat(110));

for (const t of last22) {
  const sizing = calcMaxStake(t.entry_price, t.seconds_to_end_at_entry);
  const actualStake = t.stake_usd;
  const dynStake = Math.min(actualStake, sizing.maxStake); // cap at dynamic max
  const capped = dynStake < actualStake;
  
  // Recalculate PnL with dynamic stake
  const dynShares = dynStake / t.entry_price;
  const won = t.pnl > 0;
  const dynPaperPnl = won ? (dynShares * 1 - dynStake) : -dynStake;
  
  // Execution cost at dynamic size
  const dynExec = estimateExecCost(dynShares, sizing.bookDepth, t.entry_price);
  const dynRealPnl = dynPaperPnl - dynExec.total;
  
  totalPaperPnl += t.pnl;
  totalDynPnl += dynRealPnl;
  totalDynExecCost += dynExec.total;
  
  console.log(
    `  ${String(t.id).padStart(2)} | ${t.entry_price.toFixed(3)} | ${String(t.seconds_to_end_at_entry).padStart(4)} | ${String(sizing.bookDepth).padStart(4)} | $${String(sizing.maxStake).padStart(5)} | $${actualStake.toFixed(0).padStart(5)} | $${dynStake.toFixed(0).padStart(5)} | ${(t.pnl>=0?'+':'')}$${t.pnl.toFixed(0).padStart(5)} | ${(dynRealPnl>=0?'+':'')}$${dynRealPnl.toFixed(0).padStart(5)} | $${dynExec.total.toFixed(1).padStart(5)} | ${capped ? '🔒 CAPPED' : ''}`
  );
}

console.log('\n');
console.log(`Paper PnL (actual sizing):    $${totalPaperPnl.toFixed(0)}`);
console.log(`Dynamic PnL (after exec):     $${totalDynPnl.toFixed(0)}`);
console.log(`Total exec cost (dynamic):    $${totalDynExecCost.toFixed(0)}`);
console.log(`Exec cost % of gross:         ${(totalDynExecCost / (totalDynPnl + totalDynExecCost) * 100).toFixed(1)}%`);

// Compare: what if we just capped at flat $200, $300, $500
console.log('\n\n═══════════════════════════════════════════════════════════════');
console.log('  COMPARISON: Dynamic vs Flat Caps');
console.log('═══════════════════════════════════════════════════════════════\n');

for (const cap of ['dynamic', 200, 300, 500, 'none']) {
  let pnl = 0;
  let execCost = 0;
  
  for (const t of last22) {
    let stake;
    if (cap === 'dynamic') {
      const s = calcMaxStake(t.entry_price, t.seconds_to_end_at_entry);
      stake = Math.min(t.stake_usd, s.maxStake);
    } else if (cap === 'none') {
      stake = t.stake_usd;
    } else {
      stake = Math.min(t.stake_usd, cap);
    }
    
    const shares = stake / t.entry_price;
    const bookDepth = estimateBookDepth(t.seconds_to_end_at_entry, t.entry_price);
    const exec = estimateExecCost(shares, bookDepth, t.entry_price);
    const won = t.pnl > 0;
    const paperPnl = won ? (shares * 1 - stake) : -stake;
    pnl += paperPnl - exec.total;
    execCost += exec.total;
  }
  
  const label = cap === 'dynamic' ? 'Dynamic (5% target)' : cap === 'none' ? 'No cap (actual)' : `Flat $${cap} cap`;
  console.log(`  ${label.padEnd(25)}: Net PnL = $${pnl.toFixed(0).padStart(6)} | Exec cost = $${execCost.toFixed(0).padStart(5)} | Cost % = ${(execCost/(pnl+execCost)*100).toFixed(1)}%`);
}

// Print the sizing table for reference
console.log('\n\n═══════════════════════════════════════════════════════════════');
console.log('  MAX STAKE LOOKUP TABLE (5% exec cost target)');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('         | 270s  | 240s  | 210s  | 180s  | 150s  |');
console.log('─'.repeat(60));
for (const price of [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65]) {
  const row = [270, 240, 210, 180, 150].map(s => {
    const r = calcMaxStake(price, s);
    return `$${String(r.maxStake).padStart(4)}`;
  });
  console.log(`  ${price.toFixed(2)}   | ${row.join(' | ')} |`);
}
