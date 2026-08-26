import { chromium, type BrowserContext, type Page } from 'playwright';
import { PROFILE_DIR, SHOTS_DIR, HEADLESS, NO_SANDBOX, DATA_DIR } from './config.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

mkdirSync(PROFILE_DIR, { recursive: true });
mkdirSync(SHOTS_DIR, { recursive: true });

export const SESSION_BACKUP_PATH = join(DATA_DIR, 'session-backup.json');

let ctx: BrowserContext | null = null;

const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

export async function getContext(): Promise<BrowserContext> {
  if (ctx) return ctx;
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    args: NO_SANDBOX ? LAUNCH_ARGS : LAUNCH_ARGS.slice(0, 2),
    viewport: null,
    ignoreHTTPSErrors: true,
  });
  return ctx;
}

export async function getPage(): Promise<Page> {
  const c = await getContext();
  const existing = c.pages()[0];
  if (existing) return existing;
  const p = await c.newPage();
  void p;
  return c.pages()[0] ?? p;
}

export async function closeBrowser(): Promise<void> {
  try {
    await ctx?.close();
  } catch {
    /* ignore */
  }
  ctx = null;
}

export async function screenshot(name: string): Promise<string | null> {
  try {
    const page = await getPage();
    const file = join(SHOTS_DIR, `${Date.now()}-${name.replace(/[^\w-]/g, '_')}.png`);
    await page.screenshot({ path: file });
    return file.split('/').pop() ?? null;
  } catch {
    return null;
  }
}

export function shotsDir(): string {
  return SHOTS_DIR;
}

export async function backupSession(): Promise<boolean> {
  try {
    const c = await getContext();
    await c.storageState({ path: SESSION_BACKUP_PATH });
    return true;
  } catch {
    return false;
  }
}
