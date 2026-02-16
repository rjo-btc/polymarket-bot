const { fetchKlines } = require('../btcPrice');

// Session edges in ET (Eastern Time)
const SESSION_EDGES = [
  { name: 'Asia Open', hour: 20, minute: 0 },
  { name: 'Asia Close', hour: 4, minute: 0 },
  { name: 'London Open', hour: 3, minute: 0 },
  { name: 'London Close', hour: 11, minute: 30 },
  { name: 'NY Open', hour: 9, minute: 30 },
  { name: 'NY Close', hour: 16, minute: 0 },
];

function getETHour() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { hour: et.getHours(), minute: et.getMinutes() };
}

function isNearSessionEdge() {
  const { hour, minute } = getETHour();
  const totalMin = hour * 60 + minute;
  for (const edge of SESSION_EDGES) {
    const edgeMin = edge.hour * 60 + edge.minute;
    const diff = Math.abs(totalMin - edgeMin);
    if (diff <= 15) return { active: true, name: edge.name };
  }
  return { active: false, name: null };
}

function calcATR(klines, period) {
  if (klines.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high;
    const l = klines[i].low;
    const pc = klines[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

async function evaluate(market, btcPrice) {
  const secsToEnd = Math.floor((market.endMs - Date.now()) / 1000);
  const { hour, minute } = getETHour();
  const estTime = `${hour}:${String(minute).padStart(2, '0')} ET`;

  const base = {
    strategy: 'session',
    market_slug: market.market_slug,
    market_end_at: market.market_end_at,
    last_checked_at: new Date().toISOString(),
    seconds_to_end: secsToEnd,
  };

  if (secsToEnd < 90 || secsToEnd > 180) {
    return { ...base, action: 'SKIP', side: null, reason: `Outside entry window (${secsToEnd}s); PA[session=off,est=${estTime}]` };
  }

  // Skip weekends — session edges are based on equity market hours, no real sessions on Sat/Sun
  const now = new Date();
  const etDay = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
  if (etDay === 0 || etDay === 6) {
    return { ...base, action: 'SKIP', side: null, reason: `Weekend (${etDay === 0 ? 'Sun' : 'Sat'} ET) — no equity sessions; PA[session=weekend,est=${estTime}]` };
  }

  const session = isNearSessionEdge();
  const klines = await fetchKlines(50);

  if (klines.length < 10) {
    return { ...base, action: 'SKIP', side: null, reason: `Not enough candles; PA[session=${session.active ? session.name : 'off'},est=${estTime}]` };
  }

  const close1m = klines[klines.length - 1].close;
  const prevClose1m = klines[klines.length - 2].close;
  const vol1mTicks = klines[klines.length - 1].volume;

  // 5m avg volume
  const recentVols = klines.slice(-5).map(k => k.volume);
  const vol5mAvgTicks = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;

  const atr3 = calcATR(klines, 3);
  const atr8 = calcATR(klines, 8);

  const confirmUp = close1m > prevClose1m;
  const confirmDown = close1m < prevClose1m;
  const volExpand = vol1mTicks > vol5mAvgTicks * 1.2;
  const atrExpand = atr3 > atr8 * 1.1;
  const atrContract = atr3 < atr8 * 0.8;

  const paStr = `PA[session=${session.active ? session.name : 'off'},est=${estTime},close1m=${close1m.toFixed(2)},prevClose1m=${prevClose1m.toFixed(2)},vol1mTicks=${vol1mTicks.toFixed(0)},vol5mAvgTicks=${vol5mAvgTicks.toFixed(0)},atr3=${atr3.toFixed(2)},atr8=${atr8.toFixed(2)},confirmUp=${confirmUp},confirmDown=${confirmDown},volExpand=${volExpand},atrExpand=${atrExpand},atrContract=${atrContract}]`;

  // === DYNAMIC ENTRY PRICE CAPS ===
  // Session strategy uses volume and ATR expansion as signal strength indicators
  function getDynamicMaxEntryPriceSession(volExpand, atrExpand, atr3, atr8) {
    const volRatio = vol1mTicks / vol5mAvgTicks;
    const atrRatio = atr3 / atr8;
    
    if (volRatio >= 1.5 && atrRatio >= 1.3) {
      return 0.60; // Ultra-strong: high volume expansion + strong ATR expansion
    } else if (volRatio >= 1.2 && atrRatio >= 1.1) {
      return 0.40; // Strong: moderate expansion on both metrics
    } else {
      return 0.30; // Minimum signals: baseline cap
    }
  }

  if (!session.active) {
    return { ...base, action: 'SKIP', side: null, reason: `No session edge active; ${paStr}` };
  }

  // Need volume expansion + ATR expansion + price confirmation
  if (volExpand && atrExpand && confirmUp) {
    const dynamicMaxPrice = getDynamicMaxEntryPriceSession(volExpand, atrExpand, atr3, atr8);
    const signalTier = dynamicMaxPrice === 0.60 ? 'ULTRA' : dynamicMaxPrice === 0.40 ? 'STRONG' : 'MINIMUM';
    return { 
      ...base, 
      action: 'ENTER', 
      side: 'up', 
      reason: `Session ${session.name} LONG: vol expand + ATR expand + confirm up; ${paStr}`,
      dynamic_max_entry_price: dynamicMaxPrice,
      signal_tier: signalTier,
    };
  }

  if (volExpand && atrExpand && confirmDown) {
    const dynamicMaxPrice = getDynamicMaxEntryPriceSession(volExpand, atrExpand, atr3, atr8);
    const signalTier = dynamicMaxPrice === 0.60 ? 'ULTRA' : dynamicMaxPrice === 0.40 ? 'STRONG' : 'MINIMUM';
    return { 
      ...base, 
      action: 'ENTER', 
      side: 'down', 
      reason: `Session ${session.name} SHORT: vol expand + ATR expand + confirm down; ${paStr}`,
      dynamic_max_entry_price: dynamicMaxPrice,
      signal_tier: signalTier,
    };
  }

  return { ...base, action: 'SKIP', side: null, reason: `Session ${session.name} active but no PA confirmation; ${paStr}` };
}

module.exports = { evaluate };
