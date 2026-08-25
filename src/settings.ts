import { db } from './db.js';

export interface SemSettings {
  mode: 'simulation' | 'live';
  siteUrl: string;
  listUrl: string;
  username: string;
  password: string;
  selectorsJson: string;
  speed: number;
  actionDelayMs: number;
  keepaliveSec: number;
  securityTimeoutMin: number;
  autostart: boolean;
  telegramToken: string;
  telegramChatId: string;
}

export const DEFAULT_SETTINGS: SemSettings = {
  mode: 'simulation',
  siteUrl: '',
  listUrl: '',
  username: '',
  password: '',
  selectorsJson: '',
  speed: 1,
  actionDelayMs: 800,
  keepaliveSec: 180,
  securityTimeoutMin: 30,
  autostart: true,
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
  selectorsJson: 'SELECTORS_JSON',
  speed: 'SPEED',
  actionDelayMs: 'ACTION_DELAY_MS',
  keepaliveSec: 'KEEPALIVE_SEC',
  securityTimeoutMin: 'SECURITY_TIMEOUT_MIN',
  autostart: 'AUTOSTART',
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

export function maskSettings(s: SemSettings): SemSettings {
  return {
    ...s,
    password: s.password ? '__SAVED__' : '',
    telegramToken: s.telegramToken ? '__SAVED__' : '',
  };
}

export function applySecretPlaceholders(incoming: Partial<Record<string, unknown>>, current: SemSettings): void {
  if (incoming.password === '__SAVED__') delete incoming.password;
  if (incoming.telegramToken === '__SAVED__') delete incoming.telegramToken;
  void current;
}
