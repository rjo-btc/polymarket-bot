const { findCurrentMarket, fetchTokenPrices } = require('./market');
const { getBtcPrice } = require('./btcPrice');
const { insertPosition, insertDecision, pruneDecisions, getOpenPositions, getAllPositions, insertExecution } = require('./db');
const { getLatestState: getEmaState } = require('./strategies/ema');
const emaStrategy = require('./strategies/ema');
const sessionStrategy = require('./strategies/session');
const { resolveExpiredPositions } = require('./resolver');
const { params: tunerParams } = require('./autotuner');
const { notify } = require('./notify');
const { scoreSetup } = require('./confidence');
const { checkGuards, consumeCooldown } = require('./phenomena');
const { checkBreaker } = require('./circuitBreaker');
const { liquidityCap } = require('./liquidityCap');

const RISK_PCT = parseFloat(process.env.RISK_PCT) || 7; // % of current capital per trade
const CAPITAL_START = parseFloat(process.env.CAPITAL_START_USD) || 1000;

function getCurrentCapital() {
  const positions = getAllPositions.all();
  const resolved = positions.filter(p => p.status === 'resolved');
  const totalPnl = resolved.reduce((s, p) => s + (p.pnl || 0), 0);
  return CAPITAL_START + totalPnl;
}

function getStakeSize() {
  const capital = getCurrentCapital();
  return Math.round(capital * (RISK_PCT / 100) * 100) / 100;
}

let running = false;
let loopInterval = null;

// Bot status tracking
const botStatus = {
  state: 'starting',   // 'trading' | 'analyzing' | 'error'
  detail: 'Initializing...',
  lastTick: null,
  lastError: null,
  openPositions: 0,
};

function getBotStatus() { return { ...botStatus }; }

// Track which markets we've already entered per strategy to avoid duplicates
const enteredMarkets = new Map(); // key: `${strategy}-${market_slug}`
// Throttle "outside entry window" decisions to every 30s per strategy
const lastSkipLog = new Map(); // key: `${strategy}` -> timestamp

