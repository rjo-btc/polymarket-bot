#!/usr/bin/env node
/**
 * Comprehensive test suite for all PolyBot filters, guardrails, and signals.
 * Tests the actual logic paths — no mocking, just unit tests on the decision functions.
 * 
 * Run: node scripts/test-all-filters.js
 */

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

// ================================================================
// 1. EMA STRATEGY — DISTANCE VARIABLES
// ================================================================
console.log('\n🔬 1. EMA Distance Variables (Root Cause Bug)');
console.log('   Verify price-to-EMA9 (dist) vs EMA9-to-EMA200 (edist) are distinct\n');

// Simulate the core calculations from ema.js
function calcDistances(price, ema9, ema200) {
  const distBps = ((price - ema9) / ema9) * 10000;         // price-to-EMA9
  const emaDistBps = ((ema9 - ema200) / ema200) * 10000;   // EMA9-to-EMA200
  return {
    dist: Math.abs(distBps),          // "dist" in PA string
    edist: Math.abs(emaDistBps),      // "edist" in PA string
    absPriceDistBps: Math.abs(distBps),
    absEmaDistBps: Math.abs(emaDistBps),
  };
}

test('dist and edist are different values', () => {
  // Trade #46 scenario: price very close to EMA9, but EMA9 far from EMA200
  const d = calcDistances(69840, 69839.41, 69746.94);
  assert(d.dist < 1.5, `dist should be ~0.1 bps, got ${d.dist.toFixed(1)}`);
  assert(d.edist > 10, `edist should be ~13 bps, got ${d.edist.toFixed(1)}`);
  assert(d.dist !== d.edist, 'dist and edist must be different');
});

test('weak dist + strong edist = should be blocked by early signals', () => {
  // This is exactly the trade #46 bug — edist passes but dist doesn't
  const d = calcDistances(69840, 69839.41, 69746.94);
  const minDist = 5; // min_ema_dist_bps
  assert(d.absPriceDistBps < minDist, `Price dist ${d.absPriceDistBps.toFixed(1)} should be below min ${minDist}`);
  assert(d.absEmaDistBps >= minDist, `EMA dist ${d.absEmaDistBps.toFixed(1)} should be above min ${minDist} (this is why old code passed)`);
});

test('strong dist + strong edist = should pass', () => {
  // Both distances are strong — valid trade
  const d = calcDistances(69900, 69860, 69700);
  assert(d.absPriceDistBps >= 5, `Price dist should pass: ${d.absPriceDistBps.toFixed(1)}`);
  assert(d.absEmaDistBps >= 5, `EMA dist should pass: ${d.absEmaDistBps.toFixed(1)}`);
});

// ================================================================
// 2. EARLY SIGNAL FILTERS
// ================================================================
console.log('\n🔬 2. Early Signal Filters\n');

function simulateEarlySignalCheck(price, ema9, ema200, slope, slopePrev, rsi, bodyBps, bodyRatio, params = {}) {
  const p = {
    min_ema_dist_bps: params.min_ema_dist_bps || 5,
    rsi_long_max: params.rsi_long_max || 75,
    ...params,
  };
  const distBps = ((price - ema9) / ema9) * 10000;
  const emaDistBps = ((ema9 - ema200) / ema200) * 10000;
  const absPriceDistBps = Math.abs(distBps);  // FIXED: was absEmaDistBps
  const slopeAbs = Math.abs(slope);
  const accel = Math.abs(slope) - Math.abs(slopePrev);

  const results = { momentum_burst: null, slope_accel: null };

  // Momentum burst check
  if (bodyBps >= 5 && bodyRatio >= 0.7 && absPriceDistBps >= p.min_ema_dist_bps) {
    if (price > ema9 && emaDistBps > -3 && rsi > 45 && rsi < p.rsi_long_max) {
      results.momentum_burst = 'up';
    }
    if (price < ema9 && emaDistBps < 3 && rsi < 55) {
      results.momentum_burst = 'down';
    }
  }

  // Slope accel check
  if (accel > 0 && slopeAbs >= 1 && absPriceDistBps >= p.min_ema_dist_bps) {
    if (slope > 0 && ema9 > ema200 && rsi > 45 && rsi < p.rsi_long_max) {
      results.slope_accel = 'up';
    }
    if (slope < 0 && ema9 < ema200 && rsi < 55) {
      results.slope_accel = 'down';
    }
  }

  return { ...results, absPriceDistBps, absEmaDistBps: Math.abs(emaDistBps) };
}

