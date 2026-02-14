const { getOpenPositions, resolvePosition, getAllPositions } = require('./db');
const { getBtcPrice } = require('./btcPrice');
const { autoTune, getParams } = require('./autotuner');
const { notify } = require('./notify');
const { onTradeResolved, getState: getPhenomenaState } = require('./phenomena');

async function resolveExpiredPositions() {
  const open = getOpenPositions.all();
  const now = Date.now();
  const btc = getBtcPrice();

  for (const pos of open) {
    if (!pos.market_end_at) continue;
    const endMs = new Date(pos.market_end_at).getTime();
    if (now < endMs + 5000) continue; // Wait 5s after market end

    const btcEnd = btc.price || pos.btc_price_at_entry;
    const btcStart = pos.btc_price_at_start || pos.btc_price_at_entry;
    const btcWentUp = btcEnd >= btcStart;

    const won = (pos.side === 'up' && btcWentUp) || (pos.side === 'down' && !btcWentUp);
    const markPrice = won ? 1.0 : 0.0;
    const pnl = (pos.shares * markPrice) - pos.stake_usd;
    const pnlPct = (pnl / pos.stake_usd) * 100;

    let postMortem = null;
    if (!won) {
      postMortem = `LOSS REVIEW: Bought ${pos.side.toUpperCase()} @ ${pos.entry_price.toFixed(3)}, ` +
        `BTC start=${btcStart.toFixed(2)} end=${btcEnd.toFixed(2)} (${btcWentUp ? 'UP' : 'DOWN'}). ` +
        `Strategy: ${pos.strategy}. Stake lost: $${pos.stake_usd.toFixed(2)}`;
    } else {
      const returnPct = ((pnl / pos.stake_usd) * 100).toFixed(1);
      const btcMoveBps = ((btcEnd - btcStart) / btcStart * 10000).toFixed(1);
      postMortem = `WIN REVIEW: Bought ${pos.side.toUpperCase()} @ ${pos.entry_price.toFixed(3)}, ` +
        `BTC start=${btcStart.toFixed(2)} end=${btcEnd.toFixed(2)} (${btcWentUp ? 'UP' : 'DOWN'}). ` +
        `Strategy: ${pos.strategy}. Return: +${returnPct}% ($${pnl.toFixed(2)}). ` +
        `BTC moved ${btcMoveBps} bps. Entry ${pos.seconds_to_end_at_entry}s before end.`;
    }

    resolvePosition.run({
      id: pos.id,
      mark_price: markPrice,
      pnl: Math.round(pnl * 100) / 100,
      pnl_pct: Math.round(pnlPct * 100) / 100,
      btc_price_at_end: btcEnd,
      post_mortem: postMortem,
    });

    console.log(`[Resolver] Position #${pos.id} ${won ? 'WON' : 'LOST'}: PnL $${pnl.toFixed(2)}`);

    // Get updated capital for notification
    const allPos = getOpenPositions.all ? null : null; // just use inline calc
    const emoji = won ? '✅' : '❌';
    const pnlSign = pnl >= 0 ? '+' : '';
    notify(`${emoji} #${pos.id} ${won ? 'WON' : 'LOST'} — ${pnlSign}$${pnl.toFixed(2)} (${pos.strategy} ${pos.side.toUpperCase()}) | BTC $${btcStart.toFixed(0)}→$${btcEnd.toFixed(0)}`);

    // Run phenomena detection after every resolution
    try {
      onTradeResolved({
        id: pos.id,
        side: pos.side,
        pnl: Math.round(pnl * 100) / 100,
        entry_price: pos.entry_price,
        strategy: pos.strategy,
        btc_price_at_start: btcStart,
        btc_price_at_entry: pos.btc_price_at_entry,
        filter_version: pos.filter_version,
      });
    } catch (e) { console.error('[Resolver] Phenomena error:', e.message); }

    // Run auto-tuner after every resolution
    try { autoTune(); } catch (e) { console.error('[Resolver] AutoTune error:', e.message); }

    // Generate detailed loss explanation
    if (!won) {
      try {
        const explanation = buildLossExplanation(pos, btcStart, btcEnd, btcWentUp, pnl);
        notify(explanation, 'loss_analysis');
      } catch (e) { console.error('[Resolver] Loss explanation error:', e.message); }
    }
  }
}

