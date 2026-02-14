/**
 * Circuit Breaker — Self-Healing Filter Enforcement
 * 
 * When a loss analysis detects "SHOULD HAVE BEEN BLOCKED," this system:
 * 1. Records exactly which filter was bypassed and the trade details
 * 2. Creates a temporary block rule that prevents similar trades
 * 3. Notifies via Telegram that a filter breach was auto-corrected
 * 4. Breaches expire after 2 hours (configurable) or manual clear
 * 
 * The key insight: if the loss analysis KNOWS a trade should have been blocked,
 * the system should ACT on that knowledge, not just report it.
 */

const { kvGet, kvSet } = require('./db');
const { notify } = require('./notify');

const BREAKER_KEY = 'circuit_breaker_state';
const BREACH_TTL_MS = 30 * 60 * 1000; // 30 minutes default
const DECAY_INTERVAL_MS = 10 * 60 * 1000; // decay 50% severity every 10 min

let breakerState = { breaches: [], totalBreaches: 0 };

function loadState() {
  try {
    const row = kvGet.get(BREAKER_KEY);
    if (row) breakerState = JSON.parse(row.value);
  } catch (e) {
    console.error('[CircuitBreaker] Failed to load state:', e.message);
  }
}

function saveState() {
  try {
    kvSet.run({ key: BREAKER_KEY, value: JSON.stringify(breakerState) });
  } catch (e) {
    console.error('[CircuitBreaker] Failed to save state:', e.message);
  }
}

/**
 * Called by resolver after a loss is detected with filter violations.
 * Creates breach records that block similar trades.
 * 
 * @param {Object} trade - the losing trade
 * @param {string[]} violations - array of violation descriptions from loss analysis
 * @param {Object} tradeMetrics - parsed PA metrics { dist, edist, slope, rsi, side, entry_price, signal_type }
 */
function reportBreach(trade, violations, tradeMetrics) {
  if (!violations || violations.length === 0) return;

  // Build specific block rules based on what went wrong
  const rules = [];

  for (const v of violations) {
    // EMA dist violation — block trades with dist below the minimum
    if (v.includes('EMA dist') || v.includes('dist') && v.includes('< min')) {
      rules.push({
        type: 'min_dist',
        description: v,
        block: (signal) => {
          const dist = signal.edist ?? signal.dist ?? 0;
          return dist < (signal.min_ema_dist_bps || 5);
        },
      });
    }

    // Slope violation
    if (v.includes('Slope') && v.includes('< min')) {
      rules.push({
        type: 'min_slope',
        description: v,
        block: (signal) => {
          const slope = Math.abs(signal.slope || 0);
          return slope < (signal.min_slope_abs || 2);
        },
      });
    }

    // Entry price violation
    if (v.includes('Entry') && v.includes('> max')) {
      rules.push({
        type: 'max_entry',
        description: v,
        block: (signal) => signal.entry_price > (signal.max_entry_price || 0.65),
      });
    }

    // Phenomena guard violations — the guard detected it but didn't enforce
    if (v.includes('EMA Lag Reversal guard')) {
      rules.push({
        type: 'ema_lag_block',
        description: v,
        blockSide: trade.side,
        block: (signal) => signal.side === trade.side,
      });
    }

    if (v.includes('Side Streak guard')) {
      rules.push({
        type: 'side_streak_block',
        description: v,
        blockSide: trade.side,
        block: (signal) => signal.side === trade.side,
      });
    }

    if (v.includes('Chop guard')) {
      rules.push({
        type: 'chop_block',
        description: v,
        block: () => true, // block all until chop clears
      });
    }

    if (v.includes('Expensive Entry guard')) {
      rules.push({
        type: 'expensive_entry_block',
        description: v,
        block: (signal) => signal.entry_price > 0.50,
      });
    }
  }

  if (rules.length === 0) return;

  const breach = {
    trade_id: trade.id,
    side: trade.side,
    pnl: trade.pnl,
    violations,
    ruleTypes: rules.map(r => r.type),
    created_at: Date.now(),
    expires_at: Date.now() + BREACH_TTL_MS,
    resolved: false,
  };

  breakerState.breaches.push(breach);
  breakerState.totalBreaches++;

  // Prune old/expired breaches
  breakerState.breaches = breakerState.breaches.filter(b => 
    !b.resolved && b.expires_at > Date.now()
  );

  saveState();

  // Notify about the auto-correction
  const msg = [
    `\n🔧 CIRCUIT BREAKER ACTIVATED — Trade #${trade.id}`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `Filter breach detected: trade should have been blocked but wasn't.`,
    ``,
    `Violations found:`,
    ...violations.map(v => `  • ${v}`),
    ``,
    `Auto-correction: hard block for 10m → tighten 1.5x at 10m → 1.25x at 20m → expires at 30m`,
    `Rules activated: ${rules.map(r => r.type).join(', ')}`,
    ``,
    `Clears early on a winning trade in the same direction.`,
  ].join('\n');

  notify(msg, 'loss_analysis');
  console.log(`[CircuitBreaker] BREACH ACTIVATED: trade #${trade.id} — ${rules.map(r => r.type).join(', ')}`);
}