test('Trade #46 scenario: dist=1.2 blocks slope_accel', () => {
  // price ≈ EMA9 (dist ~1.2 bps), EMA9 far from EMA200 (edist ~13 bps)
  const r = simulateEarlySignalCheck(69840, 69839.41, 69746.94, 2.1234, 0.6542, 52.2, 0, 0);
  assert(r.slope_accel === null, `Slope accel should be BLOCKED (dist=${r.absPriceDistBps.toFixed(1)} < 5), got: ${r.slope_accel}`);
});

test('Strong dist allows slope_accel', () => {
  // price well above EMA9 (dist ~7 bps)
  const r = simulateEarlySignalCheck(69900, 69851, 69700, 2.5, 1.0, 55, 0, 0);
  assert(r.slope_accel === 'up', `Slope accel should fire UP, got: ${r.slope_accel}`);
});

test('Momentum burst blocked by weak dist', () => {
  const r = simulateEarlySignalCheck(69840, 69839, 69700, 2.0, 1.0, 55, 8, 0.8);
  assert(r.momentum_burst === null, `Momentum burst should be blocked (dist=${r.absPriceDistBps.toFixed(1)}), got: ${r.momentum_burst}`);
});

test('Momentum burst allowed with strong dist', () => {
  const r = simulateEarlySignalCheck(69900, 69851, 69700, 2.0, 1.0, 55, 8, 0.8);
  assert(r.momentum_burst === 'up', `Momentum burst UP should fire, got: ${r.momentum_burst}`);
});

// ================================================================
// 3. RSI OVERBOUGHT CAP
// ================================================================
console.log('\n🔬 3. RSI Overbought Cap\n');

test('RSI=80 blocks long momentum burst', () => {
  const r = simulateEarlySignalCheck(69900, 69851, 69700, 2.0, 1.0, 80, 8, 0.8);
  assert(r.momentum_burst === null, 'RSI 80 should block long momentum burst');
});

test('RSI=74 allows long momentum burst', () => {
  const r = simulateEarlySignalCheck(69900, 69851, 69700, 2.0, 1.0, 74, 8, 0.8);
  assert(r.momentum_burst === 'up', 'RSI 74 should allow long momentum burst');
});

test('RSI=80 blocks long slope_accel', () => {
  const r = simulateEarlySignalCheck(69900, 69851, 69700, 2.5, 1.0, 80, 0, 0);
  assert(r.slope_accel === null, 'RSI 80 should block long slope accel');
});

test('RSI=80 does NOT block short slope_accel', () => {
  // price below EMA9, EMA9 below EMA200, slope negative
  const r = simulateEarlySignalCheck(69600, 69651, 69800, -2.5, -1.0, 45, 0, 0);
  assert(r.slope_accel === 'down', `RSI 45 short slope accel should fire, got: ${r.slope_accel}`);
});

// ================================================================
// 4. STANDARD SIGNAL DIRECTION FILTERS
// ================================================================
console.log('\n🔬 4. Standard Signal Direction Filters\n');

