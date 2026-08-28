import { db } from './db.js';

export interface SemSettings {
  /* --- сайт және кіру --- */
  siteUrl: string;
  username: string;
  password: string;

  /* --- модель (ережені бір рет үйрену үшін ғана) --- */
  aiApiKey: string;
  aiModel: string;
  aiBaseUrl: string;

  /* --- тапсырма мәтіні (оператор жазады, ереже осыдан үйреніледі) --- */
  taskText: string;

  /* --- жылдамдық --- */
  /** Күзетші бетті қаншалық жиі тексереді, мс. Кіші сан = жылдам реакция. */
  scanIntervalMs: number;
  /** Растау қадамдары арасындағы пауза, мс. 0 — ең жылдам. */
  confirmDelayMs: number;

  /* --- сессияны тірі ұстау --- */
  /** Тінтуірді қозғау аралығы, сек. Бетті ЖАҢАРТПАЙДЫ. */
  mouseMoveSec: number;

  /* --- график --- */
  scheduleEnabled: boolean;
  scheduleFrom: number;
  scheduleTo: number;

  /* --- қосалқы --- */
  autostart: boolean;
  telegramToken: string;
  telegramChatId: string;
}

export const DEFAULT_SETTINGS: SemSettings = {
  siteUrl: '',
  username: '',
  password: '',

  aiApiKey: '',
  aiModel: 'gemini-flash-latest',
  aiBaseUrl: '',

  taskText: '',

  scanIntervalMs: 150,
  confirmDelayMs: 0,

  mouseMoveSec: 45,

  scheduleEnabled: false,
  scheduleFrom: 9,
  scheduleTo: 21,

  autostart: false,
  telegramToken: '',
  telegramChatId: '',
};

export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof SemSettings)[];

const ENV_KEYS: Partial<Record<keyof SemSettings, string>> = {
  siteUrl: 'SITE_URL',
  username: 'SITE_USERNAME',
  password: 'SITE_PASSWORD',
  aiApiKey: 'AI_API_KEY',
  aiModel: 'AI_MODEL',
  aiBaseUrl: 'AI_BASE_URL',
  taskText: 'TASK_TEXT',
  scanIntervalMs: 'SCAN_INTERVAL_MS',
  confirmDelayMs: 'CONFIRM_DELAY_MS',
  mouseMoveSec: 'MOUSE_MOVE_SEC',
  scheduleEnabled: 'SCHEDULE_ENABLED',
  scheduleFrom: 'SCHEDULE_FROM',
  scheduleTo: 'SCHEDULE_TO',
  autostart: 'AUTOSTART',
  telegramToken: 'TELEGRAM_TOKEN',
  telegramChatId: 'TELEGRAM_CHAT_ID',
};

/** Санды параметрлердің қауіпсіз шектері. */
const LIMITS: Partial<Record<keyof SemSettings, { min: number; max: number }>> = {
  scanIntervalMs: { min: 50, max: 5000 },
  confirmDelayMs: { min: 0, max: 5000 },
  mouseMoveSec: { min: 15, max: 600 },
  scheduleFrom: { min: 0, max: 23 },
  scheduleTo: { min: 0, max: 23 },
};

function clampNum(key: keyof SemSettings, v: number): number {
  const l = LIMITS[key];
  if (!l) return v;
  return Math.min(l.max, Math.max(l.min, v));
}

function envValue(key: keyof SemSettings): unknown {
  const name = ENV_KEYS[key];
  const raw = name ? process.env[name] : undefined;
  if (raw == null || raw === '') return undefined;
  const def = DEFAULT_SETTINGS[key];
  if (typeof def === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? clampNum(key, n) : undefined;
  }
  if (typeof def === 'boolean') return raw === 'true' || raw === '1';
  return raw;
}

const stmtAll = db.prepare('SELECT key,value FROM settings');
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
    /* Дискідегі сан да шектен шықпауы керек: 10 мс скан браузерді жүктейді. */
    if (typeof DEFAULT_SETTINGS[key] === 'number') {
      const n = Number(out[key]);
      out[key] = Number.isFinite(n) ? clampNum(key, n) : DEFAULT_SETTINGS[key];
    }
  }
  return out as unknown as SemSettings;
}

export function getSetting<K extends keyof SemSettings>(key: K): SemSettings[K] {
  return getAllSettings()[key];
}

export function setSettingsPatch(patch: Partial<Record<string, unknown>>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (!SETTINGS_KEYS.includes(k as keyof SemSettings)) continue;
    const key = k as keyof SemSettings;
    let value: unknown = v;
    if (typeof DEFAULT_SETTINGS[key] === 'number') {
      const n = Number(v);
      value = Number.isFinite(n) ? clampNum(key, n) : DEFAULT_SETTINGS[key];
    }
    if (typeof DEFAULT_SETTINGS[key] === 'boolean') {
      value = v === true || v === 'true' || v === 1 || v === '1';
    }
    stmtSet.run(k, JSON.stringify(value));
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