function buildLossExplanation(pos, btcStart, btcEnd, btcWentUp, pnl) {
  const lines = [];
  lines.push(`\n🔎 LOSS ANALYSIS — Trade #${pos.id}`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━`);

  // What happened
  const btcMoveBps = ((btcEnd - btcStart) / btcStart * 10000).toFixed(1);
  const btcDir = btcWentUp ? '📈 UP' : '📉 DOWN';
  lines.push(`Bet: ${pos.side.toUpperCase()} @ ${pos.entry_price.toFixed(3)} ($${pos.stake_usd.toFixed(2)})`);
  lines.push(`BTC: $${btcStart.toFixed(0)} → $${btcEnd.toFixed(0)} (${btcDir}, ${btcMoveBps} bps)`);
  lines.push(`Result: -$${Math.abs(pnl).toFixed(2)}`);
  lines.push('');

  // Parse entry reason for signal metrics
  const paMatch = (pos.entry_reason || '').match(/PA\[([^\]]+)\]/);
  const pa = {};
  if (paMatch) {
    paMatch[1].split(',').forEach(part => {
      const [k, v] = part.split('=').map(s => s.trim());
      if (k && v) pa[k] = isNaN(v) ? v : parseFloat(v);
    });
  }

  // Signal quality assessment
  lines.push('📊 Signal Quality:');
  const params = getParams();
  const tp = params.ema || {};
  if (pa.dist !== undefined) {
    const distOk = Math.abs(pa.dist) >= (tp.min_ema_dist_bps || 5);
    lines.push(`  EMA dist: ${Math.abs(pa.dist).toFixed(1)} bps ${distOk ? '✅' : '⚠️ weak'} (min: ${tp.min_ema_dist_bps || 5})`);
  }
  if (pa.slope !== undefined) {
    const slopeOk = Math.abs(pa.slope) >= (tp.min_slope_abs || 2);
    lines.push(`  Slope: ${Math.abs(pa.slope).toFixed(2)} ${slopeOk ? '✅' : '⚠️ weak'} (min: ${tp.min_slope_abs || 2})`);
  }
  lines.push(`  Entry price: ${pos.entry_price.toFixed(3)} ${pos.entry_price <= 0.50 ? '✅ cheap' : pos.entry_price <= 0.65 ? '⚠️ mid' : '❌ expensive'}`);
  lines.push(`  Timing: ${pos.seconds_to_end_at_entry}s before end`);
  lines.push('');

  // Would current filters have caught this?
  lines.push('🛡️ Filter Check:');
  const shouldHaveBlocked = [];
  if (pa.dist !== undefined && Math.abs(pa.dist) < (tp.min_ema_dist_bps || 5)) {
    shouldHaveBlocked.push(`EMA dist ${Math.abs(pa.dist).toFixed(1)} < min ${tp.min_ema_dist_bps || 5} bps`);
  }
  if (pa.slope !== undefined && Math.abs(pa.slope) < (tp.min_slope_abs || 2)) {
    shouldHaveBlocked.push(`Slope ${Math.abs(pa.slope).toFixed(2)} < min ${tp.min_slope_abs || 2}`);
  }
  if (pos.entry_price > (tp.max_entry_price || 0.65)) {
    shouldHaveBlocked.push(`Entry ${pos.entry_price.toFixed(3)} > max ${tp.max_entry_price || 0.65}`);
  }
  // Check if phenomena guards would have blocked
  const phenState = getPhenomenaState();
  if (phenState.state.ema_lag_reversal?.active_side === pos.side && (phenState.state.ema_lag_reversal?.consecutive_losses || 0) >= 2) {
    shouldHaveBlocked.push(`EMA Lag Reversal guard (${phenState.state.ema_lag_reversal.consecutive_losses} consec ${pos.side} losses)`);
  }
  if (phenState.state.side_streak_loss?.losing_side === pos.side && (phenState.state.side_streak_loss?.streak || 0) >= 3) {
    shouldHaveBlocked.push(`Side Streak guard (${phenState.state.side_streak_loss.streak} ${pos.side} losses → needs 1.5x signals)`);
  }
  if (phenState.state.flat_market_chop?.recent_chop_losses >= 2) {
    shouldHaveBlocked.push(`Chop guard (${phenState.state.flat_market_chop.recent_chop_losses} flat losses → needs 2x dist)`);
  }
  if (phenState.state.expensive_entry_trap?.recent_expensive_losses >= 2 && pos.entry_price > 0.50) {
    shouldHaveBlocked.push(`Expensive Entry guard (temp cap 0.50, entry was ${pos.entry_price.toFixed(3)})`);
  }
  // Check filter version
  if ((pos.filter_version || 0) < 2) {
    shouldHaveBlocked.push(`Pre-v2 filters (trade taken under old params)`);
  }

  if (shouldHaveBlocked.length > 0) {
    lines.push(`  ❌ SHOULD HAVE BEEN BLOCKED:`);
    for (const reason of shouldHaveBlocked) {
      lines.push(`    • ${reason}`);
    }
  } else {
    lines.push(`  ✅ Passed all current filters — legit setup, just lost`);
  }
  lines.push('');

  // BTC move analysis
  const absBps = Math.abs(parseFloat(btcMoveBps));
  if (absBps < 5) {
    lines.push('💤 BTC barely moved (<5 bps) — flat market chop');
  } else if (absBps < 15) {
    lines.push('↔️ Small BTC move — marginal signal');
  } else {
    lines.push('💥 Strong BTC move against us — signal was wrong');
  }

  // Check for phenomena
  const phenState2 = getPhenomenaState();
  const activePhenomena = [];
  for (const [key, state] of Object.entries(phenState2.state)) {
    if (state.last_triggered && (Date.now() - state.last_triggered < 3600000)) {
      const phenDef = { ema_lag_reversal: 'EMA Lag Reversal', side_streak_loss: 'Side Streak Loss', flat_market_chop: 'Flat Market Chop', expensive_entry_trap: 'Expensive Entry Trap' };
      activePhenomena.push(phenDef[key] || key);
    }
  }
  if (activePhenomena.length > 0) {
    lines.push('');
    lines.push(`⚡ Active phenomena: ${activePhenomena.join(', ')}`);
  }

  // Consecutive loss tracking
  const allResolved = getAllPositions.all().filter(p => p.status === 'resolved').sort((a, b) => a.id - b.id);
  let streak = 0;
  for (let i = allResolved.length - 1; i >= 0; i--) {
    if (allResolved[i].pnl < 0) streak++;
    else break;
  }
  if (streak >= 2) {
    lines.push(`🔥 Loss streak: ${streak} in a row`);
  }

  // Running P&L
  const totalPnl = allResolved.reduce((s, p) => s + (p.pnl || 0), 0);
  const capital = 1000 + totalPnl;
  lines.push('');
  lines.push(`💰 Capital: $${capital.toFixed(0)} (${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)} total)`);

  return lines.join('\n');
}

module.exports = { resolveExpiredPositions };
