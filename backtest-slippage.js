/**
 * Slippage, Liquidity & Realistic Execution Simulation
 * 
 * Models real-world Polymarket conditions:
 * 1. Bid-ask spread: 5-min markets have wide spreads (1-5 cents typical)
 * 2. Slippage: market orders move price, especially on thin books
 * 3. Liquidity depth: small markets may not fill full size at quoted price
 * 4. Partial fills: large orders relative to book depth get worse avg price
 * 5. Timing lag: signal → execution has network + processing delay (1-3s)
 * 6. Price impact: our buy moves the market price against us
 * 
 * Based on observed Polymarket 5-min BTC market characteristics:
 * - Typical liquidity: $500-$5000 per side on 5-min markets
 * - Typical spread: $0.01-$0.05 (1-5 cents)
 * - Markets are more liquid near 50/50 (close to market open)
 * - Markets get thin as they approach expiry (last 60s)
 * - Momentum markets have wider spreads (market makers pull quotes)
 */

const { fetchKlines } = require('./src/btcPrice');

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i - 1] * (1 - k));
  return ema;
}

function calcRSI(closes, period) {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

// Model Polymarket order book conditions
function modelExecution(idealEntry, positionSizeUsd, secsToEnd, momentum) {
  // 1. BASE SPREAD: 5-min markets typically have 1-3 cent spread
  // Wider spread when: closer to expiry, higher momentum, further from 50/50
  const distFrom50 = Math.abs(idealEntry - 0.50);
  const expiryFactor = Math.max(0, 1 - secsToEnd / 300); // 0 at 300s, 1 at 0s
  const momentumFactor = Math.min(1, momentum / 20); // normalized momentum
  
  const baseSpread = 0.01 + distFrom50 * 0.04 + expiryFactor * 0.03 + momentumFactor * 0.02;
  // We're buying so we pay the ask = mid + half spread
  const spreadCost = baseSpread / 2;
  
  // 2. LIQUIDITY DEPTH: typical $500-$5000 available at best ask
  // More liquid near 50/50, less liquid at extremes
  const baseLiquidity = 2000; // base $ at best ask
  const liquidityAtPrice = baseLiquidity * (1 - distFrom50 * 2) * (1 - expiryFactor * 0.5);
  
  // 3. PRICE IMPACT / SLIPPAGE: if our order > available liquidity, we walk the book
  const fillRatio = positionSizeUsd / Math.max(100, liquidityAtPrice);
  let slippage = 0;
  if (fillRatio > 1) {
    // Walking the book: each level is ~1-2 cents worse
    slippage = (fillRatio - 1) * 0.02;
  } else if (fillRatio > 0.5) {
    // Partial book impact
    slippage = (fillRatio - 0.5) * 0.01;
  }
  
  // 4. TIMING LAG: signal detection → order submission → fill = 1-3 seconds
  // During high momentum, price can move 0.5-2 cents in that time
  const timingSlippage = momentumFactor * 0.015 * (0.5 + Math.random());
  
  // 5. TOTAL EXECUTION COST
  const totalSlippage = spreadCost + slippage + timingSlippage;
  const executedEntry = Math.min(0.85, idealEntry + totalSlippage);
  
  return {
    idealEntry,
    executedEntry: parseFloat(executedEntry.toFixed(4)),
    spreadCost: parseFloat(spreadCost.toFixed(4)),
    slippage: parseFloat(slippage.toFixed(4)),
    timingSlippage: parseFloat(timingSlippage.toFixed(4)),
    totalSlippage: parseFloat(totalSlippage.toFixed(4)),
    liquidityAtPrice: Math.round(liquidityAtPrice),
    fillRatio: parseFloat(fillRatio.toFixed(3)),
  };
}

async function run() {
  console.log('Fetching klines...');
  const klines = await fetchKlines(1000);
  console.log(`Got ${klines.length} candles\n`);
  
  const closes = klines.map(k => k.close);
  const ema9 = calcEMA(closes, 9);
  const ema200 = calcEMA(closes, 200);
  const rsi14 = calcRSI(closes, 14);
  
  // Test at different position sizes
  const positionSizes = [50, 100, 200, 500];
  
  for (const posSize of positionSizes) {
    let totalTrades = 0, totalWins = 0;
    let idealPnl = 0, realPnl = 0;
    let totalSlippage = 0;
    let idealEntrySum = 0, realEntrySum = 0;
    const slippageBuckets = { spread: 0, impact: 0, timing: 0 };
    
    for (let i = 210; i < closes.length - 1; i++) {
      const price = closes[i];
      const fast = ema9[i], slow = ema200[i];
      const slope = fast - ema9[i-1];
      const slopeAbs = Math.abs(slope);
      const dist = Math.abs(((fast - slow) / slow) * 10000);
      const rsi = rsi14[i];
      
      // Generate signal (simplified v3.1)
      let side = null, timing = 'standard';
      
      // Early: momentum burst
      const body = closes[i] - klines[i].open;
      const bodyBps = Math.abs(body / klines[i].open * 10000);
      const range = klines[i].high - klines[i].low;
      const bodyRatio = range > 0 ? Math.abs(body) / range : 0;
      const emaDist = ((fast - slow) / slow) * 10000;
      
      if (bodyBps >= 5 && bodyRatio >= 0.7) {
        if (body > 0 && emaDist > -3 && rsi > 45) { side = 'up'; timing = 'early'; }
        else if (body < 0 && emaDist < 3 && rsi < 55) { side = 'down'; timing = 'early'; }
      }
      
      // Early: slope accel
      if (!side && i > 2) {
        const slopePrev = ema9[i-1] - ema9[i-2];
        const accel = Math.abs(slope) - Math.abs(slopePrev);
        if (accel > 0 && slopeAbs >= 1) {
          if (slope > 0 && fast > slow && rsi > 45) { side = 'up'; timing = 'early'; }
          else if (slope < 0 && fast < slow && rsi < 55) { side = 'down'; timing = 'early'; }
        }
      }
      
      // Standard
      if (!side && dist >= 5 && slopeAbs >= 2) {
        if (price > fast && fast > slow && slope > 0 && rsi > 50 && dist >= 8 && slopeAbs >= 6) side = 'up';
        else if (price < fast && fast < slow && slope < 0 && rsi < 50) {
          const inDead = (dist >= 5 && dist < 8) && (slopeAbs >= 3 && slopeAbs < 6);
          if (!inDead) side = 'down';
        }
      }
      
      if (!side) continue;
      
      // Ideal entry (momentum-based)
      const lookback5 = closes[Math.max(0, i - 5)];
      const recentMoveBps = ((closes[i] - lookback5) / lookback5) * 10000;
      const absMove = Math.abs(recentMoveBps);
      const dirCorrect = (side === 'up' && recentMoveBps > 0) || (side === 'down' && recentMoveBps < 0);
      const premium = dirCorrect ? Math.min(0.15, absMove * 0.005) : -Math.min(0.10, absMove * 0.003);
      const timeDiscount = timing === 'early' ? -0.06 : 0;
      const idealEntry = Math.min(0.65, Math.max(0.20, 0.50 + premium + timeDiscount));
      
      // Simulate realistic execution
      const secsToEnd = timing === 'early' ? 250 : 180;
      const exec = modelExecution(idealEntry, posSize, secsToEnd, absMove);
      
      if (exec.executedEntry > 0.65) continue; // filtered by max entry after slippage
      
      // Resolution
      const nextClose = closes[i + 1];
      const won = (side === 'up' && nextClose > closes[i]) || (side === 'down' && nextClose < closes[i]);
      
      totalTrades++;
      if (won) totalWins++;
      
      // P&L calculation
      const idealWinPnl = posSize * (1 - idealEntry) / idealEntry;
      const realWinPnl = posSize * (1 - exec.executedEntry) / exec.executedEntry;
      
      idealPnl += won ? idealWinPnl : -posSize;
      realPnl += won ? realWinPnl : -posSize;
      totalSlippage += exec.totalSlippage * posSize;
      idealEntrySum += idealEntry;
      realEntrySum += exec.executedEntry;
      slippageBuckets.spread += exec.spreadCost;
      slippageBuckets.impact += exec.slippage;
      slippageBuckets.timing += exec.timingSlippage;
    }
    
    const wr = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;
    const avgIdealEntry = totalTrades > 0 ? idealEntrySum / totalTrades : 0;
    const avgRealEntry = totalTrades > 0 ? realEntrySum / totalTrades : 0;
    const avgSlippageCents = totalTrades > 0 ? (avgRealEntry - avgIdealEntry) * 100 : 0;
    const idealEV = wr / 100 - avgIdealEntry;
    const realEV = wr / 100 - avgRealEntry;
    
    console.log(`${'='.repeat(80)}`);
    console.log(`POSITION SIZE: $${posSize}/trade`);
    console.log(`${'='.repeat(80)}`);
    console.log(`  Trades: ${totalTrades} | WR: ${wr.toFixed(1)}%`);
    console.log(`  Avg ideal entry: ${avgIdealEntry.toFixed(4)} | Avg real entry: ${avgRealEntry.toFixed(4)}`);
    console.log(`  Avg slippage: ${avgSlippageCents.toFixed(2)} cents/trade`);
    console.log(`  Slippage breakdown:`);
    console.log(`    Spread:  ${(slippageBuckets.spread / totalTrades * 100).toFixed(2)} cents avg`);
    console.log(`    Impact:  ${(slippageBuckets.impact / totalTrades * 100).toFixed(2)} cents avg`);
    console.log(`    Timing:  ${(slippageBuckets.timing / totalTrades * 100).toFixed(2)} cents avg`);
    console.log(`  Ideal EV: ${idealEV.toFixed(4)} | Real EV: ${realEV.toFixed(4)} | EV loss: ${((idealEV - realEV) * 100).toFixed(2)}%`);
    console.log(`  Ideal P&L: $${idealPnl.toFixed(2)} | Real P&L: $${realPnl.toFixed(2)}`);
    console.log(`  Total slippage cost: $${totalSlippage.toFixed(2)} (${(totalSlippage / Math.abs(idealPnl) * 100).toFixed(1)}% of gross)`);
    console.log(`  P&L per trade: ideal $${(idealPnl/totalTrades).toFixed(2)} → real $${(realPnl/totalTrades).toFixed(2)}`);
  }
  
  console.log(`\n${'='.repeat(80)}`);
  console.log('LIQUIDITY RISK ASSESSMENT');
  console.log('='.repeat(80));
  console.log(`
Key risks for Polymarket 5-min BTC markets:

1. SPREAD RISK (biggest cost):
   These markets have $0.01-0.05 spreads. On a $0.45 entry, 
   a 2-cent spread = 4.4% cost on entry. This is your #1 leak.

2. LIQUIDITY DEPTH:
   5-min markets are ephemeral — MMs provide less liquidity.
   Typical depth: $500-$2000 at best ask. Orders >$200 start 
   walking the book.

3. MOMENTUM IMPACT:
   When BTC moves fast (our best signals), MMs widen spreads 
   and pull quotes. The signals with the best backtested WR 
   may have the worst real execution.

4. TIMING LAG:
   Signal → API call → order → fill = 1-3 seconds minimum.
   On momentum moves, price can shift 1-2 cents in that window.

5. ENTRY WINDOW EFFECT:
   Early entries (240-270s) have BETTER liquidity (market just 
   opened, spreads tighter). Late entries (90-150s) have WORSE 
   liquidity (market nearly resolved, thin books).

RECOMMENDATIONS:
- Keep position sizes ≤$100 until liquidity is validated
- Use limit orders instead of market orders when possible
- Factor in 1.5-3 cent slippage on all backtested results
- Early entries are doubly beneficial: cheaper price AND better liquidity
- Monitor fill rates and actual vs quoted prices in production
`);
}

run().catch(e => { console.error(e); process.exit(1); });
