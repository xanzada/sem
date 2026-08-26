import type { Page } from 'playwright';
import {
  getSetting,
  getAllSettings,
} from './settings.js';
import { classifyPage } from './classifier.js';
import {
  beginIntent,
  confirmIntent,
  failIntent,
  pendingIntentsForApp,
} from './ledger.js';
import { recordApplication } from './analytics.js';
import { saveCheckpoint } from './checkpoint.js';
import { sleep } from './util.js';
import {
  MissingSelectorsError,
  SimulatedIncident,
  type DriverCtx,
  type Step,
  type WorkflowDriver,
} from './types.js';

interface Selectors {
  listRow?: string | string[];
  openLink?: string | string[];
  statusPending?: string | string[];
  statusAccepted?: string | string[];
  acceptButton?: string | string[];
}

export class SelectorBrokenError extends Error {
  constructor(public key: string) {
    super(`Элемент сайтта табылмады: ${key}. Настройки → Селекторы жаңартыңыз.`);
  }
}

function cands(v?: string | string[]): string[] {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

async function firstVisible(page: Page, list: string[]): Promise<import('playwright').Locator | null> {
  for (const s of list) {
    try {
      const loc = page.locator(s).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
    } catch {
      /* try next */
    }
  }
  return null;
}

const DEFAULT_DEMO_SELECTORS: Selectors = {
  listRow: '#appsTable tbody tr',
  openLink: 'a.open',
  statusPending: '.badge.pending',
  statusAccepted: '.badge.accepted',
  acceptButton: '#acceptBtn',
};

export function readSelectors(): Selectors {
  const raw = String(getSetting('selectorsJson') || '').trim();
  if (!raw) return { ...DEFAULT_DEMO_SELECTORS };
  try {
    const parsed = JSON.parse(raw) as Selectors;
    if (!parsed.listRow && !parsed.acceptButton) return { ...DEFAULT_DEMO_SELECTORS };
    return parsed;
  } catch {
    throw new Error('Селекторы заданы неверно — это должен быть корректный JSON');
  }
}

function requireCands(sel: Selectors, key: keyof Selectors): string[] {
  const c = cands(sel[key]);
  if (c.length === 0) throw new SelectorBrokenError(String(key));
  return c;
}

export class DemoDriver implements WorkflowDriver {
  name = 'demo';
  private seq = 0;
  private appId: string | null = null;
  private intentId: string | null = null;
  private phase: 'find' | 'open' | 'verify' | 'accept' | 'confirm' | 'cleanup' = 'find';
  private appStartedAt = 0;

  constructor(private readonly restoredSeq = 0) {
    this.seq = restoredSeq;
  }

  async cycle(ctx: DriverCtx): Promise<void> {
    switch (this.phase) {
      case 'find': {
        const r = ctx.rand();
        if (r < 0.05) throw new SimulatedIncident('SECURITY');
        if (r < 0.08) throw new SimulatedIncident('AUTH');
        ctx.setStep('Поиск новых заявок');
        await ctx.delay(1);
        this.seq += 1;
        this.appId = String(18490 + this.seq);
        this.appStartedAt = Date.now();
        ctx.log('info', 'WORKFLOW', `Найдена новая заявка #${this.appId}`);
        await ctx.saveCheckpoint({
          appId: this.appId,
          step: 'find',
          nextAction: 'open_application',
          url: 'demo://list',
          lastStatus: 'pending',
        });
        this.phase = 'open';
        return;
      }
      case 'open': {
        ctx.setStep(`Открытие заявки #${this.appId}`);
        await ctx.delay(1.2);
        ctx.log('info', 'WORKFLOW', `Заявка #${this.appId} открыта`);
        await ctx.saveCheckpoint({
          appId: this.appId,
          step: 'open',
          nextAction: 'check_status',
          url: `demo://application/${this.appId}`,
          lastStatus: 'pending',
        });
        this.phase = 'verify';
        return;
      }
      case 'verify': {
        ctx.setStep(`Проверка статуса заявки #${this.appId}`);
        await ctx.delay(1);
        const pend = await ctx.getPendingIntents(String(this.appId));
        if (pend.length > 0) {
          ctx.log(
            'warn',
            'WORKFLOW',
            `Заявка #${this.appId}: действие уже выполнялось до прерывания — повторное нажатие НЕ производится, проверяю результат`
          );
          await ctx.delay(1.2);
          await ctx.confirmIntent(pend[0].id);
          await ctx.recordApplication({
            appId: String(this.appId),
            result: 'accepted',
            durationMs: Date.now() - this.appStartedAt,
          });
          ctx.log('success', 'WORKFLOW', `Заявка #${this.appId} принята (восстановлено безопасно)`);
          await ctx.saveCheckpoint({
            appId: this.appId,
            step: 'confirm',
            nextAction: 'next_application',
            url: `demo://application/${this.appId}`,
            lastStatus: 'accepted',
          });
          this.intentId = null;
          this.phase = 'cleanup';
          return;
        }
        this.intentId = await ctx.beginIntent(String(this.appId), 'accept');
        ctx.log('info', 'WORKFLOW', `Статус заявки #${this.appId}: В обработке → принимаю`);
        await ctx.saveCheckpoint({
          appId: this.appId,
          step: 'verify',
          nextAction: 'press_accept',
          url: `demo://application/${this.appId}`,
          lastStatus: 'pending',
        });
        this.phase = 'accept';
        return;
      }
      case 'accept': {
        ctx.setStep(`Нажатие «Принять» для #${this.appId}`);
        await ctx.delay(1.6);
        ctx.log('info', 'WORKFLOW', `Нажата кнопка «Принять» (заявка #${this.appId})`);
        this.phase = 'confirm';
        return;
      }
      case 'confirm': {
        ctx.setStep(`Подтверждение результата по #${this.appId}`);
        await ctx.delay(1.4);
        if (this.intentId) await ctx.confirmIntent(this.intentId);
        await ctx.recordApplication({
          appId: String(this.appId),
          result: 'accepted',
          durationMs: Date.now() - this.appStartedAt,
        });
        ctx.log('success', 'WORKFLOW', `Заявка #${this.appId} принята ✅`);
        await ctx.saveCheckpoint({
          appId: this.appId,
          step: 'confirm',
          nextAction: 'next_application',
          url: `demo://application/${this.appId}`,
          lastStatus: 'accepted',
        });
        this.phase = 'cleanup';
        return;
      }
      case 'cleanup': {
        ctx.setStep('Переход к следующей заявке');
        await ctx.delay(0.8);
        this.appId = null;
        this.intentId = null;
        this.phase = 'find';
        return;
      }
    }
  }

  restoreSeq(): number {
    return this.seq;
  }
}

export function createDemoDriver(restoredSeq: number): DemoDriver {
  return new DemoDriver(restoredSeq);
}

export class LiveHttpDriver implements WorkflowDriver {
  name = 'live';

  async cycle(ctx: DriverCtx): Promise<void> {
    const s = getAllSettings();
    const sel = readSelectors();
    const page = ctx.page;

    ctx.setStep('Открытие списка заявок');
    const target = s.listUrl || s.siteUrl;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await ctx.delay(1);

    const cls = await classifyPage(page).catch(() => ({ kind: 'NORMAL' as const, reason: '' }));
    if (cls.kind === 'AUTH') {
      ctx.log('warn', 'AUTH', 'Сессия потеряна: сайт требует вход. Запускаю автоматический вход.');
      return;
    }
    if (cls.kind === 'SECURITY') {
      ctx.log('info', 'SECURITY', 'Сайт показал проверку — ожидаю её завершения.');
      return;
    }

    let row: import('playwright').Locator | null = null;
    let fallbackRow: import('playwright').Locator | null = null;
    const pendFirst = cands(sel.statusPending)[0];
    for (const rs of requireCands(sel, 'listRow')) {
      try {
        const plain = page.locator(rs).first();
        if (!fallbackRow && (await plain.count()) > 0) fallbackRow = plain;
        if (pendFirst) {
          const filtered = page.locator(`${rs}:has(${pendFirst})`).first();
          if ((await filtered.count()) > 0) {
            row = filtered;
            break;
          }
        }
      } catch {
        /* next candidate */
      }
    }
    row = row ?? fallbackRow;
    if (!row) {
      ctx.log('info', 'WORKFLOW', 'Свободных заявок в обработке нет — ожидаю новых');
      await ctx.delay(3);
      return;
    }

    let openTarget = row;
    for (const oc of requireCands(sel, 'openLink')) {
      try {
        const inner = row.locator(oc).first();
        if ((await inner.count()) > 0) {
          openTarget = inner;
          break;
        }
      } catch {
        /* next */
      }
    }
    await openTarget.first().click();
    await ctx.delay(1.5);

    const url = page.url();
    const m = url.match(/(\d+)\/?(?:[?#].*)?$/) ?? url.match(/(\d{3,})/);
    const appId = m ? m[1] : url.slice(-40);
    ctx.setStep(`Открыта заявка #${appId}`);
    await ctx.saveCheckpoint({
      appId,
      step: 'open',
      nextAction: 'check_status',
      url,
      lastStatus: 'unknown',
    });

    const pend = await ctx.getPendingIntents(appId);
    if (pend.length > 0) {
      ctx.log(
        'warn',
        'WORKFLOW',
        `Заявка #${appId}: действие уже выполнялось ранее — повтор не требуется`
      );
      await ctx.confirmIntent(pend[0].id);
      await ctx.recordApplication({ appId, result: 'accepted', durationMs: 0 });
      return;
    }

    let isPending = false;
    for (const ps of requireCands(sel, 'statusPending')) {
      try {
        if (await page.locator(ps).first().isVisible()) {
          isPending = true;
          break;
        }
      } catch {
        /* next */
      }
    }
    if (!isPending) {
      let isAccepted = false;
      for (const as of cands(sel.statusAccepted)) {
        try {
          if (await page.locator(as).first().isVisible()) {
            isAccepted = true;
            break;
          }
        } catch {
          /* next */
        }
      }
      if (isAccepted) {
        ctx.log('info', 'WORKFLOW', `Заявка #${appId} уже принята — пропускаю`);
        return;
      }
      throw new SelectorBrokenError('statusPending / statusAccepted');
    }

    const startedAt = Date.now();
    const intentId = await ctx.beginIntent(appId, 'accept');
    await ctx.saveCheckpoint({
      appId,
      step: 'verify',
      nextAction: 'press_accept',
      url,
      lastStatus: 'pending',
    });

    const btnCands = requireCands(sel, 'acceptButton');
    ctx.setStep(`Нажатие «Принять» для #${appId}`);
    const btn = await firstVisible(page, btnCands);
    if (!btn) throw new SelectorBrokenError('acceptButton');
    await btn.click();
    await ctx.delay(1);

    let confirmed = false;
    for (const as of cands(sel.statusAccepted)) {
      try {
        if (await page.locator(as).first().isVisible()) {
          confirmed = true;
          break;
        }
      } catch {
        /* next */
      }
    }
    if (cands(sel.statusAccepted).length === 0) confirmed = true;
    if (!confirmed) {
      await ctx.failIntent(intentId, 'Статус не изменился после нажатия');
      throw new Error(`Заявка #${appId}: подтверждение принятия не найдено`);
    }

    await ctx.confirmIntent(intentId);
    await ctx.recordApplication({
      appId,
      result: 'accepted',
      durationMs: Date.now() - startedAt,
    });
    ctx.log('success', 'WORKFLOW', `Заявка #${appId} принята ✅`);
    if (getSetting('evidenceShots')) {
      await ctx.shot?.(`accepted-${appId}`);
    }
    await ctx.saveCheckpoint({
      appId,
      step: 'confirm',
      nextAction: 'next_application',
      url,
      lastStatus: 'accepted',
    });
    await sleep(200);
  }
}

export { failIntent };

export class StepsDriver implements WorkflowDriver {
  name = 'steps';
  private pendingAccept: { id: string; appId: string } | null = null;

  async cycle(ctx: DriverCtx): Promise<void> {
    const steps = parseSteps();
    if (steps.length === 0) throw new MissingSelectorsError();
    const page = ctx.page;

    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const label = st.note || st.act;
      ctx.setStep(`Шаг ${i + 1}/${steps.length}: ${label}`);
      ctx.log('info', 'WORKFLOW', `Шаг ${i + 1}/${steps.length}: ${label}`);

      switch (st.act) {
        case 'open': {
          const s = getAllSettings();
          await page.goto(st.url || s.listUrl || s.siteUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          await ctx.delay(1);
          break;
        }
        case 'click':
        case 'accept': {
          const el = await firstVisible(page, st.sel ?? []);
          if (!el) throw new SelectorBrokenError(`шаг ${i + 1} — ${label}`);
          const appId = extractAppId(page.url());
          if (st.act === 'accept') {
            const intentId = await ctx.beginIntent(appId, 'accept');
            this.pendingAccept = { id: intentId, appId };
            await ctx.saveCheckpoint({
              appId,
              step: `step${i + 1}`,
              nextAction: 'accept',
              url: page.url(),
              lastStatus: 'pending',
            });
          }
          await el.click();
          await ctx.delay(1);
          break;
        }
        case 'check': {
          let okFlag = false;
          for (let t = 0; t < 10; t++) {
            if (await firstVisible(page, st.sel ?? [])) {
              okFlag = true;
              break;
            }
            await sleep(1000);
          }
          if (!okFlag) {
            if (this.pendingAccept) {
              await ctx.failIntent(this.pendingAccept.id, `проверка шага ${i + 1} не прошла`);
              this.pendingAccept = null;
            }
            throw new SelectorBrokenError(`шаг ${i + 1} — ${label} (не дождались)`);
          }
          if (this.pendingAccept) {
            await ctx.confirmIntent(this.pendingAccept.id);
            await ctx.recordApplication({
              appId: this.pendingAccept.appId,
              result: 'accepted',
              durationMs: 0,
            });
            ctx.log(
              'success',
              'WORKFLOW',
              `Заявка #${this.pendingAccept.appId} принята ✅ (подтверждено шагом ${i + 1})`
            );
            if (getSetting('evidenceShots')) await ctx.shot?.(`accepted-${this.pendingAccept.appId}`);
            this.pendingAccept = null;
          }
          break;
        }
        case 'back':
          await page.goBack().catch(() => {});
          await ctx.delay(1);
          break;
        case 'wait':
          await sleep((st.sec ?? 2) * 1000);
          break;
      }
    }

    if (this.pendingAccept) {
      await ctx.confirmIntent(this.pendingAccept.id);
      await ctx.recordApplication({
        appId: this.pendingAccept.appId,
        result: 'accepted',
        durationMs: 0,
      });
      ctx.log('success', 'WORKFLOW', `Заявка #${this.pendingAccept.appId} принята ✅`);
      this.pendingAccept = null;
    }
  }
}

function extractAppId(url: string): string {
  const m = url.match(/(\d+)\/?(?:[?#].*)?$/);
  return m ? m[1] : url.slice(-40);
}

export function parseSteps(): Step[] {
  const raw = String(getSetting('stepsJson') || '').trim();
  if (!raw) return [];
  try {
    const p = JSON.parse(raw) as unknown;
    if (Array.isArray(p)) return p as Step[];
    if (p && typeof p === 'object' && Array.isArray((p as { steps?: unknown }).steps)) {
      return (p as { steps: Step[] }).steps;
    }
  } catch {
    /* bad json */
  }
  return [];
}