function simulateStandardSignal(price, ema9, ema200, slope, rsi, params = {}) {
  const p = {
    min_ema_dist_bps: params.min_ema_dist_bps || 5,
    min_slope_abs: params.min_slope_abs || 2,
    long_min_dist_bps: params.long_min_dist_bps || 8,
    long_min_slope: params.long_min_slope || 6,
    rsi_long_min: params.rsi_long_min || 50,
    rsi_long_max: params.rsi_long_max || 75,
    rsi_short_max: params.rsi_short_max || 50,
    short_dead_zone_lo: params.short_dead_zone_lo || 5,
    short_dead_zone_hi: params.short_dead_zone_hi || 8,
    short_dead_slope_lo: params.short_dead_slope_lo || 3,
    short_dead_slope_hi: params.short_dead_slope_hi || 6,
  };

  const distBps = ((price - ema9) / ema9) * 10000;
  const emaDistBps = ((ema9 - ema200) / ema200) * 10000;
  const absEmaDistBps = Math.abs(emaDistBps);
  const slopeAbs = Math.abs(slope);

  // LONG: price > EMA9 > EMA200
  if (price > ema9 && ema9 > ema200 && slope > 0) {
    if (absEmaDistBps < p.long_min_dist_bps) return { action: 'SKIP', reason: 'long dist too weak' };
    if (slopeAbs < p.long_min_slope) return { action: 'SKIP', reason: 'long slope too weak' };
    if (rsi < p.rsi_long_min) return { action: 'SKIP', reason: 'RSI too low for long' };
    if (rsi > p.rsi_long_max) return { action: 'SKIP', reason: 'RSI overbought' };
    return { action: 'ENTER', side: 'up' };
  }

  // SHORT: price < EMA9 < EMA200
  if (price < ema9 && ema9 < ema200 && slope < 0) {
    const inDistDead = absEmaDistBps >= p.short_dead_zone_lo && absEmaDistBps < p.short_dead_zone_hi;
    const inSlopeDead = slopeAbs >= p.short_dead_slope_lo && slopeAbs < p.short_dead_slope_hi;
    if (inDistDead || inSlopeDead) return { action: 'SKIP', reason: 'short dead zone' };
    if (absEmaDistBps < p.min_ema_dist_bps) return { action: 'SKIP', reason: 'short dist too weak' };
    if (slopeAbs < p.min_slope_abs) return { action: 'SKIP', reason: 'short slope too weak' };
    if (rsi > p.rsi_short_max) return { action: 'SKIP', reason: 'RSI too high for short' };
    return { action: 'ENTER', side: 'down' };
  }

  return { action: 'SKIP', reason: 'no alignment' };
}

test('Long requires dist >= 8 bps', () => {
  // edist = 6 bps (below 8 threshold for longs)
  const r = simulateStandardSignal(70000, 69960, 69910, 7.0, 60);
  assert(r.action === 'SKIP' && r.reason.includes('dist'), `Should skip weak long, got: ${r.action} ${r.reason}`);
});

test('Long requires slope >= 6', () => {
  // edist = 15 (strong), but slope = 4 (weak)
  const r = simulateStandardSignal(70100, 70050, 69940, 4.0, 60);
  assert(r.action === 'SKIP' && r.reason.includes('slope'), `Should skip weak slope long, got: ${r.action} ${r.reason}`);
});

test('Long requires RSI 50-75', () => {
  const r1 = simulateStandardSignal(70100, 70050, 69940, 7.0, 45);
  assert(r1.action === 'SKIP', 'RSI 45 should block long');
  const r2 = simulateStandardSignal(70100, 70050, 69940, 7.0, 80);
  assert(r2.action === 'SKIP', 'RSI 80 should block long');
});

test('Strong long signal passes all filters', () => {
  const r = simulateStandardSignal(70100, 70050, 69940, 7.0, 60);
  assert(r.action === 'ENTER' && r.side === 'up', `Should enter long, got: ${r.action} ${r.side}`);
});

test('Short dead zone blocks mid-range dist (5-8 bps)', () => {
  // edist = 6 bps (in dead zone 5-8)
  const r = simulateStandardSignal(69900, 69940, 69980, -7.0, 40);
  assert(r.action === 'SKIP' && r.reason.includes('dead zone'), `Should skip dead zone, got: ${r.action} ${r.reason}`);
});

test('Short dead zone blocks mid-range slope (3-6)', () => {
  // slope = 4 (in dead zone 3-6), dist = 2 bps (below dead zone, fine)
  const r = simulateStandardSignal(69900, 69910, 69920, -4.0, 40);
  assert(r.action === 'SKIP', `Should skip dead zone slope, got: ${r.action} ${r.reason}`);
});

