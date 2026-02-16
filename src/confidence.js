/**
 * Confidence-Tiered Position Sizing
 * 
 * Scores each trade setup 0-100 based on how closely it matches
 * the profile of historical winning trades. Assigns a tier that
 * scales the Kelly-recommended position size.
 * 
 * Tiers:
 *   1 (Max Conviction)  — score >= 70 → 100% of Kelly size
 *   2 (Standard)        — score 40-69 → 85% of Kelly size (was 75%)
 *   3 (Low Conviction)  — score < 40  → 70% of Kelly size (was 50%)
 * 
 * Activated only after Kelly threshold (50 trades) is met.
 */

const { getAllPositions } = require('./db');

const TIER_MULTIPLIERS = {
  1: 1.0,    // Max conviction — full Kelly
  2: 0.85,   // Standard — 85% Kelly (was 75%)
  3: 0.70,   // Low conviction — 70% Kelly (was 50%)
};

const TIER_THRESHOLDS = {
  high: 70,  // score >= 70 → Tier 1
  mid: 40,   // score >= 40 → Tier 2
};

/**
 * Build a win profile from resolved trades — percentile-based, not hardcoded
 */
function buildWinProfile() {
  const positions = getAllPositions.all().filter(p => p.status === 'resolved');
  if (positions.length < 10) return null;

  const wins = positions.filter(p => p.pnl > 0);
  const losses = positions.filter(p => p.pnl <= 0);
  if (wins.length < 5) return null;

  // Parse PA data from entry reasons
  function parsePA(reason) {
    if (!reason) return {};
    const match = reason.match(/PA\[([^\]]+)\]/);
    if (!match) return {};
    const pa = {};
    match[1].split(',').forEach(part => {
      const [k, v] = part.split('=').map(s => s.trim());
      if (k && v) pa[k] = isNaN(v) ? v : parseFloat(v);
    });
    return pa;
  }

  function extract(trades) {
    return trades.map(t => {
      const pa = parsePA(t.entry_reason);
      return {
        entry_price: t.entry_price,
        seconds_to_end: t.seconds_to_end_at_entry,
        dist_bps: pa.dist || null,
        slope: pa.slope != null ? Math.abs(pa.slope) : null,
        pnl: t.pnl,
        return_pct: t.stake_usd > 0 ? (t.pnl / t.stake_usd) * 100 : 0,
      };
    });
  }

  const winData = extract(wins);
  const lossData = extract(losses);

  // Compute percentiles for win traits
  function percentiles(arr) {
    const sorted = [...arr].filter(x => x != null).sort((a, b) => a - b);
    if (sorted.length === 0) return { p25: null, p50: null, p75: null, min: null, max: null };
    return {
      p25: sorted[Math.floor(sorted.length * 0.25)],
      p50: sorted[Math.floor(sorted.length * 0.50)],
      p75: sorted[Math.floor(sorted.length * 0.75)],
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  }

  // Weight by return — best wins define the ideal profile
  const sortedByReturn = [...winData].sort((a, b) => b.return_pct - a.return_pct);
  const topWins = sortedByReturn.slice(0, Math.ceil(sortedByReturn.length * 0.5));

  return {
    entry_price: percentiles(topWins.map(w => w.entry_price)),
    seconds_to_end: percentiles(topWins.map(w => w.seconds_to_end)),
    dist_bps: percentiles(topWins.map(w => w.dist_bps)),
    slope: percentiles(topWins.map(w => w.slope)),
    total_wins: wins.length,
    total_losses: losses.length,
    total_trades: positions.length,
    // Also store loss profile for penalty scoring
    loss_entry_price: percentiles(lossData.map(l => l.entry_price)),
    loss_dist_bps: percentiles(lossData.map(l => l.dist_bps)),
  };
}

/**
 * Score a trade setup 0-100 based on how well it matches the win profile
 * 
 * @param {object} setup - { entry_price, seconds_to_end, dist_bps, slope, side }
 * @returns {object} - { score, tier, multiplier, breakdown }
 */
