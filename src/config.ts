import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as pathResolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export const ROOT = pathResolve(join(here, '..'));
export const PUBLIC_DIR = join(ROOT, 'public');
export const DATA_DIR = pathResolve(process.env.SEM_DATA_DIR ?? join(ROOT, 'data'));
export const PROFILE_DIR = join(DATA_DIR, 'profile');
export const SHOTS_DIR = join(DATA_DIR, 'shots');

export const PORT = Number(process.env.PORT ?? 8080);
export const HOST = process.env.HOST ?? '0.0.0.0';
export const HEADLESS = (process.env.HEADLESS ?? 'true') === 'true';
export const NO_SANDBOX = (process.env.NO_SANDBOX ?? 'false') === 'true';
export const NOVNC_PUBLIC_URL = process.env.NOVNC_PUBLIC_URL ?? '';
export const TZ = process.env.TZ ?? 'Asia/Almaty';
export const VERSION = '0.1.0';
