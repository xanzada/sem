import type { Page } from 'playwright';
import { getSetting } from './settings.js';

export type PageKind = 'NORMAL' | 'AUTH' | 'SECURITY' | 'UNEXPECTED';

export interface Classification {
  kind: PageKind;
  reason: string;
}

const SECURITY_RE =
  /(just a moment|проверка браузера|проверка безопасности|verify you are human|attention required|checking your browser|ddos-guard|captcha-delivery|cf-challenge|challenge-platform|__cf_chl|turnstile|подтвердите, что вы не робот)/i;

const AUTH_TEXT_RE =
  /(вход в систему|авторизац|введите логин|войти в аккаунт|sign in to|log in to|forgot your password|забыли пароль)/i;

export async function classifyPage(page: Page): Promise<Classification> {
  const siteUrl = String(getSetting('siteUrl') || '').replace(/\/+$/, '');
  let url = '';
  try {
    url = page.url();
  } catch {
    /* closed */
  }

  if (!siteUrl) return { kind: 'NORMAL', reason: '' };

  if (!url || url.startsWith('about:') || url.startsWith('chrome://')) {
    return { kind: 'UNEXPECTED', reason: 'Страница не открыта' };
  }

  let text = '';
  try {
    text = (await page.locator('body').innerText({ timeout: 2500 })).slice(0, 6000);
  } catch {
    /* keep empty */
  }

  if (SECURITY_RE.test(text) || SECURITY_RE.test(url)) {
    return { kind: 'SECURITY', reason: 'Обнаружена проверка безопасности сайта' };
  }

  let pwdFields = 0;
  try {
    pwdFields = await page.locator('input[type=password]:visible').count();
  } catch {
    pwdFields = 0;
  }
  const authish = AUTH_TEXT_RE.test(text) || /\/(login|signin|auth)/i.test(url);
  if (pwdFields > 0 && authish && !looksLikeWorkspace(url)) {
    return { kind: 'AUTH', reason: 'Открыта страница входа' };
  }

  if (url.startsWith(siteUrl)) return { kind: 'NORMAL', reason: '' };

  return { kind: 'UNEXPECTED', reason: `Неожиданная страница: ${url.slice(0, 90)}` };
}

function looksLikeWorkspace(url: string): boolean {
  return /\/(dashboard|apps|applications|orders|requests|admin|cabinet|profile)/i.test(url);
}