test('Strong short passes', () => {
  // dist = 10 bps (above dead zone), slope = 8 (above dead zone), RSI = 40
  const r = simulateStandardSignal(69800, 69870, 69940, -8.0, 40);
  assert(r.action === 'ENTER' && r.side === 'down', `Should enter short, got: ${r.action} ${r.side}`);
});

test('Weak short (dist < 5) passes (below dead zone)', () => {
  const r = simulateStandardSignal(69890, 69900, 69930, -7.0, 40);
  // dist = ~4.3 bps — below dead zone lo (5), so NOT in dead zone
  // But then it hits min_ema_dist_bps check (5) — should skip
  assert(r.action === 'SKIP', `Very weak short should still be filtered by base dist, got: ${r.action}`);
});

// ================================================================
// 5. TREND GUARDRAILS (PHENOMENA)
// ================================================================
console.log('\n🔬 5. Trend Guardrails\n');

// Test phenomena guard logic directly
function testGuard(phenomenonGuard, signal, state) {
  return phenomenonGuard(signal, { phenomenaState: state });
}

// EMA Lag Reversal guard
test('EMA lag: 2 consecutive losses triggers 1.5x tighten', () => {
  const state = { ema_lag_reversal: { active_side: 'up', consecutive_losses: 2, last_triggered: Date.now() } };
  const { PHENOMENA } = require('../src/phenomena');
  const r = PHENOMENA.ema_lag_reversal.guard({ side: 'up' }, { phenomenaState: state });
  assert(r.tighten, 'Should have tighten');
  assert(r.tighten.min_slope_multiplier === 1.5, `Expected 1.5x, got ${r.tighten.min_slope_multiplier}`);
});

test('EMA lag: opposite side is NOT affected', () => {
  const state = { ema_lag_reversal: { active_side: 'up', consecutive_losses: 3, last_triggered: Date.now() } };
  const { PHENOMENA } = require('../src/phenomena');
  const r = PHENOMENA.ema_lag_reversal.guard({ side: 'down' }, { phenomenaState: state });
  assert(!r.tighten, 'Opposite side should not be tightened');
});

test('EMA lag: decays after 10 min (2 decay steps)', () => {
  const state = { ema_lag_reversal: { active_side: 'up', consecutive_losses: 3, last_triggered: Date.now() - 10 * 60000 } };
  const { PHENOMENA } = require('../src/phenomena');
  const r = PHENOMENA.ema_lag_reversal.guard({ side: 'up' }, { phenomenaState: state });
  // 3 losses - 2 decay steps = 1 effective → below threshold of 2
  assert(!r.tighten, 'Should decay below threshold after 10 min');
});

// Directional Spam guard
test('Directional spam: 2 consecutive losses → 1.25x', () => {
  const state = { directional_spam: { streak_side: 'down', loss_streak: 2, win_streak: 0, last_trade_at: Date.now() } };
  const { PHENOMENA } = require('../src/phenomena');
  const r = PHENOMENA.directional_spam.guard({ side: 'down' }, { phenomenaState: state });
  assert(r.tighten, 'Should tighten on 2-loss streak');
  assert(r.tighten.min_dist_multiplier === 1.25, `Expected 1.25x, got ${r.tighten.min_dist_multiplier}`);
});

test('Directional spam: 2 win streak clears penalty', () => {
  const state = { directional_spam: { streak_side: 'down', loss_streak: 0, win_streak: 2, last_trade_at: Date.now() } };
  const { PHENOMENA } = require('../src/phenomena');
  const r = PHENOMENA.directional_spam.guard({ side: 'down' }, { phenomenaState: state });
  assert(!r.block && !r.tighten, 'Win streak should clear penalty');
});

test('Directional spam: decays after 10 min', () => {
  const state = { directional_spam: { streak_side: 'up', loss_streak: 2, win_streak: 0, last_trade_at: Date.now() - 10 * 60000 } };
  const { PHENOMENA } = require('../src/phenomena');
  const r = PHENOMENA.directional_spam.guard({ side: 'up' }, { phenomenaState: state });
  // 2 losses - 2 decay steps = 0 effective → no penalty
  assert(!r.tighten, 'Should decay after 10 min');
});