/**
 * Called by trader.js before entering a trade.
 * Checks all active breaches and blocks if any rule matches.
 * 
 * @param {Object} signal - { side, entry_price, dist, edist, slope, rsi, strategy, signal_type }
 * @returns {{ block: boolean, reason: string|null }}
 */
function checkBreaker(signal) {
  // Clean expired breaches
  const now = Date.now();
  const activeBefore = breakerState.breaches.length;
  breakerState.breaches = breakerState.breaches.filter(b => !b.resolved && b.expires_at > now);
  if (breakerState.breaches.length !== activeBefore) saveState();

  if (breakerState.breaches.length === 0) return { block: false, reason: null };

  // Check each active breach's rules with time-based decay
  const matchingBreaches = [];
  for (const breach of breakerState.breaches) {
    // Calculate decay level: 0-10 min = full block, 10-20 min = tighten 1.5x, 20-30 min = tighten 1.25x
    const ageMs = now - breach.created_at;
    const decaySteps = Math.floor(ageMs / DECAY_INTERVAL_MS);
    
    // After 3 decay steps (30 min), breach expires naturally via TTL
    if (decaySteps >= 3) continue;

    for (const ruleType of breach.ruleTypes) {
      let matched = false;
      
      switch (ruleType) {
        case 'min_dist':
          const dist = signal.edist ?? signal.dist ?? 999;
          matched = dist < (signal.min_ema_dist_bps || 5);
          break;
        case 'min_slope':
          matched = Math.abs(signal.slope || 999) < (signal.min_slope_abs || 2);
          break;
        case 'max_entry':
          matched = signal.entry_price > (signal.max_entry_price || 0.65);
          break;
        case 'ema_lag_block':
          matched = signal.side === breach.side;
          break;
        case 'side_streak_block':
          matched = signal.side === breach.side;
          break;
        case 'chop_block':
          const chopDist = signal.price_dist ?? signal.dist ?? 0;
          matched = chopDist < (signal.min_ema_dist_bps || 5) * 2;
          break;
        case 'expensive_entry_block':
          matched = signal.entry_price > 0.50;
          break;
      }

      if (matched) {
        matchingBreaches.push({ breach, ruleType, decaySteps });
      }
    }
  }

  if (matchingBreaches.length > 0) {
    const minDecay = Math.min(...matchingBreaches.map(m => m.decaySteps));
    
    if (minDecay === 0) {
      // First 10 min: hard block
      const reasons = matchingBreaches.map(m => 
        `CIRCUIT_BREAKER: ${m.ruleType} (trade #${m.breach.trade_id})`
      );
      return { block: true, reason: reasons.join('; ') };
    } else {
      // 10-30 min: decay to tighten (1.5x at 10min, 1.25x at 20min)
      const multiplier = minDecay === 1 ? 1.5 : 1.25;
      const reasons = matchingBreaches.map(m => 
        `CIRCUIT_BREAKER_DECAY: ${m.ruleType} (trade #${m.breach.trade_id}, ${m.decaySteps * 10}min decay → ${multiplier}x)`
      );
      return { 
        block: false, 
        tighten: { min_dist_multiplier: multiplier, min_slope_multiplier: multiplier },
        reason: reasons.join('; '),
      };
    }
  }

  return { block: false, reason: null };
}

/**
 * Called when a trade wins — clears breaches for that side/type
 */
function onWin(trade) {
  let cleared = 0;
  for (const breach of breakerState.breaches) {
    if (breach.side === trade.side && !breach.resolved) {
      breach.resolved = true;
      cleared++;
    }
  }
  if (cleared > 0) {
    breakerState.breaches = breakerState.breaches.filter(b => !b.resolved);
    saveState();
    console.log(`[CircuitBreaker] Cleared ${cleared} breach(es) after ${trade.side.toUpperCase()} WIN`);
  }
}

function getState() {
  // Clean expired
  const now = Date.now();
  breakerState.breaches = breakerState.breaches.filter(b => !b.resolved && b.expires_at > now);
  return {
    active_breaches: breakerState.breaches.length,
    total_breaches: breakerState.totalBreaches,
    breaches: breakerState.breaches.map(b => ({
      trade_id: b.trade_id,
      side: b.side,
      violations: b.violations,
      rules: b.ruleTypes,
      created_at: new Date(b.created_at).toISOString(),
      expires_in_min: Math.round((b.expires_at - now) / 60000),
    })),
  };
}

function resetState() {
  breakerState = { breaches: [], totalBreaches: 0 };
  saveState();
  console.log('[CircuitBreaker] State reset');
}

// Init
loadState();

module.exports = { reportBreach, checkBreaker, onWin, getState, resetState };
