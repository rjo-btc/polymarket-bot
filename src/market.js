const GAMMA_API = 'https://gamma-api.polymarket.com/markets';
const CLOB_API = 'https://clob.polymarket.com';

let cachedMarket = null;
let cachedTokens = null;

/**
 * Find the current BTC 5-min market by constructing predictable slugs
 * and querying Gamma API directly.
 */
async function findCurrentMarket() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const interval = 300; // 5 minutes

    // Generate slug candidates: current window and next 2
    const candidates = [];
    const base = Math.floor(now / interval) * interval;
    for (let i = 0; i <= 3; i++) {
      candidates.push(base + i * interval);
    }

    let bestMarket = null;
    let bestEnd = Infinity;

    for (const ts of candidates) {
      const slug = `btc-updown-5m-${ts}`;
      try {
        const res = await fetch(`${GAMMA_API}?slug=${slug}`);
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) continue;

        const m = data[0];
        const endMs = new Date(m.endDate).getTime();
        const nowMs = Date.now();

        // Must not be ended yet
        if (endMs <= nowMs) continue;

        // Pick the one ending soonest (current active market)
        if (endMs < bestEnd) {
          bestEnd = endMs;
          bestMarket = m;
        }
      } catch (e) { /* try next */ }
    }

    if (!bestMarket) {
      // If no future market found, try the most recent one (might still be resolving)
      const recentSlug = `btc-updown-5m-${base}`;
      try {
        const res = await fetch(`${GAMMA_API}?slug=${recentSlug}`);
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          bestMarket = data[0];
        }
      } catch (e) { /* ignore */ }
    }

    if (!bestMarket) return cachedMarket;

    const m = bestMarket;
    const endDate = m.endDate;
    const startDate = m.startDate || m.createdAt;
    const endMs = new Date(endDate).getTime();
    const startMs = new Date(startDate).getTime();
    const slug = m.slug || `btc-updown-5m-${Math.floor(endMs / 1000)}`;

    // Extract CLOB token IDs
    let upTokenId = null;
    let downTokenId = null;
    try {
      const clobIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
      const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
      if (clobIds && outcomes) {
        for (let i = 0; i < outcomes.length; i++) {
          const out = outcomes[i].toLowerCase();
          if (out === 'up' || out === 'yes') upTokenId = clobIds[i];
          if (out === 'down' || out === 'no') downTokenId = clobIds[i];
        }
      }
    } catch (e) { /* ignore */ }

    cachedTokens = { upTokenId, downTokenId };

    // Compute market_start_at from slug (end time - 5 min)
    const endUnix = Math.floor(endMs / 1000);
    const startUnix = endUnix - 300;
    const marketStartAt = new Date(startUnix * 1000).toISOString();

    cachedMarket = {
      market_slug: slug,
      title: m.question || `Bitcoin Up or Down`,
      market_start_at: marketStartAt,
      market_end_at: new Date(endMs).toISOString(),
      endMs,
      startMs: startUnix * 1000,
      resolution_source: m.resolutionSource || 'https://data.chain.link/streams/btc-usd',
      conditionId: m.conditionId,
      upTokenId,
      downTokenId,
    };

    return cachedMarket;
  } catch (e) {
    console.error('Market discovery error:', e.message);
    return cachedMarket;
  }
}

async function fetchTokenPrices() {
  if (!cachedTokens) return { up: null, down: null };
  const prices = { up: null, down: null };

  try {
    if (cachedTokens.upTokenId) {
      const res = await fetch(`${CLOB_API}/midpoint?token_id=${cachedTokens.upTokenId}`);
      const data = await res.json();
      prices.up = parseFloat(data.mid);
    }
  } catch (e) { /* ignore */ }

  try {
    if (cachedTokens.downTokenId) {
      const res = await fetch(`${CLOB_API}/midpoint?token_id=${cachedTokens.downTokenId}`);
      const data = await res.json();
      prices.down = parseFloat(data.mid);
    }
  } catch (e) { /* ignore */ }

  return prices;
}

function getCachedMarket() {
  return cachedMarket;
}

function getCachedTokens() {
  return cachedTokens;
}

module.exports = { findCurrentMarket, fetchTokenPrices, getCachedMarket, getCachedTokens };
