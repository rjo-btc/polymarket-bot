const positions = require('child_process').execSync('curl -s https://polymarket-bot-production-c26d.up.railway.app/api/positions').toString();
const trades = JSON.parse(positions).filter(t => t.status === 'resolved');

const caps = [75, 80, 85, 999]; // 999 = no cap

for (const cap of caps) {
  const label = cap === 999 ? 'No cap' : `RSI < ${cap}`;
  
  const filtered = trades.filter(t => {
    const rsiMatch = (t.entry_reason || '').match(/rsi=([.0-9]+)/i);
    const rsi = rsiMatch ? parseFloat(rsiMatch[1]) : 50;
    if (t.side === 'up' && rsi >= cap) return false;
    return true;
  });
  
  const blocked = trades.filter(t => {
    const rsiMatch = (t.entry_reason || '').match(/rsi=([.0-9]+)/i);
    const rsi = rsiMatch ? parseFloat(rsiMatch[1]) : 50;
    return t.side === 'up' && rsi >= cap;
  });
  
  const wins = filtered.filter(t => t.pnl > 0);
  const losses = filtered.filter(t => t.pnl < 0);
  const pnl = filtered.reduce((s, t) => s + t.pnl, 0);
  const blockedPnl = blocked.reduce((s, t) => s + t.pnl, 0);
  const blockedW = blocked.filter(t => t.pnl > 0).length;
  const blockedL = blocked.filter(t => t.pnl < 0).length;
  
  console.log(`\n=== ${label} ===`);
  console.log(`Trades: ${filtered.length} (${wins.length}W/${losses.length}L) | WR: ${(wins.length/filtered.length*100).toFixed(1)}%`);
  console.log(`PnL: $${pnl.toFixed(2)}`);
  console.log(`Blocked: ${blocked.length} trades (${blockedW}W/${blockedL}L) | Blocked PnL: $${blockedPnl.toFixed(2)}`);
  if (blocked.length > 0) {
    console.log(`Blocked trades:`);
    blocked.forEach(t => {
      const rsiMatch = (t.entry_reason || '').match(/rsi=([.0-9]+)/i);
      console.log(`  #${t.id} ${t.side} RSI=${rsiMatch?.[1]} pnl=$${t.pnl.toFixed(2)}`);
    });
  }
}

// Also check shorts with RSI floor (RSI > 20/25/30)
console.log('\n\n--- SHORT RSI FLOOR CHECK ---');
const floors = [20, 25, 30, 0];
for (const floor of floors) {
  const label = floor === 0 ? 'No floor' : `RSI > ${floor}`;
  const blocked = trades.filter(t => {
    const rsiMatch = (t.entry_reason || '').match(/rsi=([.0-9]+)/i);
    const rsi = rsiMatch ? parseFloat(rsiMatch[1]) : 50;
    return t.side === 'down' && rsi <= floor;
  });
  if (blocked.length > 0) {
    const blockedPnl = blocked.reduce((s, t) => s + t.pnl, 0);
    console.log(`${label}: would block ${blocked.length} shorts, PnL impact: $${blockedPnl.toFixed(2)}`);
  }
}
