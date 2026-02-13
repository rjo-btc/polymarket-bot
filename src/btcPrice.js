// Primary: CoinGecko, Fallback: Kraken, Coinbase
const COINGECKO_PRICE = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';
const KRAKEN_PRICE = 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD';
const COINBASE_PRICE = 'https://api.coinbase.com/v2/prices/BTC-USD/spot';
const BINANCE_US_PRICE = 'https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD';
const BINANCE_US_KLINES = 'https://api.binance.us/api/v3/klines?symbol=BTCUSD&interval=1m';
const KRAKEN_OHLC = 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1';

let cachedPrice = { price: null, updatedAt: null };
let prevPrice = { price: null, updatedAt: null };

async function fetchBtcPrice() {
  // Try multiple sources
  const sources = [
    async () => {
      const res = await fetch(COINBASE_PRICE);
      const data = await res.json();
      return parseFloat(data.data.amount);
    },
    async () => {
      const res = await fetch(KRAKEN_PRICE);
      const data = await res.json();
      const pair = Object.keys(data.result)[0];
      return parseFloat(data.result[pair].c[0]);
    },
    async () => {
      const res = await fetch(COINGECKO_PRICE);
      const data = await res.json();
      return data.bitcoin.usd;
    },
    async () => {
      const res = await fetch(BINANCE_US_PRICE);
      const data = await res.json();
      return parseFloat(data.price);
    },
  ];

  for (const source of sources) {
    try {
      const price = await source();
      if (price && price > 0) {
        if (cachedPrice.price !== null) {
          prevPrice = { ...cachedPrice };
        }
        cachedPrice = { price, updatedAt: new Date().toISOString() };
        return cachedPrice;
      }
    } catch (e) { /* try next */ }
  }

  console.error('All BTC price sources failed');
  return cachedPrice;
}

function getBtcPrice() {
  return cachedPrice;
}

function getPrevBtcPrice() {
  return prevPrice;
}

async function fetchKlines(limit = 250) {
  // Try Kraken OHLC first (1-min candles), then Binance.US
  const sources = [
    async () => {
      const res = await fetch(KRAKEN_OHLC);
      const data = await res.json();
      const pair = Object.keys(data.result).find(k => k !== 'last');
      if (!pair) return [];
      const candles = data.result[pair];
      // Kraken: [time, open, high, low, close, vwap, volume, count]
      return candles.slice(-limit).map(k => ({
        openTime: k[0] * 1000,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[6]),
        closeTime: (k[0] + 60) * 1000,
      }));
    },
    async () => {
      const res = await fetch(`${BINANCE_US_KLINES}&limit=${limit}`);
      const data = await res.json();
      return data.map(k => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
      }));
    },
  ];

  for (const source of sources) {
    try {
      const klines = await source();
      if (klines && klines.length > 0) return klines;
    } catch (e) { /* try next */ }
  }

  console.error('All kline sources failed');
  return [];
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
