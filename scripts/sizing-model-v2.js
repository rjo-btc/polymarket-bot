/**
 * Dynamic Sizing Model v2 — R:R-Aware
 * 
 * Key insight: cheap entries have higher execution cost % BUT much better R:R.
 * A 0.20 entry pays 5x on win. A 0.55 entry pays 0.8x. Different cost tolerances make sense.
 * 
 * Approach: max exec cost = f(entry_price R:R, time_to_end)
 *   - Cheap entries (high R:R): tolerate up to 15% exec cost
 *   - Mid entries: 8% target
 *   - Expensive entries: 5% target (thin margin)
 * 
 * Plus: hard cap on shares based on estimated book depth (never exceed 2x book)
 */

const positions = require('child_process').execSync('curl -s https://polymarket-bot-production-c26d.up.railway.app/api/positions').toString();
const allTrades = JSON.parse(positions).filter(t => t.status === 'resolved').sort((a, b) => a.id - b.id);

function estimateBookDepth(secsToEnd, entryPrice) {
  let priceMultiplier;
  if (entryPrice <= 0.15) priceMultiplier = 0.3;
  else if (entryPrice <= 0.25) priceMultiplier = 0.5;
  else if (entryPrice <= 0.35) priceMultiplier = 0.7;
  else if (entryPrice <= 0.50) priceMultiplier = 1.0;
  else if (entryPrice <= 0.65) priceMultiplier = 0.9;
  else if (entryPrice <= 0.75) priceMultiplier = 0.7;
  else priceMultiplier = 0.4;

  let timeMultiplier;
  if (secsToEnd >= 250) timeMultiplier = 1.0;
  else if (secsToEnd >= 200) timeMultiplier = 0.85;
  else if (secsToEnd >= 170) timeMultiplier = 0.70;
  else if (secsToEnd >= 150) timeMultiplier = 0.60;
  else timeMultiplier = 0.40;

  const baseDepth = 800;
  return Math.round(baseDepth * priceMultiplier * timeMultiplier);
}

function estimateExecCost(shares, bookDepth, entryPrice) {
  const spread = (entryPrice < 0.3 || entryPrice > 0.7) ? 0.04 : 0.02;
  const spreadCost = shares * (spread / 2);
  let marketImpact = 0;
  if (shares > bookDepth) {
    const tier1 = Math.min(shares - bookDepth, bookDepth);
    const tier2 = Math.max(0, shares - bookDepth * 2);
    marketImpact = tier1 * 0.01 + tier2 * 0.03;
  }
  const fillDelay = shares * 0.005;
  return { spreadCost, marketImpact, fillDelay, total: spreadCost + marketImpact + fillDelay };
}

// R:R aware exec cost tolerance
function getMaxExecCostPct(entryPrice) {
  // R:R = (1 - entryPrice) / entryPrice
  // 0.20 → R:R = 4.0 → tolerate 15%
  // 0.35 → R:R = 1.86 → tolerate 10%
  // 0.50 → R:R = 1.0 → tolerate 7%
  // 0.65 → R:R = 0.54 → tolerate 4%
  const rr = (1 - entryPrice) / entryPrice;
  if (rr >= 3.0) return 0.15;
  if (rr >= 1.5) return 0.10;
  if (rr >= 0.8) return 0.07;
  return 0.04;
}

function calcMaxStake(entryPrice, secsToEnd) {
  const bookDepth = estimateBookDepth(secsToEnd, entryPrice);
  const maxExecPct = getMaxExecCostPct(entryPrice);
  
  // Hard cap: never buy more than 2x estimated book depth in shares
  const maxSharesFromBook = bookDepth * 2;
  const maxStakeFromBook = maxSharesFromBook * entryPrice;
  
  // Binary search for max stake where exec cost < target %
  let lo = 10, hi = Math.min(5000, maxStakeFromBook);
  let bestStake = 10;
  
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const shares = mid / entryPrice;
    const exec = estimateExecCost(shares, bookDepth, entryPrice);
    const costPct = exec.total / mid;
    
    if (costPct <= maxExecPct && shares <= maxSharesFromBook) {
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
    maxExecPct: (maxExecPct * 100).toFixed(0) + '%',
    rr: ((1 - entryPrice) / entryPrice).toFixed(1),
  };
}

// === BACKTEST ===
console.log('═══════════════════════════════════════════════════════════════');
console.log('  DYNAMIC SIZING v2 (R:R-Aware) — Backtest Last 22 Trades');
console.log('═══════════════════════════════════════════════════════════════\n');

const last22 = allTrades.slice(-22);
let totalDynPnl = 0;
let totalDynExecCost = 0;
let cappedCount = 0;
let savedFromCapping = 0;

