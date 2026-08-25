import { db } from './db.js';
import { bus } from './bus.js';
import { nowIso } from './util.js';
import type { Category, FeedItem, Level } from './types.js';

export function log(level: Level, category: Category, message: string, meta?: unknown): void {
  const item: FeedItem = {
    ts: nowIso(),
    level,
    category,
    message,
    meta: meta == null ? null : JSON.stringify(meta),
  };
  try {
    db.prepare('INSERT INTO events(ts,level,category,message,meta) VALUES(?,?,?,?,?)').run(
      item.ts,
      item.level,
      item.category,
      item.message,
      item.meta
    );
  } catch {
    /* db issues must not break the loop */
  }
  console.log(`[${item.ts}] ${level.toUpperCase()} ${category}: ${message}`);
  bus.emit('feed', item);
}
