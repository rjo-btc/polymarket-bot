const GAMMA_API = 'https://gamma-api.polymarket.com/markets';
const CLOB_API = 'https://clob.polymarket.com';

let cachedMarket = null;
let cachedTokens = null; // { upTokenId, downTokenId }

async function findCurrentMarket() {
  try {
    // Try multiple search approaches
    const urls = [
      `${GAMMA_API}?closed=false&limit=10&active=true`,
    ];

    let markets = [];
    for (const url of urls) {
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (Array.isArray(data)) {
          // Filter for BTC 5-minute markets by slug or question
          const btcMarkets = data.filter(m => {
            const slug = (m.slug || '').toLowerCase();
            const q = (m.question || '').toLowerCase();
            return (slug.includes('btc-updown') || slug.includes('btc-5m') ||
                    q.includes('bitcoin up or down') || q.includes('btc') && q.includes('5'));
          });
          markets.push(...btcMarkets);
        }
      } catch (e) { /* try next */ }
      if (markets.length > 0) break;
    }

    const now = Date.now();
    // Find the market whose end is in the future and closest
    const active = markets
      .filter(m => new Date(m.end_date_min || m.endDate).getTime() > now)
      .sort((a, b) => new Date(a.end_date_min || a.endDate) - new Date(b.end_date_min || b.endDate));

    if (active.length === 0) {
      return cachedMarket;
    }

    const m = active[0];
    const endDate = m.end_date_min || m.endDate;
    const startDate = m.start_date_min || m.startDate || m.created_at;
    const endMs = new Date(endDate).getTime();
    const startMs = new Date(startDate).getTime();

    // Extract slug
    const slug = m.slug || m.market_slug || `btc-updown-5m-${Math.floor(endMs / 1000)}`;

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
    } catch (e) { /* ignore parse errors */ }

    cachedTokens = { upTokenId, downTokenId };

    cachedMarket = {
      market_slug: slug,
      title: m.question || m.title || `Bitcoin Up or Down`,
      market_start_at: new Date(startMs).toISOString(),
      market_end_at: new Date(endMs).toISOString(),
      endMs,
      startMs,
      resolution_source: 'https://data.chain.link/streams/btc-usd',
      conditionId: m.conditionId || m.condition_id,
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