async function traderLoop() {
  if (running) return;
  running = true;

  try {
    // Resolve any expired positions first
    await resolveExpiredPositions();

    const market = await findCurrentMarket();
    if (!market) {
      botStatus.state = 'error';
      botStatus.detail = 'No active market found';
      botStatus.lastTick = Date.now();
      running = false;
      return;
    }

    const btc = getBtcPrice();
    if (!btc.price) {
      botStatus.state = 'error';
      botStatus.detail = 'No BTC price available';
      botStatus.lastTick = Date.now();
      running = false;
      return;
    }

    // Update open position count
    const openPos = getOpenPositions.all();
    botStatus.openPositions = openPos.length;
    const secsLeft = Math.floor((market.endMs - Date.now()) / 1000);

    if (openPos.length > 0) {
      botStatus.state = 'trading';
      botStatus.detail = `In ${openPos.length} position(s) — ${secsLeft}s to resolution`;
    } else {
      botStatus.state = 'analyzing';
      botStatus.detail = `Watching ${market.market_slug} — ${secsLeft}s left`;
    }
    botStatus.lastTick = Date.now();

    // Evaluate both strategies
    const strategies = [emaStrategy, sessionStrategy];
    for (const strat of strategies) {
      try {
        const decision = await strat.evaluate(market, btc.price);

        // Log decision (throttle "outside entry window" to every 30s)
        const isOutsideWindow = decision.action === 'SKIP' && /outside entry window/i.test(decision.reason);
        const skipKey = decision.strategy;
        const now = Date.now();
        const shouldLog = !isOutsideWindow || !lastSkipLog.has(skipKey) || (now - lastSkipLog.get(skipKey)) >= 30000;

        if (shouldLog) {
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
          if (isOutsideWindow) lastSkipLog.set(skipKey, now);
        }

        // Enter trade if signaled and not already in this market for this strategy
        if (decision.action === 'ENTER' && decision.side) {
          const key = `${decision.strategy}-${market.market_slug}`;
          if (!enteredMarkets.has(key)) {
            // Check we don't have an open position for this market+strategy
            const open = getOpenPositions.all();
            const alreadyOpen = open.some(p => p.market_slug === market.market_slug && p.strategy === decision.strategy);

            if (!alreadyOpen) {
              // Execution tracking: capture state at signal time
              const signalAt = new Date().toISOString();
              const signalBtcPrice = btc.price;
              const signalSecsToEnd = Math.floor((market.endMs - Date.now()) / 1000);
              // emaState already fetched above for circuit breaker
              
              // Detect signal type from reason
              let signalType = 'standard';
              if (decision.reason && decision.reason.includes('MOMENTUM BURST')) signalType = 'momentum_burst';
              else if (decision.reason && decision.reason.includes('SLOPE ACCEL')) signalType = 'slope_accel';

              const prices = await fetchTokenPrices();
              const fillAt = Date.now();
              const fillDelay = fillAt - new Date(signalAt).getTime();
              const entryPrice = decision.side === 'up'
                ? (prices.up || 0.5)
                : (prices.down || 0.5);
              
              // Compute spread from both sides
              const spread = prices.up && prices.down ? Math.abs(1 - prices.up - prices.down) : null;

              // Apply dynamic entry price filter based on signal strength
              const tp = tunerParams[decision.strategy] || {};
              if (tp.min_entry_price && entryPrice < tp.min_entry_price) {
                console.log(`[Trader] ${decision.strategy.toUpperCase()} FILTERED: entry price ${entryPrice.toFixed(3)} < min ${tp.min_entry_price}`);
                continue;
              }
              
              // Use dynamic max entry price based on signal strength
              const dynamicMaxPrice = decision.dynamic_max_entry_price || tp.max_entry_price || 0.60;
              const signalTier = decision.signal_tier || 'UNKNOWN';
              if (entryPrice > dynamicMaxPrice) {
                console.log(`[Trader] ${decision.strategy.toUpperCase()} FILTERED: entry price ${entryPrice.toFixed(3)} > ${signalTier} tier max ${dynamicMaxPrice.toFixed(2)}`);
                insertDecision.run({
                  strategy: decision.strategy,
                  market_slug: market.market_slug,
                  market_end_at: market.market_end_at,
                  last_checked_at: new Date().toISOString(),
                  seconds_to_end: Math.floor((market.endMs - Date.now()) / 1000),
                  action: 'SKIP',
                  side: decision.side,
                  reason: `Entry price ${entryPrice.toFixed(3)} > ${signalTier} tier cap ${dynamicMaxPrice.toFixed(2)} (signal strength insufficient)`,
                });
                continue;
              }

              // Apply minimum R:R filter — blocks coinflip trades
              const rr = (1 - entryPrice) / entryPrice;
              const minRR = tp.min_rr ?? 1.5;
              if (rr < minRR) {
                console.log(`[Trader] ${decision.strategy.toUpperCase()} FILTERED: R:R ${rr.toFixed(2)}x < min ${minRR}x (entry ${entryPrice.toFixed(3)})`);
                insertDecision.run({
                  strategy: decision.strategy,
                  market_slug: market.market_slug,
                  market_end_at: market.market_end_at,
                  last_checked_at: new Date().toISOString(),
                  seconds_to_end: Math.floor((market.endMs - Date.now()) / 1000),
                  action: 'SKIP',
                  side: decision.side,
                  reason: `R:R too low: ${rr.toFixed(2)}x < ${minRR}x (entry @ ${entryPrice.toFixed(3)})`,
                });
                continue;
              }

              // Apply side bias from auto-tuner
              const sideWeight = decision.side === 'up' ? (tp.side_up_weight ?? 1.0) : (tp.side_down_weight ?? 1.0);
              if (sideWeight < 1.0) {
                if (Math.random() > sideWeight) {
                  console.log(`[Trader] ${decision.strategy.toUpperCase()} SIDE BIAS SKIP: ${decision.side.toUpperCase()} weight ${sideWeight} (rolled skip)`);
                  continue;
                }
              }

              // Check circuit breaker first (self-healing filter enforcement)
              const emaState = getEmaState();
              const breakerSignal = {
                side: decision.side,
                entry_price: entryPrice,
                dist: emaState?.ema_dist_bps ?? null,
                edist: emaState?.ema_dist_bps ?? null,
                slope: emaState?.slope ?? null,
                rsi: emaState?.rsi ?? null,
                min_ema_dist_bps: (tp.min_ema_dist_bps || 5),
                min_slope_abs: (tp.min_slope_abs || 2),
                max_entry_price: dynamicMaxPrice, // Use dynamic max price for circuit breaker
              };
              const breakerResult = checkBreaker(breakerSignal);
              if (breakerResult.block) {
                console.log(`[Trader] CIRCUIT BREAKER BLOCKED: ${breakerResult.reason}`);
                insertDecision.run({
                  strategy: decision.strategy,
                  market_slug: market.market_slug,
                  market_end_at: market.market_end_at,
                  last_checked_at: new Date().toISOString(),
                  seconds_to_end: Math.floor((market.endMs - Date.now()) / 1000),
                  action: 'SKIP',
                  side: decision.side,
                  reason: breakerResult.reason,
                });
                continue;
              }
              // Circuit breaker decay: apply tighten if decayed past hard block
              if (breakerResult.tighten) {
                const priceDist = emaState?.price_dist_bps ?? 0;
                const slopeAbs = emaState?.slope_abs ?? 0;
                const mult = breakerResult.tighten.min_dist_multiplier || 1;
                const reqDist = 3 * mult;
                const reqSlope = (tp.min_slope_abs || 2) * (breakerResult.tighten.min_slope_multiplier || 1);
                if (priceDist < reqDist || slopeAbs < reqSlope) {
                  console.log(`[Trader] CIRCUIT BREAKER TIGHTEN: dist ${priceDist.toFixed(1)} < ${reqDist.toFixed(1)} or slope ${slopeAbs.toFixed(2)} < ${reqSlope.toFixed(2)} — ${breakerResult.reason}`);
                  continue;
                }
                console.log(`[Trader] CIRCUIT BREAKER DECAY (proceeding): ${breakerResult.reason}`);
              }

              // Check phenomena guards before entering
              const guardSignal = {
                side: decision.side, 
                strategy: decision.strategy, 
                entry_price: entryPrice,
                dist: emaState?.ema_dist_bps ?? null,
                edist: emaState?.ema_dist_bps ?? null,
                slope: emaState?.slope ?? null,
                rsi: emaState?.rsi ?? null,
                min_ema_dist_bps: (tp.min_ema_dist_bps || 5),
                min_slope_abs: (tp.min_slope_abs || 2),
                max_entry_price: dynamicMaxPrice,
              };
              const guardResult = checkGuards(guardSignal);
              if (guardResult.block) {
                console.log(`[Trader] TREND GUARDRAIL BLOCKED: ${guardResult.reason}`);
                insertDecision.run({
                  strategy: decision.strategy,
                  market_slug: market.market_slug,
                  market_end_at: market.market_end_at,
                  last_checked_at: new Date().toISOString(),
                  seconds_to_end: Math.floor((market.endMs - Date.now()) / 1000),
                  action: 'SKIP',
                  side: decision.side,
                  reason: guardResult.reason,
                });
                if (guardResult.phenomena) {
                  for (const p of guardResult.phenomena) {
                    if (p.block) consumeCooldown(p.key);
                  }
                }
                continue;
              }

              // Apply trend guardrail tightening if any
              // Uses live EMA state directly (not regex parsing) for reliable enforcement
              if (guardResult.tighten) {
                const tp2 = tunerParams[decision.strategy] || {};
                const priceDist = emaState?.price_dist_bps ?? 0;  // price vs EMA9
                const emaDist = emaState?.ema_dist_bps ?? 0;      // EMA9 vs EMA200
                const slopeAbs = emaState?.slope_abs ?? 0;
                
                let blocked = false;
                let blockReasons = [];

                if (guardResult.tighten.min_slope_multiplier) {
                  const requiredSlope = (tp2.min_slope_abs || 2) * guardResult.tighten.min_slope_multiplier;
                  if (slopeAbs < requiredSlope) {
                    blocked = true;
                    blockReasons.push(`slope ${slopeAbs.toFixed(2)} < ${requiredSlope.toFixed(2)} (${guardResult.tighten.min_slope_multiplier}x)`);
                  }
                }
                if (guardResult.tighten.min_dist_multiplier) {
                  const mult = guardResult.tighten.min_dist_multiplier;
                  // Check BOTH distances — price-to-EMA9 AND EMA9-to-EMA200
                  // Price-to-EMA9 (signal quality): base threshold 3 bps
                  const priceDistRequired = 3 * mult;
                  // EMA9-to-EMA200 (trend strength): base threshold from params
                  const emaDistRequired = (tp2.min_ema_dist_bps || 5) * mult;
                  
                  if (priceDist < priceDistRequired) {
                    blocked = true;
                    blockReasons.push(`price-to-EMA dist ${priceDist.toFixed(1)} < ${priceDistRequired.toFixed(1)} bps (${mult}x)`);
                  }
                  if (emaDist < emaDistRequired) {
                    blocked = true;
                    blockReasons.push(`EMA-to-EMA dist ${emaDist.toFixed(1)} < ${emaDistRequired.toFixed(1)} bps (${mult}x)`);
                  }
                }
                if (guardResult.tighten.max_entry_override && entryPrice > guardResult.tighten.max_entry_override) {
                  blocked = true;
                  blockReasons.push(`entry ${entryPrice.toFixed(3)} > temp cap ${guardResult.tighten.max_entry_override}`);
                }

                if (blocked) {
                  const fullReason = `TREND GUARDRAIL BLOCKED: ${blockReasons.join('; ')} — ${guardResult.reasons.join('; ')}`;
                  console.log(`[Trader] ${fullReason}`);
                  insertDecision.run({
                    strategy: decision.strategy,
                    market_slug: market.market_slug,
                    market_end_at: market.market_end_at,
                    last_checked_at: new Date().toISOString(),
                    seconds_to_end: Math.floor((market.endMs - Date.now()) / 1000),
                    action: 'SKIP',
                    side: decision.side,
                    reason: fullReason,
                  });
                  continue;
                }
                if (guardResult.reasons.length > 0) {
                  console.log(`[Trader] TREND GUARDRAIL WARN (proceeding): ${guardResult.reasons.join('; ')}`);
                }
              }

              // Parse setup metrics for confidence scoring
              const pa = {};
              const paMatch = (decision.reason || '').match(/PA\[([^\]]+)\]/);
              if (paMatch) {
                paMatch[1].split(',').forEach(part => {
                  const [k, v] = part.split('=').map(s => s.trim());
                  if (k && v) {
                    const cleaned = v.replace(/\s*bps\s*$/i, '').trim();
                    pa[k] = isNaN(cleaned) ? v : parseFloat(cleaned);
                  }
                });
              }

              const secsToEnd = Math.floor((market.endMs - Date.now()) / 1000);
              const setup = {
                entry_price: entryPrice,
                seconds_to_end: secsToEnd,
                dist_bps: pa.dist || null,
                slope: pa.slope || null,
                side: decision.side,
              };

              // Score confidence and apply tier multiplier (only after Kelly activation at 50 trades)
              const confidence = scoreSetup(setup);
              const KELLY_THRESHOLD = 50;
              const resolvedCount = getAllPositions.all().filter(p => p.status === 'resolved').length;
              const kellyActive = resolvedCount >= KELLY_THRESHOLD;

              let stakeUsd;
              if (kellyActive) {
                stakeUsd = Math.round(getStakeSize() * confidence.multiplier * 100) / 100;
                console.log(`[Trader] CONFIDENCE: Tier ${confidence.tier} (${confidence.tier_label}) score=${confidence.score} → ${confidence.multiplier}x size ($${stakeUsd})`);
              } else {
                stakeUsd = getStakeSize();
              }

              // Apply liquidity cap — prevents oversizing into thin books
              const liqResult = liquidityCap(stakeUsd, entryPrice, secsToEnd);
              if (liqResult.capped) {
                console.log(`[Trader] ${liqResult.reason}`);
                stakeUsd = liqResult.stake;
              }

              const shares = stakeUsd / entryPrice;

              insertPosition.run({
                market_slug: market.market_slug,
                market_title: market.title,
                strategy: decision.strategy,
                side: decision.side,
                stake_usd: stakeUsd,
                shares: Math.round(shares * 100) / 100,
                entry_price: entryPrice,
                entered_at: new Date().toISOString(),
                seconds_to_end_at_entry: secsToEnd,
                btc_price_at_entry: btc.price,
                btc_price_at_start: btc.price, // will be updated
                entry_reason: decision.reason,
                market_end_at: market.market_end_at,
              });

              // Record execution quality data
              try {
                const posId = getAllPositions.all()[0]?.id; // most recent position
                const fillBtcPrice = btc.price;
                const btcMoveBps = signalBtcPrice ? ((fillBtcPrice - signalBtcPrice) / signalBtcPrice) * 10000 : null;
                const fillSecsToEnd = Math.floor((market.endMs - fillAt) / 1000);
                
                insertExecution.run({
                  position_id: posId,
                  market_slug: market.market_slug,
                  side: decision.side,
                  signal_type: signalType,
                  signal_at: signalAt,
                  signal_price: null, // would need orderbook snapshot for true signal price
                  quoted_price: entryPrice,
                  executed_price: entryPrice, // paper trading = no slippage (quoted = executed)
                  slippage_cents: 0, // paper trading has 0 actual slippage
                  seconds_to_end_at_signal: signalSecsToEnd,
                  seconds_to_end_at_fill: fillSecsToEnd,
                  fill_delay_ms: fillDelay,
                  btc_price_at_signal: signalBtcPrice,
                  btc_price_at_fill: fillBtcPrice,
                  btc_move_bps: btcMoveBps ? parseFloat(btcMoveBps.toFixed(2)) : null,
                  ema_dist_bps: emaState?.ema_dist_bps ?? null,
                  slope_abs: emaState?.slope_abs ?? null,
                  rsi: emaState?.rsi ?? null,
                  book_up_price: prices.up,
                  book_down_price: prices.down,
                  spread_cents: spread ? parseFloat((spread * 100).toFixed(2)) : null,
                });
                console.log(`[Trader] Execution tracked: ${signalType} | spread ${spread ? (spread*100).toFixed(1) : '?'}¢ | delay ${fillDelay}ms`);
              } catch (e) {
                console.error('[Trader] Execution tracking error:', e.message);
              }

              enteredMarkets.set(key, true);
              botStatus.state = 'trading';
              botStatus.detail = `Entered ${decision.side.toUpperCase()} via ${decision.strategy} on ${market.market_slug}`;
              botStatus.openPositions++;
              console.log(`[Trader] ${decision.strategy.toUpperCase()} ENTERED ${decision.side.toUpperCase()} on ${market.market_slug}`);
              const tierInfo = kellyActive ? ` | T${confidence.tier} (${confidence.score})` : '';
              const liqInfo = liqResult.capped ? ` | 🔒 LIQ CAP (book ~${liqResult.meta.bookDepth})` : '';
              const signalInfo = signalTier ? ` | ${signalTier} signal (max $${dynamicMaxPrice.toFixed(2)})` : '';
              notify(`📈 ENTERED ${decision.side.toUpperCase()} — $${stakeUsd.toFixed(2)} via ${decision.strategy} @ ${entryPrice.toFixed(3)} | BTC $${btc.price.toFixed(2)} | ${secsToEnd}s to end${tierInfo}${liqInfo}${signalInfo}`);
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
    botStatus.state = 'error';
    botStatus.detail = e.message;
    botStatus.lastError = { message: e.message, at: Date.now() };
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

module.exports = { startTrader, stopTrader, getBotStatus };
