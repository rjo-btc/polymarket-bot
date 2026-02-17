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
  // FIXED: Don't punish very cheap entries (often indicate strong moves)
  let priceMult;
  if (entryPrice <= 0.10) priceMult = 0.8;  // FIXED: was 0.3, now 0.8 (cheap = good R:R)
  else if (entryPrice <= 0.20) priceMult = 0.7;  // FIXED: was 0.3/0.5, now 0.7
  else if (entryPrice <= 0.30) priceMult = 0.8;  // FIXED: was 0.5, now 0.8
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

  const BASE_DEPTH = parseInt(process.env.BOOK_DEPTH_BASE) || 1500;  // INCREASED: was 800, now 1500
  return Math.round(BASE_DEPTH * priceMult * timeMult);
}

// Estimate execution cost for a given position size
function estimateExecCost(shares, bookDepth, entryPrice) {
  // FIXED: More reasonable execution costs, especially for cheap entries
  
  // Spread: narrower spreads, less punitive for cheap entries
  const spread = (entryPrice < 0.2) ? 0.02 : (entryPrice < 0.4 || entryPrice > 0.7) ? 0.03 : 0.015;
  const spreadCost = shares * (spread / 2);

  // Market impact: more lenient, 3x book depth before major impact
  let marketImpact = 0;
  if (shares > bookDepth * 1.5) {  // FIXED: was bookDepth, now 1.5x
    const tier1 = Math.min(shares - bookDepth * 1.5, bookDepth);
    const tier2 = Math.max(0, shares - bookDepth * 2.5);
    marketImpact = tier1 * 0.005 + tier2 * 0.015;  // FIXED: was 0.01/0.03, now 0.005/0.015
  }

  // Fill delay: proportional to entry price, not fixed per share
  const fillDelayRate = Math.max(0.001, entryPrice * 0.05);  // FIXED: was 0.005 flat, now proportional
  const fillDelay = shares * fillDelayRate;

  return spreadCost + marketImpact + fillDelay;
}

// R:R-aware execution cost tolerance
function getMaxExecCostPct(entryPrice) {
  const rr = (1 - entryPrice) / entryPrice;
  // FIXED: More generous tolerances, especially for high R:R trades
  if (rr >= 10.0) return 0.25;  // ADDED: ultra-cheap entries (≤0.10): massive R:R
  if (rr >= 3.0) return 0.20;   // INCREASED: was 0.15, now 0.20
  if (rr >= 1.5) return 0.15;   // INCREASED: was 0.10, now 0.15
  if (rr >= 0.8) return 0.10;   // INCREASED: was 0.07, now 0.10
  return 0.06;                  // INCREASED: was 0.04, now 0.06
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

  // Hard ceiling: never exceed 3x book depth in shares (was 2x)
  const hardMaxShares = bookDepth * 3;  // INCREASED: was 2x, now 3x
  const hardMaxStake = hardMaxShares * entryPrice;

  // Binary search for max stake where exec cost stays under tolerance
  let lo = 50, hi = Math.min(10000, hardMaxStake);  // FIXED: min 50 (was 10), max 10k (was 5k)
  let bestStake = 50;

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
  // EXEMPTION: Very cheap entries (≤0.10) have excellent R:R - skip liquidity cap
  if (entryPrice <= 0.10) {
    return {
      stake: proposedStake,
      capped: false,
      reason: `LIQUIDITY CAP BYPASSED: Entry price ${entryPrice.toFixed(3)} ≤ 0.10 (excellent R:R justifies execution costs)`,
      meta: { exemption: true, entryPrice, rr: ((1 - entryPrice) / entryPrice).toFixed(2) },
    };
  }

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
