const { getOpenPositions, resolvePosition } = require('./db');
const { getBtcPrice } = require('./btcPrice');

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
  }
}

module.exports = { resolveExpiredPositions };
