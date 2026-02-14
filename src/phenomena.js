/**
 * Phenomena Detection System
 * 
 * Learns from specific failure/success patterns and applies real-time guards.
 * Each phenomenon has:
 *   - detect(trade, context): returns true if this pattern caused the outcome
 *   - guard(signal, context): returns { block, reason } if the pattern is currently active and dangerous
 *   - state: tracked hits, streaks, cooldowns
 * 
 * Phenomena persist to SQLite kv table. New ones can be added as we discover them.
 */

const { kvGet, kvSet, getAllPositions } = require('./db');

const PHENOMENA_KEY = 'phenomena_state';

// --- Phenomenon Definitions ---

const PHENOMENA = {
  ema_lag_reversal: {
    name: 'EMA Lag Reversal',
    description: 'EMAs still bearish/bullish from earlier move, but price is reversing. Bot keeps trading the old direction into the new trend.',
    detect(trade, ctx) {
      // Triggered when: loss + the actual BTC move was opposite to our bet
      // AND the previous trade was also the same side and also lost
      if (trade.pnl >= 0) return false;
      
      const recent = ctx.recentResolved;
      if (recent.length < 2) return false;
      
      const prev = recent[recent.length - 2];
      // Same side, both losses = EMA lag (kept betting same direction)
      return prev.side === trade.side && prev.pnl < 0;
    },
    guard(signal, ctx) {
      const state = ctx.phenomenaState.ema_lag_reversal || {};
      if (state.active_side && signal.side === state.active_side && state.consecutive_losses >= 2) {
        // Time decay: every 5 min reduces effective severity by 1 level
        const minSince = state.last_triggered ? (Date.now() - state.last_triggered) / 60000 : 0;
        const decaySteps = Math.floor(minSince / 5);
        const effectiveLosses = Math.max(0, state.consecutive_losses - decaySteps);
        if (effectiveLosses < 2) return { block: false };
        const multiplier = Math.min(2.0, 1 + effectiveLosses * 0.25);
        return {
          block: false,
          tighten: { min_slope_multiplier: multiplier, min_dist_multiplier: multiplier },
          reason: `EMA_LAG_GUARD: ${state.consecutive_losses} consec ${signal.side.toUpperCase()} losses (eff. ${effectiveLosses} after ${decaySteps > 0 ? decaySteps * 5 + 'min decay' : 'no decay'}) — ${multiplier.toFixed(2)}x signals`,
        };
      }
      return { block: false };
    },
  },

  side_streak_loss: {
    name: 'Side Streak Loss',
    description: 'One side (UP or DOWN) is on a losing streak — market regime may have shifted.',
    detect(trade, ctx) {
      if (trade.pnl >= 0) return false;
      const recent = ctx.recentResolved.slice(-5);
      const sameSide = recent.filter(t => t.side === trade.side);
      const sameSideLosses = sameSide.filter(t => t.pnl < 0);
      return sameSideLosses.length >= 3;
    },
    guard(signal, ctx) {
      const state = ctx.phenomenaState.side_streak_loss || {};
      if (state.losing_side === signal.side && state.streak >= 3) {
        // Time decay: every 5 min reduces effective streak by 1
        const minSince = state.last_triggered ? (Date.now() - state.last_triggered) / 60000 : 0;
        const decaySteps = Math.floor(minSince / 5);
        const effectiveStreak = Math.max(0, state.streak - decaySteps);
        if (effectiveStreak < 3) return { block: false };
        const multiplier = Math.min(2.0, 1 + (effectiveStreak - 2) * 0.25);
        return {
          block: false,
          tighten: { min_slope_multiplier: multiplier, min_dist_multiplier: multiplier },
          reason: `SIDE_STREAK_WARN: ${state.streak} ${signal.side.toUpperCase()} losses (eff. ${effectiveStreak} after ${decaySteps > 0 ? decaySteps * 5 + 'min decay' : 'no decay'}) — ${multiplier.toFixed(2)}x signals`,
        };
      }
      return { block: false };
    },
  },

  flat_market_chop: {
    name: 'Flat Market Chop',
    description: 'BTC is range-bound, EMAs are too close together. Signals are noise, not trend.',
    detect(trade, ctx) {
      if (trade.pnl >= 0) return false;
      // Check if the BTC move was tiny (< 30 bps between start and end)
      const btcStart = trade.btc_price_at_start;
      const btcEnd = trade.btc_price_at_entry; // approximate
      if (!btcStart) return false;
      const moveBps = Math.abs((btcEnd - btcStart) / btcStart) * 10000;
      return moveBps < 15; // very flat
    },
    guard(signal, ctx) {
      const state = ctx.phenomenaState.flat_market_chop || {};
      if (state.recent_chop_losses >= 2) {
        // Time decay: every 5 min reduces effective count by 1
        const minSince = state.last_triggered ? (Date.now() - state.last_triggered) / 60000 : 0;
        const decaySteps = Math.floor(minSince / 5);
        const effectiveChop = Math.max(0, state.recent_chop_losses - decaySteps);
        if (effectiveChop < 2) return { block: false };
        return {
          block: false,
          tighten: { min_dist_multiplier: 2.0 },
          reason: `CHOP_GUARD: ${state.recent_chop_losses} chop losses (eff. ${effectiveChop} after ${decaySteps > 0 ? decaySteps * 5 + 'min decay' : 'no decay'}) — 2x EMA dist`,
        };
      }
      return { block: false };
    },
  },

  expensive_entry_trap: {
    name: 'Expensive Entry Trap', 
    description: 'High entry prices (>0.55) that look safe but offer terrible R:R. One loss wipes multiple wins.',
    detect(trade, ctx) {
      if (trade.pnl >= 0) return false;
      return trade.entry_price >= 0.55;
    },
    guard(signal, ctx) {
      const state = ctx.phenomenaState.expensive_entry_trap || {};
      if (state.recent_expensive_losses >= 2) {
        // Time decay: every 5 min reduces effective count by 1
        const minSince = state.last_triggered ? (Date.now() - state.last_triggered) / 60000 : 0;
        const decaySteps = Math.floor(minSince / 5);
        const effectiveCount = Math.max(0, state.recent_expensive_losses - decaySteps);
        if (effectiveCount < 2) return { block: false };
        return {
          block: false,
          tighten: { max_entry_override: 0.50 },
          reason: `ENTRY_TRAP_GUARD: ${state.recent_expensive_losses} expensive losses (eff. ${effectiveCount} after ${decaySteps > 0 ? decaySteps * 5 + 'min decay' : 'no decay'}) — temp cap 0.50`,
        };
      }
      return { block: false };
    },
  },
  directional_spam: {
    name: 'Directional Spam',
    description: 'Repeated trades in the same direction — each consecutive same-direction trade requires increasingly strong signals since the move has already been playing out.',
    detect(trade, ctx) {
      // Always track — this isn't about wins/losses, it's about repeated direction
      const recent = ctx.recentResolved;
      if (recent.length < 2) return false;
      const prev = recent[recent.length - 2];
      return prev.side === trade.side;
    },
    guard(signal, ctx) {
      const state = ctx.phenomenaState.directional_spam || {};
      const streak = state.current_streak || 0;
      const streakSide = state.streak_side;
      const lastTradeAt = state.last_trade_at || 0;
      
      if (streakSide === signal.side && streak >= 2) {
        // Time decay: every 5 minutes since last trade reduces effective streak by 1
        const minutesSinceLast = (Date.now() - lastTradeAt) / 60000;
        const decaySteps = Math.floor(minutesSinceLast / 5);
        const effectiveStreak = Math.max(1, streak - decaySteps);
        
        if (effectiveStreak >= 2) {
          const multiplier = Math.min(2.0, 1 + (effectiveStreak - 1) * 0.25);
          return {
            block: false,
            tighten: { min_slope_multiplier: multiplier, min_dist_multiplier: multiplier },
            reason: `DIRECTIONAL_SPAM: ${streak} ${signal.side.toUpperCase()} trades (effective ${effectiveStreak} after ${decaySteps > 0 ? decaySteps * 5 + 'min decay' : 'no decay'}) — requiring ${multiplier.toFixed(2)}x signal strength`,
          };
        }
      }
      return { block: false };
    },
  },
};