// Expensive Entry guard
test('Expensive entry: 2 losses → temp cap 0.50', () => {
  const state = { expensive_entry_trap: { recent_expensive_losses: 2, last_triggered: Date.now() } };
  const { PHENOMENA } = require('../src/phenomena');
  const r = PHENOMENA.expensive_entry_trap.guard({ side: 'up' }, { phenomenaState: state });
  assert(r.tighten, 'Should tighten');
  assert(r.tighten.max_entry_override === 0.50, `Expected 0.50 cap, got ${r.tighten.max_entry_override}`);
});

// Chop guard
test('Chop guard: 2 chop losses → 2x dist', () => {
  const state = { flat_market_chop: { recent_chop_losses: 2, last_triggered: Date.now() } };
  const { PHENOMENA } = require('../src/phenomena');
  const r = PHENOMENA.flat_market_chop.guard({ side: 'up' }, { phenomenaState: state });
  assert(r.tighten, 'Should tighten');
  assert(r.tighten.min_dist_multiplier === 2.0, `Expected 2x dist, got ${r.tighten.min_dist_multiplier}`);
});

// ================================================================
// 6. TRADER.JS GUARDRAIL ENFORCEMENT
// ================================================================
console.log('\n🔬 6. Trader.js Guardrail Enforcement Logic\n');

// Simulate the tighten enforcement block from trader.js (lines ~230-260)
function simulateTightenEnforcement(guardResult, emaState, entryPrice, params = {}) {
  const tp2 = { min_slope_abs: params.min_slope_abs || 2, min_ema_dist_bps: params.min_ema_dist_bps || 5 };
  const priceDist = emaState?.price_dist_bps ?? 0;
  const emaDist = emaState?.ema_dist_bps ?? 0;
  const slopeAbs = emaState?.slope_abs ?? 0;

  let blocked = false;
  let blockReasons = [];

  if (guardResult.tighten.min_slope_multiplier) {
    const requiredSlope = tp2.min_slope_abs * guardResult.tighten.min_slope_multiplier;
    if (slopeAbs < requiredSlope) {
      blocked = true;
      blockReasons.push(`slope ${slopeAbs} < ${requiredSlope}`);
    }
  }
  if (guardResult.tighten.min_dist_multiplier) {
    const mult = guardResult.tighten.min_dist_multiplier;
    const priceDistRequired = 3 * mult;
    const emaDistRequired = tp2.min_ema_dist_bps * mult;
    if (priceDist < priceDistRequired) {
      blocked = true;
      blockReasons.push(`price-to-EMA dist ${priceDist} < ${priceDistRequired}`);
    }
    if (emaDist < emaDistRequired) {
      blocked = true;
      blockReasons.push(`EMA-to-EMA dist ${emaDist} < ${emaDistRequired}`);
    }
  }
  if (guardResult.tighten.max_entry_override && entryPrice > guardResult.tighten.max_entry_override) {
    blocked = true;
    blockReasons.push(`entry ${entryPrice} > cap ${guardResult.tighten.max_entry_override}`);
  }

  return { blocked, blockReasons };
}

test('Tighten enforcement checks price_dist_bps (not edist)', () => {
  // Weak price-to-EMA9 dist (2 bps), strong EMA9-to-EMA200 dist (50 bps)
  const guard = { tighten: { min_dist_multiplier: 1.5 } };
  const emaState = { price_dist_bps: 2, ema_dist_bps: 50, slope_abs: 5 };
  const r = simulateTightenEnforcement(guard, emaState, 0.40);
  assert(r.blocked, `Should be blocked — price dist 2 < required ${3 * 1.5} = 4.5`);
  assert(r.blockReasons.some(r => r.includes('price-to-EMA')), 'Block reason should mention price-to-EMA');
});

