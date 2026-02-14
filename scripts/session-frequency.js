/**
 * Session Strategy Frequency Analysis
 * How often do session edges occur and how often would they fire?
 */

const SESSION_EDGES = [
  { name: 'Asia Open', hour: 20, minute: 0 },
  { name: 'Asia Close', hour: 4, minute: 0 },
  { name: 'London Open', hour: 3, minute: 0 },
  { name: 'London Close', hour: 11, minute: 30 },
  { name: 'NY Open', hour: 9, minute: 30 },
  { name: 'NY Close', hour: 16, minute: 0 },
];

console.log('═══════════════════════════════════════════════════');
console.log('  SESSION STRATEGY — Frequency Analysis');
console.log('═══════════════════════════════════════════════════\n');

console.log('Session edges (ET):');
for (const e of SESSION_EDGES) {
  const h = String(e.hour).padStart(2, '0');
  const m = String(e.minute).padStart(2, '0');
  // ±15 min window
  console.log(`  ${e.name}: ${h}:${m} ET (active window: ${h}:${String(Math.max(0, e.minute - 15)).padStart(2, '0')}-${h}:${String(e.minute + 15).padStart(2, '0')})`);
}

console.log('\n\nEntry requirements:');
console.log('  1. Within ±15 min of a session edge');
console.log('  2. Entry window: 90-180s before market end');
console.log('  3. Volume expansion: 1m vol > 5m avg vol × 1.2');
console.log('  4. ATR expansion: ATR(3) > ATR(8) × 1.1');
console.log('  5. Price confirmation: close > prev close (long) or < (short)');

console.log('\n\n═══════════════════════════════════════════════════');
console.log('  EXPECTED FREQUENCY');
console.log('═══════════════════════════════════════════════════\n');

// Each session edge has a ±15 min window = 30 min window
// In 30 min, there are 6 five-minute markets
// Entry window is 90-180s, so ~1.5 min per 5-min market
// That's roughly 6 opportunities per session edge
const edgesPerDay = SESSION_EDGES.length;
const marketsPerEdge = 6; // 30 min / 5 min
const totalOpportunities = edgesPerDay * marketsPerEdge;

console.log(`Session edges per day: ${edgesPerDay}`);
console.log(`5-min markets per edge window: ${marketsPerEdge}`);
console.log(`Total opportunities per day: ${totalOpportunities}`);
console.log('');

// But needs vol expand + ATR expand + confirmation
// Vol expansion (>1.2x) happens maybe 30-40% of the time at session opens
// ATR expansion at session opens: maybe 50-60% (volatility picks up)
// Price confirmation: ~50% (up or down)
// Combined probability: ~10-15% per market
const fireRate = 0.12;
const expectedTradesPerDay = totalOpportunities * fireRate;

console.log('Filter pass rates (estimated):');
console.log('  Vol expansion (>1.2x avg): ~30-40%');
console.log('  ATR expansion (ATR3 > ATR8×1.1): ~50-60%');
console.log('  Price confirmation: ~50%');
console.log(`  Combined: ~${(fireRate*100).toFixed(0)}% per opportunity`);
console.log(`\nExpected session trades per day: ${expectedTradesPerDay.toFixed(1)}`);

// Check actual decisions from the bot
console.log('\n\n═══════════════════════════════════════════════════');
console.log('  ACTUAL DATA — Session Strategy Decisions');
console.log('═══════════════════════════════════════════════════\n');

try {
  const decisions = require('child_process').execSync(
    'curl -s https://polymarket-bot-production-c26d.up.railway.app/api/decisions'
  ).toString();
  const data = JSON.parse(decisions);
  const sessionDecisions = (Array.isArray(data) ? data : data.decisions || [])
    .filter(d => d.strategy === 'session');
  
  const enters = sessionDecisions.filter(d => d.action === 'ENTER');
  const skips = sessionDecisions.filter(d => d.action === 'SKIP');
  const activeSkips = skips.filter(d => d.reason && d.reason.includes('active but no PA'));
  const offSkips = skips.filter(d => d.reason && (d.reason.includes('No session edge') || d.reason.includes('Outside entry')));
  
  console.log(`Total session decisions logged: ${sessionDecisions.length}`);
  console.log(`  ENTER signals: ${enters.length}`);
  console.log(`  Active but no confirmation: ${activeSkips.length}`);
  console.log(`  No session edge / outside window: ${offSkips.length}`);
  
  if (enters.length > 0) {
    console.log('\nENTER signals:');
    enters.forEach(d => console.log(`  ${d.last_checked_at} — ${d.reason?.substring(0, 80)}`));
  }
  if (activeSkips.length > 0) {
    console.log(`\nNear-misses (session active, PA didn't confirm): ${activeSkips.length}`);
    activeSkips.slice(-5).forEach(d => console.log(`  ${d.last_checked_at} — ${d.reason?.substring(0, 100)}`));
  }
} catch (e) {
  console.log('Could not fetch decisions:', e.message);
}

// Session edge timing in PST for Ryan
console.log('\n\n═══════════════════════════════════════════════════');
console.log('  SESSION EDGES IN PST (for reference)');
console.log('═══════════════════════════════════════════════════\n');

for (const e of SESSION_EDGES) {
  // ET to PST = -3 hours
  let pstHour = e.hour - 3;
  if (pstHour < 0) pstHour += 24;
  const pstStr = `${String(pstHour).padStart(2, '0')}:${String(e.minute).padStart(2, '0')} PST`;
  const etStr = `${String(e.hour).padStart(2, '0')}:${String(e.minute).padStart(2, '0')} ET`;
  console.log(`  ${e.name.padEnd(15)} ${etStr}  →  ${pstStr}`);
}
