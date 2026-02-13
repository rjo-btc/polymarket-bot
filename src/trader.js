const { findCurrentMarket, fetchTokenPrices } = require('./market');
const { getBtcPrice } = require('./btcPrice');
const { insertPosition, insertDecision, pruneDecisions, getOpenPositions } = require('./db');
const emaStrategy = require('./strategies/ema');
const sessionStrategy = require('./strategies/session');
const { resolveExpiredPositions } = require('./resolver');

const CAPITAL_PER_TRADE = parseFloat(process.env.CAPITAL_PER_TRADE_USD) || 50;
let running = false;
let loopInterval = null;

// Track which markets we've already entered per strategy to avoid duplicates
const enteredMarkets = new Map(); // key: `${strategy}-${market_slug}`

async function traderLoop() {
  if (running) return;
  running = true;

  try {
    // Resolve any expired positions first
    await resolveExpiredPositions();

    const market = await findCurrentMarket();
    if (!market) {
      running = false;
      return;
    }

    const btc = getBtcPrice();
    if (!btc.price) {
      running = false;
      return;
    }

    // Evaluate both strategies
    const strategies = [emaStrategy, sessionStrategy];
    for (const strat of strategies) {
      try {
        const decision = await strat.evaluate(market, btc.price);

        // Log decision
        insertDecision.run({
          strategy: decision.strategy,
          market_slug: decision.market_slug,
          market_end_at: decision.market_end_at,
          last_checked_at: decision.last_checked_at,
          seconds_to_end: decision.seconds_to_end,
          action: decision.action,
          side: decision.side,
          reason: decision.reason,
        });

        // Enter trade if signaled and not already in this market for this strategy
        if (decision.action === 'ENTER' && decision.side) {
          const key = `${decision.strategy}-${market.market_slug}`;
          if (!enteredMarkets.has(key)) {
            // Check we don't have an open position for this market+strategy
            const open = getOpenPositions.all();
            const alreadyOpen = open.some(p => p.market_slug === market.market_slug && p.strategy === decision.strategy);

            if (!alreadyOpen) {
              const prices = await fetchTokenPrices();
              const entryPrice = decision.side === 'up'
                ? (prices.up || 0.5)
                : (prices.down || 0.5);

              const shares = CAPITAL_PER_TRADE / entryPrice;
              const secsToEnd = Math.floor((market.endMs - Date.now()) / 1000);

              insertPosition.run({
                market_slug: market.market_slug,
                market_title: market.title,
                strategy: decision.strategy,
                side: decision.side,
                stake_usd: CAPITAL_PER_TRADE,
                shares: Math.round(shares * 100) / 100,
                entry_price: entryPrice,
                entered_at: new Date().toISOString(),
                seconds_to_end_at_entry: secsToEnd,
                btc_price_at_entry: btc.price,
                btc_price_at_start: btc.price, // will be updated
                entry_reason: decision.reason,
                market_end_at: market.market_end_at,
              });

              enteredMarkets.set(key, true);
              console.log(`[Trader] ${decision.strategy.toUpperCase()} ENTERED ${decision.side.toUpperCase()} on ${market.market_slug}`);
            }
          }
        }
      } catch (e) {
        console.error(`[Trader] Strategy ${strat === emaStrategy ? 'ema' : 'session'} error:`, e.message);
      }
    }

    // Prune old decisions
    pruneDecisions.run();

    // Clean up old entries from enteredMarkets (older than 10 min)
    const now = Date.now();
    for (const [key] of enteredMarkets) {
      const slug = key.split('-').slice(1).join('-');
      // Simple cleanup - if we have > 50 entries, clear old ones
      if (enteredMarkets.size > 50) {
        enteredMarkets.clear();
        break;
      }
    }
  } catch (e) {
    console.error('[Trader] Loop error:', e.message);
  } finally {
    running = false;
  }
}

function startTrader(intervalMs = 10000) {
  console.log('[Trader] Starting auto-trader loop...');
  traderLoop();
  loopInterval = setInterval(traderLoop, intervalMs);
}

function stopTrader() {
  if (loopInterval) clearInterval(loopInterval);
}

module.exports = { startTrader, stopTrader };