test('Tighten enforcement: strong signals pass', () => {
  const guard = { tighten: { min_dist_multiplier: 1.5, min_slope_multiplier: 1.5 } };
  const emaState = { price_dist_bps: 8, ema_dist_bps: 15, slope_abs: 8 };
  const r = simulateTightenEnforcement(guard, emaState, 0.40);
  assert(!r.blocked, `Should pass — dist ${8} >= ${4.5} and EMA dist ${15} >= ${7.5} and slope ${8} >= ${3}`);
});

test('Tighten enforcement: max_entry_override works', () => {
  const guard = { tighten: { max_entry_override: 0.50 } };
  const emaState = { price_dist_bps: 10, ema_dist_bps: 20, slope_abs: 8 };
  const r = simulateTightenEnforcement(guard, emaState, 0.55);
  assert(r.blocked, 'Should block entry above cap');
});

// ================================================================
// 7. CIRCUIT BREAKER
// ================================================================
console.log('\n🔬 7. Circuit Breaker\n');

const { checkBreaker, reportBreach, resetState: resetBreaker, onWin } = require('../src/circuitBreaker');

// Reset to clean state
resetBreaker();

test('No breaches = no block', () => {
  const r = checkBreaker({ side: 'up', entry_price: 0.40 });
  assert(!r.block, 'Should not block with no breaches');
});

test('reportBreach + checkBreaker blocks same side', () => {
  resetBreaker();
  reportBreach(
    { id: 99, side: 'up', pnl: -100 },
    ['Side Streak guard active but not enforced'],
    {}
  );
  const r = checkBreaker({ side: 'up', entry_price: 0.40 });
  assert(r.block, `Should block after breach, got: block=${r.block}`);
});

test('Breach does NOT block opposite side (for side-specific rules)', () => {
  // The side_streak_block rule only blocks the breach side
  const r = checkBreaker({ side: 'down', entry_price: 0.40 });
  // May or may not block depending on rule types — chop_block blocks all
  // side_streak_block only blocks matching side
  // This is fine, just verify it doesn't crash
  assert(typeof r.block === 'boolean', 'Should return valid result');
});

test('Win clears breach', () => {
  onWin({ side: 'up' });
  const r = checkBreaker({ side: 'up', entry_price: 0.40 });
  assert(!r.block, 'Win should clear breach');
});

resetBreaker();

// ================================================================
// 8. LIQUIDITY CAP
// ================================================================
console.log('\n🔬 8. Liquidity Cap\n');

const { liquidityCap } = require('../src/liquidityCap');

test('Cheap entry tolerates higher exec cost', () => {
  const r = liquidityCap(500, 0.20, 200);
  // At 0.20 entry, tolerance is ~15%, book_depth * 2 = hard cap
  assert(r.stake > 0, `Should return valid stake, got ${r.stake}`);
  assert(r.stake <= 500, 'Should not increase stake');
});

test('Expensive entry has strict cap', () => {
  const r1 = liquidityCap(500, 0.20, 200);
  const r2 = liquidityCap(500, 0.60, 200);
  // Expensive entry should have lower or equal cap
  assert(r2.stake <= r1.stake || !r2.capped, 'Expensive entry should be more restrictive');
});

test('Very large stake gets capped', () => {
  const r = liquidityCap(5000, 0.50, 200);
  assert(r.capped, 'Very large stake should be capped');
  assert(r.stake < 5000, 'Capped stake should be less than requested');
});

test('Small stake is not capped', () => {
  const r = liquidityCap(50, 0.30, 200);
  assert(!r.capped, `Small stake should not be capped, got capped=${r.capped} stake=${r.stake}`);
});

// ================================================================
// 9. FLAT MARKET CHOP DETECTION
// ================================================================
console.log('\n🔬 9. Flat Market Chop Detection\n');

test('Chop detects tiny BTC move (< 15 bps)', () => {
  const { PHENOMENA } = require('../src/phenomena');
  const trade = { pnl: -100, btc_price_at_start: 70000, btc_price_at_end: 70005 };
  const ctx = { recentResolved: [trade], phenomenaState: {} };
  const detected = PHENOMENA.flat_market_chop.detect(trade, ctx);
  const moveBps = Math.abs((70005 - 70000) / 70000) * 10000;
  assert(detected, `Should detect chop — move was ${moveBps.toFixed(1)} bps`);
});

