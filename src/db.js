const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'trader.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_slug TEXT NOT NULL,
    market_title TEXT,
    strategy TEXT NOT NULL DEFAULT 'manual',
    side TEXT NOT NULL,
    stake_usd REAL NOT NULL,
    shares REAL NOT NULL,
    entry_price REAL NOT NULL,
    entered_at TEXT NOT NULL,
    seconds_to_end_at_entry REAL,
    btc_price_at_entry REAL,
    btc_price_at_start REAL,
    btc_price_at_end REAL,
    entry_reason TEXT,
    post_mortem TEXT,
    mark_price REAL,
    pnl REAL,
    pnl_pct REAL,
    status TEXT NOT NULL DEFAULT 'open',
    market_end_at TEXT
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy TEXT NOT NULL,
    market_slug TEXT,
    market_end_at TEXT,
    last_checked_at TEXT NOT NULL,
    seconds_to_end REAL,
    action TEXT NOT NULL,
    side TEXT,
    reason TEXT
  );
`);

// Positions
const insertPosition = db.prepare(`
  INSERT INTO positions (market_slug, market_title, strategy, side, stake_usd, shares, entry_price,
    entered_at, seconds_to_end_at_entry, btc_price_at_entry, btc_price_at_start, entry_reason, status, market_end_at)
  VALUES (@market_slug, @market_title, @strategy, @side, @stake_usd, @shares, @entry_price,
    @entered_at, @seconds_to_end_at_entry, @btc_price_at_entry, @btc_price_at_start, @entry_reason, 'open', @market_end_at)
`);

const getAllPositions = db.prepare(`SELECT * FROM positions ORDER BY id DESC`);
const getOpenPositions = db.prepare(`SELECT * FROM positions WHERE status = 'open' ORDER BY id DESC`);

const resolvePosition = db.prepare(`
  UPDATE positions SET status = 'resolved', mark_price = @mark_price, pnl = @pnl, pnl_pct = @pnl_pct,
    btc_price_at_end = @btc_price_at_end, post_mortem = @post_mortem WHERE id = @id
`);

// Decisions
const insertDecision = db.prepare(`
  INSERT INTO decisions (strategy, market_slug, market_end_at, last_checked_at, seconds_to_end, action, side, reason)
  VALUES (@strategy, @market_slug, @market_end_at, @last_checked_at, @seconds_to_end, @action, @side, @reason)
`);

const getRecentDecisions = db.prepare(`SELECT * FROM decisions ORDER BY id DESC LIMIT 100`);

// Cleanup old decisions
const pruneDecisions = db.prepare(`DELETE FROM decisions WHERE id NOT IN (SELECT id FROM decisions ORDER BY id DESC LIMIT 100)`);

const updatePostMortem = db.prepare(`UPDATE positions SET post_mortem = @post_mortem WHERE id = @id`);

// Key-value store for persisting autotuner params
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const kvGet = db.prepare(`SELECT value FROM kv WHERE key = ?`);
const kvSet = db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (@key, @value)`);

module.exports = {
  db,
  insertPosition,
  getAllPositions,
  getOpenPositions,
  resolvePosition,
  updatePostMortem,
  insertDecision,
  getRecentDecisions,
  pruneDecisions,
  kvGet,
  kvSet,
};
