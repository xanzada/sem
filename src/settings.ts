import { db } from './db.js';

export interface SemSettings {
  mode: 'simulation' | 'live' | 'ai';
  siteUrl: string;
  listUrl: string;
  username: string;
  password: string;
  loginSelectorsJson: string;
  aiApiKey: string;
  aiModel: string;
  aiBaseUrl: string;
  aiInstruction: string;
  aiIntervalMin: number;
  aiMaxSteps: number;
  selectorsJson: string;
  stepsJson: string;
  speed: number;
  actionDelayMs: number;
  keepaliveSec: number;
  securityTimeoutMin: number;
  scheduleEnabled: boolean;
  scheduleFrom: number;
  scheduleTo: number;
  autostart: boolean;
  evidenceShots: boolean;
  telegramToken: string;
  telegramChatId: string;
}

export const DEFAULT_SETTINGS: SemSettings = {
  mode: 'simulation',
  siteUrl: '',
  listUrl: '',
  username: '',
  password: '',
  loginSelectorsJson: '',
  aiApiKey: '',
  aiModel: 'gemini-flash-latest',
  aiBaseUrl: '',
  aiInstruction: '',
  aiIntervalMin: 5,
  aiMaxSteps: 20,
  selectorsJson: '',
  stepsJson: '',
  speed: 1,
  actionDelayMs: 800,
  keepaliveSec: 180,
  securityTimeoutMin: 30,
  scheduleEnabled: false,
  scheduleFrom: 9,
  scheduleTo: 21,
  autostart: true,
  evidenceShots: true,
  telegramToken: '',
  telegramChatId: '',
};

export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof SemSettings)[];

const ENV_KEYS: Partial<Record<keyof SemSettings, string>> = {
  mode: 'SEM_MODE',
  siteUrl: 'SITE_URL',
  listUrl: 'SITE_LIST_URL',
  username: 'SITE_USERNAME',
  password: 'SITE_PASSWORD',
  loginSelectorsJson: 'LOGIN_SELECTORS_JSON',
  aiApiKey: 'AI_API_KEY',
  aiModel: 'AI_MODEL',
  aiBaseUrl: 'AI_BASE_URL',
  aiInstruction: 'AI_INSTRUCTION',
  aiIntervalMin: 'AI_INTERVAL_MIN',
  aiMaxSteps: 'AI_MAX_STEPS',
  selectorsJson: 'SELECTORS_JSON',
  stepsJson: 'STEPS_JSON',
  speed: 'SPEED',
  actionDelayMs: 'ACTION_DELAY_MS',
  keepaliveSec: 'KEEPALIVE_SEC',
  securityTimeoutMin: 'SECURITY_TIMEOUT_MIN',
  scheduleEnabled: 'SCHEDULE_ENABLED',
  scheduleFrom: 'SCHEDULE_FROM',
  scheduleTo: 'SCHEDULE_TO',
  autostart: 'AUTOSTART',
  evidenceShots: 'EVIDENCE_SHOTS',
  telegramToken: 'TELEGRAM_TOKEN',
  telegramChatId: 'TELEGRAM_CHAT_ID',
};

function envValue(key: keyof SemSettings): unknown {
  const name = ENV_KEYS[key];
  const raw = name ? process.env[name] : undefined;
  if (raw == null || raw === '') return undefined;
  const def = DEFAULT_SETTINGS[key];
  if (typeof def === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof def === 'boolean') return raw === 'true' || raw === '1';
  return raw;
}

const stmtAll = db.prepare('SELECT key,value FROM settings');
const stmtGet = db.prepare('SELECT value FROM settings WHERE key=?');
const stmtSet = db.prepare(
  'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
);

export function getAllSettings(): SemSettings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of stmtAll.all() as { key: string; value: string }[]) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, row.key)) continue;
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  for (const key of SETTINGS_KEYS) {
    const ev = envValue(key);
    if (ev !== undefined) out[key] = ev;
  }
  return out as unknown as SemSettings;
}

export function getSetting<K extends keyof SemSettings>(key: K): SemSettings[K] {
  return getAllSettings()[key];
}

export function setSettingsPatch(patch: Partial<Record<string, unknown>>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (!SETTINGS_KEYS.includes(k as keyof SemSettings)) continue;
    stmtSet.run(k, JSON.stringify(v));
  }
}

const SECRET_KEYS = ['password', 'telegramToken', 'aiApiKey'] as const;

/** Секреты наружу не отдаём: только флаг «задан ли». */
export function maskSettings(s: SemSettings): SemSettings & Record<string, unknown> {
  const out: Record<string, unknown> = { ...s };
  for (const k of SECRET_KEYS) {
    out[k] = '';
    out[k + 'Set'] = Boolean(s[k]);
  }
  return out as SemSettings & Record<string, unknown>;
}

/** Пустое или служебное значение секрета не должно стирать сохранённый ключ. */
export function applySecretPlaceholders(
  incoming: Partial<Record<string, unknown>>,
  current: SemSettings
): void {
  for (const k of SECRET_KEYS) {
    const v = incoming[k];
    if (v === undefined) continue;
    const str = String(v);
    const blank = str.trim() === '' || str.includes('__SAVED__') || /^\u2022+$/.test(str.trim());
    if (blank) delete incoming[k];
  }
  void current;
}
