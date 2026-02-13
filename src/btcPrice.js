const BINANCE_PRICE = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';
const BINANCE_KLINES = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=250';

let cachedPrice = { price: null, updatedAt: null };
let prevPrice = { price: null, updatedAt: null };

async function fetchBtcPrice() {
  try {
    const res = await fetch(BINANCE_PRICE);
    const data = await res.json();
    const price = parseFloat(data.price);
    if (price && price > 0) {
      if (cachedPrice.price !== null) {
        prevPrice = { ...cachedPrice };
      }
      cachedPrice = { price, updatedAt: new Date().toISOString() };
      return cachedPrice;
    }
  } catch (e) {
    console.error('BTC price fetch error:', e.message);
  }
  return cachedPrice;
}

function getBtcPrice() {
  return cachedPrice;
}

function getPrevBtcPrice() {
  return prevPrice;
}

async function fetchKlines(limit = 250) {
  try {
    const res = await fetch(`${BINANCE_KLINES}&limit=${limit}`);
    const data = await res.json();
    // Each kline: [openTime, open, high, low, close, volume, closeTime, ...]
    return data.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
    }));
  } catch (e) {
    console.error('Klines fetch error:', e.message);
    return [];
  }
}

// Start background price polling
let priceInterval = null;
function startPricePolling(intervalMs = 2000) {
  fetchBtcPrice();
  priceInterval = setInterval(fetchBtcPrice, intervalMs);
}

function stopPricePolling() {
  if (priceInterval) clearInterval(priceInterval);
}

module.exports = { fetchBtcPrice, getBtcPrice, getPrevBtcPrice, fetchKlines, startPricePolling, stopPricePolling };
