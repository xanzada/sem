export type Level = 'info' | 'warn' | 'error' | 'success';
export type Category = 'SYSTEM' | 'AUTH' | 'SECURITY' | 'WORKFLOW' | 'CONTROL';

export interface FeedItem {
  ts: string;
  level: Level;
  category: Category;
  message: string;
  meta?: string | null;
}

export interface Snapshot {
  state: string;
  stateRu: string;
  emoji: string;
  since: string;
  currentAppId: string | null;
  step: string;
  paused: boolean;
  running: boolean;
  uptimeSec: number;
  processedToday: number;
  mode: string;
  speed: number;
  vncUrl: string;
  version: string;
}

export interface DriverCtx {
  page: import('playwright').Page;
  log(level: Level, category: Category, message: string, meta?: unknown): void;
  shot?(name: string): Promise<string | null>;
  setStep(label: string): void;
  delay(mult?: number): Promise<void>;
  beginIntent(appId: string, type: string): Promise<string>;
  confirmIntent(id: string): Promise<void>;
  failIntent(id: string, note?: string): Promise<void>;
  getPendingIntents(appId: string): Promise<{ id: string; type: string }[]>;
  recordApplication(a: { appId: string; result: string; durationMs: number }): Promise<void>;
  saveCheckpoint(c: {
    appId: string | null;
    step: string;
    nextAction: string;
    url: string;
    lastStatus: string;
  }): Promise<void>;
  rand(): number;
}

export interface WorkflowDriver {
  name: string;
  cycle(ctx: DriverCtx): Promise<void>;
}

export class SimulatedIncident extends Error {
  constructor(public kind: 'SECURITY' | 'AUTH') {
    super(`simulated:${kind}`);
  }
}

export class MissingSelectorsError extends Error {
  constructor() {
    super('Не заданы селекторы сайта (Настройки → Селекторы)');
  }
}