// --- State Management ---

let phenomenaState = {};
let phenomenaLog = [];

function loadState() {
  try {
    const row = kvGet.get(PHENOMENA_KEY);
    if (row) {
      const saved = JSON.parse(row.value);
      phenomenaState = saved.state || {};
      phenomenaLog = saved.log || [];
    }
  } catch (e) {
    console.error('[Phenomena] Failed to load state:', e.message);
  }
}

function saveState() {
  try {
    kvSet.run({ key: PHENOMENA_KEY, value: JSON.stringify({ state: phenomenaState, log: phenomenaLog.slice(-100) }) });
  } catch (e) {
    console.error('[Phenomena] Failed to save state:', e.message);
  }
}

// Called after each trade resolves
function onTradeResolved(trade) {
  const allResolved = getAllPositions.all().filter(p => p.status === 'resolved');
  allResolved.sort((a, b) => a.id - b.id);
  
  const ctx = { recentResolved: allResolved.slice(-10), phenomenaState };

  for (const [key, phenomenon] of Object.entries(PHENOMENA)) {
    try {
      if (phenomenon.detect(trade, ctx)) {
        // Update state for this phenomenon
        if (!phenomenaState[key]) phenomenaState[key] = {};
        const s = phenomenaState[key];
        
        s.last_triggered = Date.now();
        s.total_hits = (s.total_hits || 0) + 1;

        // Phenomenon-specific state updates
        if (key === 'ema_lag_reversal') {
          if (s.active_side === trade.side) {
            s.consecutive_losses = (s.consecutive_losses || 0) + 1;
          } else {
            s.active_side = trade.side;
            s.consecutive_losses = 2; // at least 2 to detect
          }
          s.cooldown_remaining = Math.min(s.consecutive_losses - 1, 3); // skip 1-3 trades
        }

        if (key === 'side_streak_loss') {
          s.losing_side = trade.side;
          const sameSideLosses = allResolved.slice(-8).filter(t => t.side === trade.side && t.pnl < 0);
          s.streak = sameSideLosses.length;
        }

        if (key === 'flat_market_chop') {
          s.recent_chop_losses = (s.recent_chop_losses || 0) + 1;
          // Decay after 30 min
          s.decay_after = Date.now() + 30 * 60 * 1000;
        }

        if (key === 'expensive_entry_trap') {
          s.recent_expensive_losses = (s.recent_expensive_losses || 0) + 1;
          s.decay_after = Date.now() + 60 * 60 * 1000;
        }

        // directional_spam state is tracked globally (outside detect loop)

        phenomenaLog.push({
          ts: Date.now(),
          phenomenon: key,
          name: phenomenon.name,
          trade_id: trade.id,
          side: trade.side,
          pnl: trade.pnl,
        });

        console.log(`[Phenomena] DETECTED: ${phenomenon.name} — trade #${trade.id} (${trade.side} ${trade.pnl > 0 ? 'WIN' : 'LOSS'})`);
      }
    } catch (e) {
      console.error(`[Phenomena] Error detecting ${key}:`, e.message);
    }
  }

  // Always update directional spam streak (regardless of detect)
  if (!phenomenaState.directional_spam) phenomenaState.directional_spam = {};
  const ds = phenomenaState.directional_spam;
  if (ds.streak_side === trade.side) {
    ds.current_streak = (ds.current_streak || 1) + 1;
  } else {
    ds.streak_side = trade.side;
    ds.current_streak = 1;
  }
  ds.last_trade_at = Date.now();

  // Decay cooldowns on wins
  if (trade.pnl > 0) {
    for (const [key, s] of Object.entries(phenomenaState)) {
      if (key === 'ema_lag_reversal' && s.active_side === trade.side) {
        // Win on the same side = reversal over, clear guard
        s.consecutive_losses = 0;
        s.cooldown_remaining = 0;
        s.active_side = null;
        console.log(`[Phenomena] CLEARED: EMA Lag Reversal (${trade.side} WIN)`);
      }
      if (key === 'side_streak_loss' && s.losing_side === trade.side) {
        s.streak = Math.max(0, (s.streak || 0) - 1);
      }
    }
  }

  // Time-based decay
  const now = Date.now();
  for (const [key, s] of Object.entries(phenomenaState)) {
    if (s.decay_after && now > s.decay_after) {
      if (key === 'flat_market_chop') s.recent_chop_losses = 0;
      if (key === 'expensive_entry_trap') s.recent_expensive_losses = 0;
      delete s.decay_after;
    }
  }

  saveState();
}

