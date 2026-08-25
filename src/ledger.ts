import { db } from './db.js';
import { nowIso, uuid } from './util.js';

interface IntentRow {
  id: string;
  ts: string;
  application_id: string;
  type: string;
  status: string;
}

const ins = db.prepare(
  `INSERT INTO ledger(id,ts,application_id,type,status) VALUES(?,?,?,?,'PENDING')`
);
const confirm = db.prepare(
  "UPDATE ledger SET status='CONFIRMED', resolved_ts=? WHERE id=?"
);
const fail = db.prepare("UPDATE ledger SET status='FAILED', resolved_ts=?, note=? WHERE id=?");
const pendingForApp = db.prepare(
  "SELECT * FROM ledger WHERE application_id=? AND status='PENDING'"
);
const anyPending = db.prepare("SELECT COUNT(*) c FROM ledger WHERE status='PENDING'");

export function beginIntent(applicationId: string, type: string): string {
  const id = uuid();
  ins.run(id, nowIso(), applicationId, type);
  return id;
}

export function confirmIntent(id: string): void {
  confirm.run(nowIso(), id);
}

export function failIntent(id: string, note?: string): void {
  fail.run(nowIso(), note ?? null, id);
}

export function pendingIntentsForApp(appId: string): { id: string; type: string }[] {
  return (pendingForApp.all(appId) as IntentRow[]).map((r) => ({ id: r.id, type: r.type }));
}

export function hasPendingIntents(): number {
  return (anyPending.get() as { c: number }).c;
}
