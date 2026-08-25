import { db } from './db.js';
import { nowIso } from './util.js';

export interface CheckpointRow {
  id: number;
  ts: string;
  workflow_id: string | null;
  application_id: string | null;
  step: string | null;
  next_action: string | null;
  url: string | null;
  last_verified_status: string | null;
  screenshot: string | null;
}

const supersede = db.prepare(
  "UPDATE checkpoints SET status='SUPERSEDED' WHERE workflow_id=? AND status='ACTIVE'"
);
const insertCp = db.prepare(
  `INSERT INTO checkpoints(ts,status,workflow_id,application_id,step,next_action,url,last_verified_status,screenshot)
   VALUES(?,'ACTIVE',?,?,?,?,?,?,?)`
);
const latestStmt = db.prepare(
  "SELECT * FROM checkpoints WHERE status='ACTIVE' ORDER BY id DESC LIMIT 1"
);
const resolveApp = db.prepare(
  "UPDATE checkpoints SET status='RESOLVED', next_action='done' WHERE application_id=? AND status='ACTIVE'"
);

export function saveCheckpoint(c: {
  appId: string | null;
  step: string;
  nextAction: string;
  url: string;
  lastStatus: string;
}): void {
  supersede.run('application_processing');
  insertCp.run(
    nowIso(),
    'application_processing',
    c.appId,
    c.step,
    c.nextAction,
    c.url,
    c.lastStatus,
    null
  );
}

export function latestCheckpoint(): CheckpointRow | undefined {
  return latestStmt.get() as CheckpointRow | undefined;
}

export function resolveCheckpointsForApp(appId: string): void {
  resolveApp.run(appId);
}
