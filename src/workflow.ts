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
  type WorkflowDriver,
} from './types.js';

interface Selectors {
  listRow?: string;
  openLink?: string;
  statusPending?: string;
  statusAccepted?: string;
  acceptButton?: string;
}

const DEFAULT_DEMO_SELECTORS: Selectors = {
  listRow: '#appsTable tbody tr',
  openLink: 'a.open',
  statusPending: '.badge.pending',
  statusAccepted: '.badge.accepted',
  acceptButton: '#acceptBtn',
};

function readSelectors(): Selectors {
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

function requireSelector(sel: Selectors, key: keyof Selectors): string {
  const v = sel[key];
  if (!v) throw new MissingSelectorsError();
  return v;
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
    ctx.log(
      'info',
      'SYSTEM',
      `[dbg] url=${String(page.url()).slice(0, 90)} kind=${cls.kind} ${cls.reason}`
    );
    if (cls.kind === 'AUTH') {
      ctx.log('warn', 'AUTH', 'Сессия потеряна: сайт требует вход. Запускаю автоматический вход.');
      return;
    }
    if (cls.kind === 'SECURITY') {
      ctx.log('info', 'SECURITY', 'Сайт показал проверку — ожидаю её завершения.');
      return;
    }

    const rowSel = requireSelector(sel, 'listRow');
    const row = page.locator(rowSel).first();
    if ((await row.count()) === 0) {
      ctx.log('info', 'WORKFLOW', 'Список пуст — свободных заявок нет');
      await ctx.delay(3);
      return;
    }

    const openSel = sel.openLink ? row.locator(sel.openLink) : row;
    await openSel.first().click();
    await ctx.delay(1.5);

    const url = page.url();
    const m = url.match(/(\d{3,})(?:[^\d]*)?$/);
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

    const pendingSel = requireSelector(sel, 'statusPending');
    const isPending = await page.locator(pendingSel).first().isVisible().catch(() => false);
    if (!isPending) {
      const accSel = sel.statusAccepted;
      const isAccepted = accSel
        ? await page.locator(accSel).first().isVisible().catch(() => false)
        : false;
      if (isAccepted) {
        ctx.log('info', 'WORKFLOW', `Заявка #${appId} уже принята — пропускаю`);
        return;
      }
      throw new Error(`Заявка #${appId}: ожидаемый статус не найден`);
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

    const btnSel = requireSelector(sel, 'acceptButton');
    ctx.setStep(`Нажатие «Принять» для #${appId}`);
    await page.locator(btnSel).first().click();
    await ctx.delay(1);

    const accSel2 = sel.statusAccepted ?? pendingSel;
    const confirmed = !(await page.locator(accSel2).first().isVisible().catch(() => false)) ||
      (sel.statusAccepted
        ? await page.locator(sel.statusAccepted).first().isVisible().catch(() => false)
        : true);
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
