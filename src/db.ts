import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, SHOTS_DIR, PROFILE_DIR } from './config.js';

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(SHOTS_DIR, { recursive: true });
mkdirSync(PROFILE_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, 'sem.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE TABLE IF NOT EXISTS checkpoints(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  workflow_id TEXT,
  application_id TEXT,
  step TEXT,
  next_action TEXT,
  url TEXT,
  last_verified_status TEXT,
  screenshot TEXT
);
CREATE TABLE IF NOT EXISTS ledger(
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  application_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  resolved_ts TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS applications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  application_id TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  duration_ms INTEGER
);
`);
