import { db } from './db.js';
import { nowIso } from './util.js';

interface AppRow {
  id: number;
  ts: string;
  application_id: string;
  action: string;
  result: string;
  duration_ms: number | null;
}

const insApp = db.prepare(
  'INSERT INTO applications(ts,application_id,action,result,duration_ms) VALUES(?,?,?,?,?)'
);

export function recordApplication(a: {
  appId: string;
  action?: string;
  result: string;
  durationMs: number;
}): void {
  insApp.run(nowIso(), a.appId, a.action ?? 'accept', a.result, Math.round(a.durationMs));
}

export function countToday(): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) c FROM applications WHERE date(ts,'localtime')=date('now','localtime') AND action!='ai-task'"
    )
    .get() as { c: number };
  return row.c;
}

export function countAiToday(): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) c FROM applications WHERE date(ts,'localtime')=date('now','localtime') AND action='ai-task'"
    )
    .get() as { c: number };
  return row.c;
}

export function resetStats(): { removed: number } {
  const before = (db.prepare('SELECT COUNT(*) c FROM applications').get() as { c: number }).c;
  db.prepare('DELETE FROM applications').run();
  db.prepare("DELETE FROM ledger WHERE status!='PENDING'").run();
  return { removed: before };
}

export interface AnalyticsSummary {
  today: number;
  aiToday: number;
  week: number;
  total: number;
  avgDurationMs: number;
  series24h: { hour: string; count: number }[];
  recent: { ts: string; application_id: string; action: string; result: string; duration_ms: number | null }[];
}

export function analyticsSummary(): AnalyticsSummary {
  const week = db
    .prepare(
      "SELECT COUNT(*) c FROM applications WHERE ts >= datetime('now','-7 days')"
    )
    .get() as { c: number };
  const total = db.prepare('SELECT COUNT(*) c FROM applications').get() as { c: number };
  const avg = db
    .prepare(
      'SELECT AVG(duration_ms) a FROM (SELECT duration_ms FROM applications ORDER BY id DESC LIMIT 50)'
    )
    .get() as { a: number | null };

  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:00:00',ts,'localtime') h, COUNT(*) c
       FROM applications
       WHERE ts >= datetime('now','-1 day')
       GROUP BY h ORDER BY h`
    )
    .all() as { h: string; c: number }[];

  const recentRows = db
    .prepare('SELECT * FROM applications ORDER BY id DESC LIMIT 20')
    .all() as AppRow[];

  return {
    today: countToday(),
    aiToday: countAiToday(),
    week: week.c,
    total: total.c,
    avgDurationMs: Math.round(avg.a ?? 0),
    series24h: rows.map((r) => ({ hour: r.h, count: r.c })),
    recent: recentRows.map((r) => ({
      ts: r.ts,
      application_id: r.application_id,
      action: r.action,
      result: r.result,
      duration_ms: r.duration_ms,
    })),
  };
}