// Called before entering a trade — returns combined guard result
function checkGuards(signal) {
  const ctx = { phenomenaState };
  const results = [];

  // Decay cooldowns for ema_lag_reversal
  if (phenomenaState.ema_lag_reversal?.cooldown_remaining > 0) {
    // Cooldown ticks down each time we check (per market cycle)
  }

  for (const [key, phenomenon] of Object.entries(PHENOMENA)) {
    try {
      const guard = phenomenon.guard(signal, ctx);
      if (guard.block || guard.tighten || guard.reason) {
        results.push({ key, ...guard });
      }
    } catch (e) {
      console.error(`[Phenomena] Guard error ${key}:`, e.message);
    }
  }

  // Combine: if any block, block. Merge all tighten multipliers (take max).
  const blocked = results.find(r => r.block);
  if (blocked) return { block: true, reason: blocked.reason, phenomena: results };

  const tightens = results.filter(r => r.tighten);
  let combined_tighten = null;
  if (tightens.length > 0) {
    combined_tighten = {};
    for (const t of tightens) {
      for (const [k, v] of Object.entries(t.tighten)) {
        combined_tighten[k] = Math.max(combined_tighten[k] || 1, v);
      }
    }
  }

  const reasons = results.filter(r => r.reason).map(r => r.reason);
  return { 
    block: false, 
    tighten: combined_tighten, 
    reasons,
    phenomena: results,
  };
}

// Consume a cooldown tick (called when a trade is skipped due to guard)
function consumeCooldown(key) {
  if (phenomenaState[key]?.cooldown_remaining > 0) {
    phenomenaState[key].cooldown_remaining--;
    saveState();
  }
}

function getState() { return { state: phenomenaState, log: phenomenaLog.slice(-50), phenomena: Object.keys(PHENOMENA).map(k => ({ key: k, name: PHENOMENA[k].name, description: PHENOMENA[k].description })) }; }

// Init
loadState();

function resetState() {
  phenomenaState = {};
  phenomenaLog = [];
  saveState();
  console.log('[Phenomena] State reset');
}

module.exports = { onTradeResolved, checkGuards, consumeCooldown, getState, resetState, PHENOMENA };
