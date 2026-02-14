#!/usr/bin/env node
/**
 * Backtest: Entry price impact on overall performance.
 * 
 * On Polymarket binary markets:
 * - Loss = always -stake (100% loss regardless of entry price)
 * - Win = shares * $1.00 - stake = stake * (1/entry - 1)
 * - Cheaper entry = BIGGER wins on wins, SAME losses on losses
 * - Also: cheaper entry = earlier signal = more time for BTC to move
 * 
 * This script simulates: what if we capped max entry at different levels?
 * Trades that entered above the cap would either:
 *   A) Not have been taken (skip expensive entries)
 *   B) Entered at the cap price (earlier signal, same direction)
 */

const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function main() {
  const positions = await fetch('https://polymarket-bot-production-c26d.up.railway.app/api/positions');
  const resolved = positions.filter(p => p.status === 'resolved').sort((a,b) => a.id - b.id);
  
  console.log(`\n📊 Entry Price Impact Analysis — ${resolved.length} trades\n`);
  console.log('='.repeat(70));
  
  // Current performance
  const totalPnl = resolved.reduce((s,p) => s + p.pnl, 0);
  const wins = resolved.filter(p => p.pnl > 0);
  const losses = resolved.filter(p => p.pnl < 0);
  console.log(`\nActual performance: ${wins.length}W/${losses.length}L (${(wins.length/resolved.length*100).toFixed(1)}% WR)`);
  console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
  console.log(`Avg win: $${wins.length ? (wins.reduce((s,p)=>s+p.pnl,0)/wins.length).toFixed(2) : 0}`);
  console.log(`Avg loss: $${losses.length ? (losses.reduce((s,p)=>s+p.pnl,0)/losses.length).toFixed(2) : 0}`);

  // Entry price distribution  
  console.log(`\n${'='.repeat(70)}`);
  console.log('\n📈 Entry Price Distribution:\n');
  const brackets = [0.25, 0.35, 0.45, 0.55, 0.65, 1.0];
  let prev = 0;
  for (const b of brackets) {
    const inBracket = resolved.filter(p => p.entry_price > prev && p.entry_price <= b);
    const w = inBracket.filter(p => p.pnl > 0).length;
    const l = inBracket.filter(p => p.pnl < 0).length;
    const pnl = inBracket.reduce((s,p) => s + p.pnl, 0);
    const avgRR = inBracket.length ? inBracket.reduce((s,p) => s + (1-p.entry_price)/p.entry_price, 0) / inBracket.length : 0;
    if (inBracket.length > 0) {
      console.log(`  ${(prev+0.01).toFixed(2)}-${b.toFixed(2)}: ${inBracket.length} trades | ${w}W/${l}L (${(w/inBracket.length*100).toFixed(0)}%) | PnL: $${pnl.toFixed(2)} | Avg R:R: ${avgRR.toFixed(1)}x`);
    }
    prev = b;
  }

  // === Scenario A: Cap max entry at different levels ===
  console.log(`\n${'='.repeat(70)}`);
  console.log('\n🔬 SCENARIO A: Skip trades above entry cap\n');
  console.log('(Trades above cap are simply not taken)\n');
  
  for (const cap of [0.35, 0.40, 0.45, 0.50, 0.55, 0.65]) {
    const eligible = resolved.filter(p => p.entry_price <= cap);
    const w = eligible.filter(p => p.pnl > 0).length;
    const l = eligible.filter(p => p.pnl < 0).length;
    const pnl = eligible.reduce((s,p) => s + p.pnl, 0);
    const skipped = resolved.length - eligible.length;
    const skippedWins = resolved.filter(p => p.entry_price > cap && p.pnl > 0).length;
    const skippedLosses = resolved.filter(p => p.entry_price > cap && p.pnl < 0).length;
    console.log(`  Cap ≤${cap}: ${eligible.length} trades (skip ${skipped}: ${skippedWins}W/${skippedLosses}L) | ${w}W/${l}L (${eligible.length ? (w/eligible.length*100).toFixed(0) : 0}%) | PnL: $${pnl.toFixed(2)} | vs actual: ${pnl - totalPnl >= 0 ? '+' : ''}$${(pnl - totalPnl).toFixed(2)}`);
  }

  // === Scenario B: What if expensive entries had been cheaper? ===
  console.log(`\n${'='.repeat(70)}`);
  console.log('\n🔬 SCENARIO B: Force cheaper entries (same trades, lower price)\n');
  console.log('(Wins get bigger payout at cheaper price, losses stay same stake)\n');

  for (const forceCap of [0.35, 0.40, 0.45]) {
    let hypoPnl = 0;
    let hypoWins = 0;
    let hypoLosses = 0;
    
    for (const p of resolved) {
      const effectiveEntry = Math.min(p.entry_price, forceCap);
      const shares = p.stake_usd / effectiveEntry;
      
      if (p.pnl > 0) {
        // Win: payout = shares * $1 - stake
        const payout = shares * 1.0 - p.stake_usd;
        hypoPnl += payout;
        hypoWins++;
      } else {
        // Loss: always -stake
        hypoPnl -= p.stake_usd;
        hypoLosses++;
      }
    }
    
    console.log(`  Force cap ${forceCap}: ${resolved.length} trades | ${hypoWins}W/${hypoLosses}L | PnL: $${hypoPnl.toFixed(2)} | vs actual: ${hypoPnl - totalPnl >= 0 ? '+' : ''}$${(hypoPnl - totalPnl).toFixed(2)}`);
  }

  // === Per-trade breakdown for recent expensive entries ===
  console.log(`\n${'='.repeat(70)}`);
  console.log('\n📋 Recent expensive entries (≥0.45) detail:\n');
  
  const expensive = resolved.filter(p => p.entry_price >= 0.45).sort((a,b) => b.id - a.id).slice(0, 10);
  for (const p of expensive) {
    const rr = ((1 - p.entry_price) / p.entry_price).toFixed(1);
    const btcMove = ((p.btc_price_at_end - p.btc_price_at_start) / p.btc_price_at_start * 10000).toFixed(1);
    const result = p.pnl > 0 ? '✅ WIN' : '❌ LOSS';
    
    // What would PnL be at 0.35 entry?
    let hypoNote = '';
    if (p.pnl > 0) {
      const hypoShares = p.stake_usd / 0.35;
      const hypoPnl = hypoShares * 1.0 - p.stake_usd;
      hypoNote = ` → at 0.35: $${hypoPnl.toFixed(2)} (+$${(hypoPnl - p.pnl).toFixed(2)})`;
    }
    
    console.log(`  #${p.id} ${p.side} @ ${p.entry_price} | ${result} $${p.pnl.toFixed(2)} | R:R ${rr}x | BTC ${btcMove} bps${hypoNote}`);
  }

  // === Key insight ===
  console.log(`\n${'='.repeat(70)}`);
  console.log('\n💡 KEY INSIGHT:\n');
  
  const cheapWins = resolved.filter(p => p.entry_price <= 0.40 && p.pnl > 0);
  const expensiveWins = resolved.filter(p => p.entry_price > 0.40 && p.pnl > 0);
  const avgCheapWin = cheapWins.length ? cheapWins.reduce((s,p) => s + p.pnl, 0) / cheapWins.length : 0;
  const avgExpensiveWin = expensiveWins.length ? expensiveWins.reduce((s,p) => s + p.pnl, 0) / expensiveWins.length : 0;
  
  console.log(`  Cheap entries (≤0.40): avg win = $${avgCheapWin.toFixed(2)}, ${cheapWins.length} wins`);
  console.log(`  Expensive entries (>0.40): avg win = $${avgExpensiveWin.toFixed(2)}, ${expensiveWins.length} wins`);
  console.log(`  Cheap wins are ${avgCheapWin && avgExpensiveWin ? (avgCheapWin/avgExpensiveWin).toFixed(1) : '?'}x bigger than expensive wins`);
  console.log(`  But losses are the same size regardless of entry price`);
  console.log(`  → Cheaper entries = asymmetric edge (bigger wins, same losses)\n`);
}

main().catch(console.error);
