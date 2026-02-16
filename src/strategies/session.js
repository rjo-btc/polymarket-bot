const { fetchKlines } = require('../btcPrice');
const { params } = require('../autotuner');

function calcRSI(closes, period) {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

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

  const p = params.session;
  const closes = klines.map(k => k.close);
  const rsi = calcRSI(closes, 14);
  const currentRSI = rsi[rsi.length - 1];

  const close1m = klines[klines.length - 1].close;
  const prevClose1m = klines[klines.length - 2].close;
  const vol1mTicks = klines[klines.length - 1].volume;

  // 5m avg volume
  const recentVols = klines.slice(-5).map(k => k.volume);
  const vol5mAvgTicks = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;

  const atr3 = calcATR(klines, 3);
  const atr8 = calcATR(klines, 8);

  // ACTION ITEMS 1: RSI Filter Enhancement
  const RSI_DOWN_MAX = p.rsi_down_max ?? 35;
  const RSI_UP_MIN = p.rsi_up_min ?? 65;

  const confirmUp = close1m > prevClose1m;
  const confirmDown = close1m < prevClose1m;
  const volExpand = vol1mTicks > vol5mAvgTicks * 1.2;
  const atrExpand = atr3 > atr8 * 1.1;
  const atrContract = atr3 < atr8 * 0.8;

  const paStr = `PA[session=${session.active ? session.name : 'off'},est=${estTime},close1m=${close1m.toFixed(2)},prevClose1m=${prevClose1m.toFixed(2)},vol1mTicks=${vol1mTicks.toFixed(0)},vol5mAvgTicks=${vol5mAvgTicks.toFixed(0)},atr3=${atr3.toFixed(2)},atr8=${atr8.toFixed(2)},confirmUp=${confirmUp},confirmDown=${confirmDown},volExpand=${volExpand},atrExpand=${atrExpand},atrContract=${atrContract}]`;

  // === ACTION ITEM 3: TIGHTER ENTRY PRICE CAPS ===
  // Session strategy enhanced with tighter caps based on loss analysis
  function getDynamicMaxEntryPriceSession(volExpand, atrExpand, atr3, atr8) {
    const volRatio = vol1mTicks / vol5mAvgTicks;
    const atrRatio = atr3 / atr8;
    
    // ACTION ITEM 3: Reduced caps - losers had expensive entries averaging 0.361
    if (volRatio >= 1.5 && atrRatio >= 1.3) {
      return 0.30; // Ultra-strong: high volume + ATR expansion (was 0.60)
    } else if (volRatio >= 1.2 && atrRatio >= 1.1) {
      return 0.25; // Strong: moderate expansion (was 0.40)
    } else {
      return 0.20; // Minimum signals: tight cap (was 0.30)
    }
  }

  if (!session.active) {
    return { ...base, action: 'SKIP', side: null, reason: `No session edge active; ${paStr}` };
  }

  // Need volume expansion + ATR expansion + price confirmation + RSI filter
  if (volExpand && atrExpand && confirmUp) {
    // ACTION ITEM 1: RSI Filter - Block UP trades when RSI >65 (overbought → drop)
    if (currentRSI > RSI_UP_MIN) {
      return { 
        ...base, 
        action: 'SKIP', 
        side: null, 
        reason: `Session ${session.name} UP BLOCKED: RSI ${currentRSI.toFixed(1)} > ${RSI_UP_MIN} (overbought → drop risk); ${paStr}` 
      };
    }
    
    const dynamicMaxPrice = getDynamicMaxEntryPriceSession(volExpand, atrExpand, atr3, atr8);
    const signalTier = dynamicMaxPrice === 0.30 ? 'ULTRA' : dynamicMaxPrice === 0.25 ? 'STRONG' : 'MINIMUM';
    return { 
      ...base, 
      action: 'ENTER', 
      side: 'up', 
      reason: `Session ${session.name} LONG: vol expand + ATR expand + confirm up + RSI ${currentRSI.toFixed(1)}; ${paStr}`,
      dynamic_max_entry_price: dynamicMaxPrice,
      signal_tier: signalTier,
    };
  }

  if (volExpand && atrExpand && confirmDown) {
    // ACTION ITEM 1: RSI Filter - Block DOWN trades when RSI <35 (oversold → bounce)
    if (currentRSI < RSI_DOWN_MAX) {
      return { 
        ...base, 
        action: 'SKIP', 
        side: null, 
        reason: `Session ${session.name} DOWN BLOCKED: RSI ${currentRSI.toFixed(1)} < ${RSI_DOWN_MAX} (oversold → bounce risk); ${paStr}` 
      };
    }
    
    const dynamicMaxPrice = getDynamicMaxEntryPriceSession(volExpand, atrExpand, atr3, atr8);
    const signalTier = dynamicMaxPrice === 0.30 ? 'ULTRA' : dynamicMaxPrice === 0.25 ? 'STRONG' : 'MINIMUM';
    return { 
      ...base, 
      action: 'ENTER', 
      side: 'down', 
      reason: `Session ${session.name} SHORT: vol expand + ATR expand + confirm down + RSI ${currentRSI.toFixed(1)}; ${paStr}`,
      dynamic_max_entry_price: dynamicMaxPrice,
      signal_tier: signalTier,
    };
  }

  return { ...base, action: 'SKIP', side: null, reason: `Session ${session.name} active but no PA confirmation; ${paStr}` };
}

module.exports = { evaluate };
