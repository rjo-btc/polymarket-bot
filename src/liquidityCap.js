/**
 * Liquidity-Aware Position Sizing Cap
 * 
 * Sits on top of Kelly/7% sizing as a ceiling.
 * Prevents oversizing into thin order books based on:
 *   - Entry price (determines shares/dollar and spread)
 *   - Time to market end (earlier = deeper books)
 *   - R:R-aware exec cost tolerance (cheap entries tolerate more)
 * 
 * Usage: const cappedStake = liquidityCap(stake, entryPrice, secsToEnd)
 */

// Estimated book depth (shares at best bid/ask) for 5m BTC markets
function estimateBookDepth(secsToEnd, entryPrice) {
  // Price multiplier: mid-range prices have deepest books
  let priceMult;
  if (entryPrice <= 0.15) priceMult = 0.3;
  else if (entryPrice <= 0.25) priceMult = 0.5;
  else if (entryPrice <= 0.35) priceMult = 0.7;
  else if (entryPrice <= 0.50) priceMult = 1.0;
  else if (entryPrice <= 0.65) priceMult = 0.9;
  else if (entryPrice <= 0.75) priceMult = 0.7;
  else priceMult = 0.4;

  // Time multiplier: earlier entries = thicker books
  let timeMult;
  if (secsToEnd >= 250) timeMult = 1.0;
  else if (secsToEnd >= 200) timeMult = 0.85;
  else if (secsToEnd >= 170) timeMult = 0.70;
  else if (secsToEnd >= 150) timeMult = 0.60;
  else timeMult = 0.40;

  const BASE_DEPTH = parseInt(process.env.BOOK_DEPTH_BASE) || 800;
  return Math.round(BASE_DEPTH * priceMult * timeMult);
}

// Estimate execution cost for a given position size
function estimateExecCost(shares, bookDepth, entryPrice) {
  // Spread: wider at extreme prices
  const spread = (entryPrice < 0.3 || entryPrice > 0.7) ? 0.04 : 0.02;
  const spreadCost = shares * (spread / 2);

  // Market impact: walking the book when size > depth
  let marketImpact = 0;
  if (shares > bookDepth) {
    const tier1 = Math.min(shares - bookDepth, bookDepth);
    const tier2 = Math.max(0, shares - bookDepth * 2);
    marketImpact = tier1 * 0.01 + tier2 * 0.03;
  }

  // Fill delay: ~0.5 cents per share
  const fillDelay = shares * 0.005;

  return spreadCost + marketImpact + fillDelay;
}

// R:R-aware execution cost tolerance
function getMaxExecCostPct(entryPrice) {
  const rr = (1 - entryPrice) / entryPrice;
  if (rr >= 3.0) return 0.15;  // cheap entries (≤0.25): high R:R compensates
  if (rr >= 1.5) return 0.10;  // mid-cheap (0.25-0.40)
  if (rr >= 0.8) return 0.07;  // mid (0.40-0.55)
  return 0.04;                  // expensive (0.55+): thin margin
}

/**
 * Calculate the maximum stake allowed by liquidity constraints.
 * 
 * @param {number} entryPrice - token price (0-1)
 * @param {number} secsToEnd - seconds until market resolution
 * @returns {{ maxStake: number, maxShares: number, bookDepth: number, execCostPct: string }}
 */
function calcLiquidityMax(entryPrice, secsToEnd) {
  const bookDepth = estimateBookDepth(secsToEnd, entryPrice);
  const maxExecPct = getMaxExecCostPct(entryPrice);

  // Hard ceiling: never exceed 2x book depth in shares
  const hardMaxShares = bookDepth * 2;
  const hardMaxStake = hardMaxShares * entryPrice;

  // Binary search for max stake where exec cost stays under tolerance
  let lo = 10, hi = Math.min(5000, hardMaxStake);
  let bestStake = 10;

  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const shares = mid / entryPrice;
    const execCost = estimateExecCost(shares, bookDepth, entryPrice);
    const costPct = execCost / mid;

    if (costPct <= maxExecPct && shares <= hardMaxShares) {
      bestStake = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const finalShares = Math.round(bestStake / entryPrice);
  const finalExec = estimateExecCost(finalShares, bookDepth, entryPrice);

  return {
    maxStake: Math.round(bestStake),
    maxShares: finalShares,
    bookDepth,
    execCostPct: ((finalExec / bestStake) * 100).toFixed(1),
    tolerance: (maxExecPct * 100).toFixed(0),
  };
}

/**
 * Apply liquidity cap to a proposed stake.
 * Returns the capped stake and metadata.
 * 
 * @param {number} proposedStake - stake from Kelly/7% sizing
 * @param {number} entryPrice - token price
 * @param {number} secsToEnd - seconds to market end
 * @returns {{ stake: number, capped: boolean, reason: string|null, meta: object }}
 */
function liquidityCap(proposedStake, entryPrice, secsToEnd) {
  const liq = calcLiquidityMax(entryPrice, secsToEnd);

  if (proposedStake <= liq.maxStake) {
    return {
      stake: proposedStake,
      capped: false,
      reason: null,
      meta: liq,
    };
  }

  const proposedShares = Math.round(proposedStake / entryPrice);
  return {
    stake: liq.maxStake,
    capped: true,
    reason: `LIQUIDITY CAP: $${proposedStake.toFixed(0)} → $${liq.maxStake} (${proposedShares} shares → ${liq.maxShares} shares, book ~${liq.bookDepth}, ${liq.tolerance}% cost tolerance)`,
    meta: liq,
  };
}

module.exports = { liquidityCap, calcLiquidityMax, estimateBookDepth, estimateExecCost };
