import { db } from './db.js';
import { nowIso } from './util.js';

/**
 * Статистика тек НАҚТЫ ОРЫНДАЛҒАН тапсырмаларды санайды.
 *
 * Бұрын кез келген клик жазылатын, сондықтан сан шындықты көрсетпейтін.
 * Енді жазба екі өрісті бөліп ұстайды:
 *   result='done'   — шарт табылды, басылды және растау толық өтті;
 *   result='failed' — басылды, бірақ растау аяқталмады (слот қолдан кетті).
 * reaction_ms — шарт пайда болғаннан кликке дейінгі уақыт: жылдамдықты
 * бағалайтын жалғыз мағыналы көрсеткіш.
 */

interface AppRow {
  id: number;
  ts: string;
  application_id: string;
  action: string;
  result: string;
  duration_ms: number | null;
  reaction_ms: number | null;
  rule_id: string | null;
}

const insApp = db.prepare(
  `INSERT INTO applications(ts,application_id,action,result,duration_ms,reaction_ms,rule_id)
   VALUES(?,?,?,?,?,?,?)`
);

export function recordCatch(a: {
  label: string;
  ok: boolean;
  totalMs: number;
  reactionMs: number;
  ruleId?: string;
}): void {
  insApp.run(
    nowIso(),
    a.label.slice(0, 120),
    'catch',
    a.ok ? 'done' : 'failed',
    Math.round(a.totalMs),
    Math.round(a.reactionMs),
    a.ruleId ?? null
  );
}

export function countToday(): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) c FROM applications WHERE result='done' AND date(ts,'localtime')=date('now','localtime')"
    )
    .get() as { c: number };
  return row.c;
}

export function resetStats(): { removed: number } {
  const before = (db.prepare('SELECT COUNT(*) c FROM applications').get() as { c: number }).c;
  db.prepare('DELETE FROM applications').run();
  db.prepare('UPDATE rules SET success_count=0, fail_count=0').run();
  return { removed: before };
}

export interface AnalyticsSummary {
  today: number;
  failedToday: number;
  week: number;
  total: number;
  /** Ең жылдам реакция, мс — бұл боттың нақты шапшаңдығы. */
  bestReactionMs: number;
  avgReactionMs: number;
  series24h: { hour: string; count: number }[];
  recent: {
    ts: string;
    label: string;
    result: string;
    reactionMs: number | null;
    totalMs: number | null;
  }[];
}

export function analyticsSummary(): AnalyticsSummary {
  const one = (sql: string): number =>
    ((db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0);

  const failedToday = one(
    "SELECT COUNT(*) c FROM applications WHERE result='failed' AND date(ts,'localtime')=date('now','localtime')"
  );
  const week = one("SELECT COUNT(*) c FROM applications WHERE result='done' AND ts >= datetime('now','-7 days')");
  const total = one("SELECT COUNT(*) c FROM applications WHERE result='done'");

  const react = db
    .prepare(
      `SELECT MIN(reaction_ms) mn, AVG(reaction_ms) av
       FROM applications WHERE result='done' AND reaction_ms IS NOT NULL`
    )
    .get() as { mn: number | null; av: number | null };

  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:00:00',ts,'localtime') h, COUNT(*) c
       FROM applications
       WHERE result='done' AND ts >= datetime('now','-1 day')
       GROUP BY h ORDER BY h`
    )
    .all() as { h: string; c: number }[];

  const recentRows = db
    .prepare('SELECT * FROM applications ORDER BY id DESC LIMIT 20')
    .all() as AppRow[];

  return {
    today: countToday(),
    failedToday,
    week,
    total,
    bestReactionMs: Math.round(react.mn ?? 0),
    avgReactionMs: Math.round(react.av ?? 0),
    series24h: rows.map((r) => ({ hour: r.h, count: r.c })),
    recent: recentRows.map((r) => ({
      ts: r.ts,
      label: r.application_id,
      result: r.result,
      reactionMs: r.reaction_ms,
      totalMs: r.duration_ms,
    })),
  };
}