console.log('  #  | Entry | R:R | Secs | Book | Tol  | MaxStk | ActStk | DynStk | PaperPnL | DynPnL  | Flag');
console.log('─'.repeat(110));

for (const t of last22) {
  const sizing = calcMaxStake(t.entry_price, t.seconds_to_end_at_entry);
  const dynStake = Math.min(t.stake_usd, sizing.maxStake);
  const capped = dynStake < t.stake_usd;
  if (capped) cappedCount++;
  
  const dynShares = dynStake / t.entry_price;
  const won = t.pnl > 0;
  const dynPaperPnl = won ? (dynShares * 1 - dynStake) : -dynStake;
  const bookDepth = estimateBookDepth(t.seconds_to_end_at_entry, t.entry_price);
  const dynExec = estimateExecCost(dynShares, bookDepth, t.entry_price);
  const dynRealPnl = dynPaperPnl - dynExec.total;
  
  if (capped && !won) savedFromCapping += (t.stake_usd - dynStake);
  
  totalDynPnl += dynRealPnl;
  totalDynExecCost += dynExec.total;
  
  console.log(
    `  ${String(t.id).padStart(2)} | ${t.entry_price.toFixed(3)} | ${sizing.rr.padStart(3)} | ${String(t.seconds_to_end_at_entry).padStart(4)} | ${String(sizing.bookDepth).padStart(4)} | ${sizing.maxExecPct.padStart(4)} | $${String(sizing.maxStake).padStart(5)} | $${t.stake_usd.toFixed(0).padStart(5)} | $${dynStake.toFixed(0).padStart(5)} | ${(t.pnl>=0?'+':'')}$${t.pnl.toFixed(0).padStart(5)} | ${(dynRealPnl>=0?'+':'')}$${dynRealPnl.toFixed(0).padStart(5)} | ${capped ? '🔒' : ''}`
  );
}

console.log('\n');

// Comparison
console.log('═══════════════════════════════════════════════════════════════');
console.log('  COMPARISON: All Models');
console.log('═══════════════════════════════════════════════════════════════\n');

const models = [
  { name: 'Dynamic v2 (R:R-aware)', fn: (t) => { const s = calcMaxStake(t.entry_price, t.seconds_to_end_at_entry); return Math.min(t.stake_usd, s.maxStake); }},
  { name: 'Flat $200 cap', fn: (t) => Math.min(t.stake_usd, 200) },
  { name: 'Flat $300 cap', fn: (t) => Math.min(t.stake_usd, 300) },
  { name: 'Flat $500 cap', fn: (t) => Math.min(t.stake_usd, 500) },
  { name: 'No cap (paper)', fn: (t) => t.stake_usd },
];

for (const model of models) {
  let pnl = 0, execCost = 0, capped = 0;
  for (const t of last22) {
    const stake = model.fn(t);
    if (stake < t.stake_usd) capped++;
    const shares = stake / t.entry_price;
    const bookDepth = estimateBookDepth(t.seconds_to_end_at_entry, t.entry_price);
    const exec = estimateExecCost(shares, bookDepth, t.entry_price);
    const won = t.pnl > 0;
    pnl += (won ? (shares - stake) : -stake) - exec.total;
    execCost += exec.total;
  }
  console.log(`  ${model.name.padEnd(28)}: PnL = $${pnl.toFixed(0).padStart(6)} | Exec = $${execCost.toFixed(0).padStart(5)} | Cost% = ${(execCost/(pnl+execCost)*100).toFixed(1).padStart(5)}% | Capped: ${capped}`);
}

// Lookup table
console.log('\n\n═══════════════════════════════════════════════════════════════');
console.log('  MAX STAKE LOOKUP TABLE v2 (R:R-aware)');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('  Price | R:R | Tol  | 270s  | 240s  | 210s  | 180s  | 150s  |');
console.log('─'.repeat(70));
for (const price of [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65]) {
  const rr = ((1 - price) / price).toFixed(1);
  const tol = (getMaxExecCostPct(price) * 100).toFixed(0) + '%';
  const row = [270, 240, 210, 180, 150].map(s => {
    const r = calcMaxStake(price, s);
    return `$${String(r.maxStake).padStart(4)}`;
  });
  console.log(`  ${price.toFixed(2)}  | ${rr.padStart(3)} | ${tol.padStart(4)} | ${row.join(' | ')} |`);
}

console.log(`\n\nSaved from capping losing trades: $${savedFromCapping.toFixed(0)}`);
console.log(`Trades capped: ${cappedCount}/${last22.length}`);