function scoreSetup(setup) {
  const profile = buildWinProfile();
  if (!profile) {
    return { score: 50, tier: 2, multiplier: TIER_MULTIPLIERS[2], breakdown: { status: 'insufficient_data' } };
  }

  const breakdown = {};
  let totalScore = 0;
  let totalWeight = 0;

  // === Entry Price Score (weight: 35) ===
  // Best wins come from specific price ranges — score by proximity to win sweet spot
  const weight_price = 35;
  if (setup.entry_price != null && profile.entry_price.p50 != null) {
    const ideal = profile.entry_price.p50;
    const range = Math.max(0.15, (profile.entry_price.p75 || 0.65) - (profile.entry_price.p25 || 0.3));
    const dist = Math.abs(setup.entry_price - ideal);
    const priceScore = Math.max(0, 100 - (dist / range) * 100);
    
    // Penalty if entry price is in the loss zone
    if (profile.loss_entry_price.p50 != null) {
      const lossProximity = Math.abs(setup.entry_price - profile.loss_entry_price.p50);
      const winProximity = dist;
      // If closer to loss profile than win profile, penalize
      if (lossProximity < winProximity) {
        breakdown.price_penalty = 'closer to loss profile';
      }
    }
    
    breakdown.entry_price = { score: Math.round(priceScore), ideal: Math.round(ideal * 1000) / 1000 };
    totalScore += priceScore * weight_price;
    totalWeight += weight_price;
  }

  // === EMA Distance Score (weight: 25) ===
  const weight_dist = 25;
  if (setup.dist_bps != null && profile.dist_bps.p50 != null) {
    const ideal = profile.dist_bps.p50;
    const range = Math.max(2, (profile.dist_bps.p75 || 10) - (profile.dist_bps.p25 || 2));
    // Higher dist is generally better (stronger trend), so score linearly with bonus for above ideal
    let distScore;
    if (setup.dist_bps >= ideal) {
      distScore = Math.min(100, 80 + (setup.dist_bps - ideal) / range * 20);
    } else {
      distScore = Math.max(0, (setup.dist_bps / ideal) * 80);
    }
    breakdown.dist_bps = { score: Math.round(distScore), ideal: Math.round(ideal * 10) / 10 };
    totalScore += distScore * weight_dist;
    totalWeight += weight_dist;
  }

  // === Slope Score (weight: 20) ===
  const weight_slope = 20;
  if (setup.slope != null && profile.slope.p50 != null) {
    const ideal = profile.slope.p50;
    const absSlope = Math.abs(setup.slope);
    // Stronger slope = better, score relative to win profile
    let slopeScore;
    if (absSlope >= ideal) {
      slopeScore = Math.min(100, 80 + (absSlope - ideal) / Math.max(1, ideal) * 20);
    } else {
      slopeScore = Math.max(0, (absSlope / ideal) * 80);
    }
    breakdown.slope = { score: Math.round(slopeScore), ideal: Math.round(ideal * 100) / 100 };
    totalScore += slopeScore * weight_slope;
    totalWeight += weight_slope;
  }

  // === Timing Score (weight: 20) ===
  const weight_time = 20;
  if (setup.seconds_to_end != null && profile.seconds_to_end.p50 != null) {
    const ideal = profile.seconds_to_end.p50;
    const range = Math.max(10, (profile.seconds_to_end.p75 || 180) - (profile.seconds_to_end.p25 || 155));
    const dist = Math.abs(setup.seconds_to_end - ideal);
    const timeScore = Math.max(0, 100 - (dist / range) * 100);
    breakdown.timing = { score: Math.round(timeScore), ideal: Math.round(ideal) };
    totalScore += timeScore * weight_time;
    totalWeight += weight_time;
  }

  // Compute final score
  const finalScore = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 50;
  const tier = finalScore >= TIER_THRESHOLDS.high ? 1 : finalScore >= TIER_THRESHOLDS.mid ? 2 : 3;

  return {
    score: finalScore,
    tier,
    tier_label: tier === 1 ? 'MAX CONVICTION' : tier === 2 ? 'STANDARD' : 'LOW CONVICTION',
    multiplier: TIER_MULTIPLIERS[tier],
    breakdown,
    profile_trades: profile.total_trades,
  };
}

module.exports = { scoreSetup, buildWinProfile, TIER_MULTIPLIERS, TIER_THRESHOLDS };