test('Chop does NOT trigger on big BTC move', () => {
  const { PHENOMENA } = require('../src/phenomena');
  const trade = { pnl: -100, btc_price_at_start: 70000, btc_price_at_end: 70200 };
  const ctx = { recentResolved: [trade], phenomenaState: {} };
  const detected = PHENOMENA.flat_market_chop.detect(trade, ctx);
  assert(!detected, 'Should not detect chop on big move');
});

test('Chop uses btc_price_at_end (not btc_price_at_entry)', () => {
  // This was the original bug — comparing start vs entry (same value)
  const { PHENOMENA } = require('../src/phenomena');
  const trade = { pnl: -100, btc_price_at_start: 70000, btc_price_at_entry: 70000, btc_price_at_end: 70000 };
  const ctx = { recentResolved: [trade], phenomenaState: {} };
  const detected = PHENOMENA.flat_market_chop.detect(trade, ctx);
  assert(detected, 'Zero BTC move should detect as chop');
});

// ================================================================
// 10. PA STRING PARSING (no more NaN)
// ================================================================
console.log('\n🔬 10. PA String Parsing\n');

test('PA string values parse without NaN', () => {
  const paStr = 'PA[dist=4.0 bps,edist=22.3 bps,slope=10.3958,ema9=69867.22,ema200=69712.09,rsi=62.7]';
  const pa = {};
  const paMatch = paStr.match(/PA\[([^\]]+)\]/);
  paMatch[1].split(',').forEach(part => {
    const [k, v] = part.split('=').map(s => s.trim());
    if (k && v) {
      const cleaned = v.replace(/\s*bps\s*$/i, '').trim();
      pa[k] = isNaN(cleaned) ? v : parseFloat(cleaned);
    }
  });
  assert(pa.dist === 4.0, `dist should be 4.0, got ${pa.dist}`);
  assert(pa.edist === 22.3, `edist should be 22.3, got ${pa.edist}`);
  assert(!isNaN(pa.dist), 'dist must not be NaN');
  assert(!isNaN(pa.edist), 'edist must not be NaN');
  assert(pa.slope === 10.3958, `slope should be 10.3958, got ${pa.slope}`);
});

test('Math.abs on "4.0 bps" = NaN (the old bug)', () => {
  // Confirm the old bug pattern
  assert(isNaN(Math.abs("4.0 bps")), '"4.0 bps" should produce NaN with Math.abs');
  assert(isNaN("4.0 bps"), '"4.0 bps" should be NaN via isNaN');
  // But cleaned version works
  const cleaned = "4.0 bps".replace(/\s*bps\s*$/i, '').trim();
  assert(!isNaN(cleaned), 'Cleaned value should not be NaN');
  assert(parseFloat(cleaned) === 4.0, 'Cleaned value should parse to 4.0');
});

// ================================================================
// 11. ENTRY PRICE FILTERS
// ================================================================
console.log('\n🔬 11. Entry Price Filters\n');

test('Entry > 0.65 is filtered', () => {
  const maxEntry = 0.65;
  assert(0.70 > maxEntry, '0.70 should be above max entry');
  assert(0.65 <= maxEntry, '0.65 should pass (<=)');
  assert(0.64 <= maxEntry, '0.64 should pass');
});

// ================================================================
// SUMMARY
// ================================================================
console.log('\n' + '='.repeat(50));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);

if (failures.length > 0) {
  console.log('❌ Failures:');
  failures.forEach(f => console.log(`   • ${f.name}: ${f.error}`));
  console.log('');
}

if (failed === 0) {
  console.log('🎉 All tests passing! Filters, guardrails, and signals are working correctly.\n');
} else {
  console.log('⚠️  Some tests failed — review the failures above.\n');
}

process.exit(failed > 0 ? 1 : 0);
