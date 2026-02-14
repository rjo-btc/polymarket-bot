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
    market_end_at TEXT,
    filter_version INTEGER DEFAULT 0
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
// Add filter_version column if missing (migration for existing DBs)
try { db.exec(`ALTER TABLE positions ADD COLUMN filter_version INTEGER DEFAULT 0`); } catch(e) { /* already exists */ }

const CURRENT_FILTER_VERSION = 3; // v0=no filters, v1=early tuning, v2=slope2.0+dist3+entry0.65, v3=ema9+rsi14

const insertPosition = db.prepare(`
  INSERT INTO positions (market_slug, market_title, strategy, side, stake_usd, shares, entry_price,
    entered_at, seconds_to_end_at_entry, btc_price_at_entry, btc_price_at_start, entry_reason, status, market_end_at, filter_version)
  VALUES (@market_slug, @market_title, @strategy, @side, @stake_usd, @shares, @entry_price,
    @entered_at, @seconds_to_end_at_entry, @btc_price_at_entry, @btc_price_at_start, @entry_reason, 'open', @market_end_at, ${CURRENT_FILTER_VERSION})
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

// Execution quality tracking — live market testing
db.exec(`
  CREATE TABLE IF NOT EXISTS executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER,
    market_slug TEXT NOT NULL,
    side TEXT NOT NULL,
    signal_type TEXT,
    signal_at TEXT NOT NULL,
    signal_price REAL,
    quoted_price REAL,
    executed_price REAL,
    slippage_cents REAL,
    seconds_to_end_at_signal REAL,
    seconds_to_end_at_fill REAL,
    fill_delay_ms REAL,
    btc_price_at_signal REAL,
    btc_price_at_fill REAL,
    btc_move_bps REAL,
    ema_dist_bps REAL,
    slope_abs REAL,
    rsi REAL,
    book_up_price REAL,
    book_down_price REAL,
    spread_cents REAL,
    outcome TEXT,
    pnl REAL,
    ideal_pnl REAL,
    slippage_cost REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const insertExecution = db.prepare(`
  INSERT INTO executions (position_id, market_slug, side, signal_type, signal_at, signal_price,
    quoted_price, executed_price, slippage_cents, seconds_to_end_at_signal, seconds_to_end_at_fill,
    fill_delay_ms, btc_price_at_signal, btc_price_at_fill, btc_move_bps, ema_dist_bps, slope_abs,
    rsi, book_up_price, book_down_price, spread_cents)
  VALUES (@position_id, @market_slug, @side, @signal_type, @signal_at, @signal_price,
    @quoted_price, @executed_price, @slippage_cents, @seconds_to_end_at_signal, @seconds_to_end_at_fill,
    @fill_delay_ms, @btc_price_at_signal, @btc_price_at_fill, @btc_move_bps, @ema_dist_bps, @slope_abs,
    @rsi, @book_up_price, @book_down_price, @spread_cents)
`);

const updateExecutionOutcome = db.prepare(`
  UPDATE executions SET outcome = @outcome, pnl = @pnl, ideal_pnl = @ideal_pnl, slippage_cost = @slippage_cost
  WHERE position_id = @position_id
`);

const getAllExecutions = db.prepare(`SELECT * FROM executions ORDER BY id DESC`);
const getRecentExecutions = db.prepare(`SELECT * FROM executions ORDER BY id DESC LIMIT 50`);

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
  insertExecution,
  updateExecutionOutcome,
  getAllExecutions,
  getRecentExecutions,
  kvGet,
  kvSet,
};
