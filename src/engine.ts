import type { Page } from 'playwright';
import { WState, STATE_META } from './states.js';
import { getAllSettings, getSetting } from './settings.js';
import { classifyPage, type Classification } from './classifier.js';
import { getPage, closeBrowser, screenshot } from './browser.js';
import { log } from './logger.js';
import { bus } from './bus.js';
import { tgNotify } from './telegram.js';
import {
  beginIntent,
  confirmIntent,
  failIntent,
  pendingIntentsForApp,
} from './ledger.js';
import { recordApplication, countToday } from './analytics.js';
import {
  saveCheckpoint,
  latestCheckpoint,
  resolveCheckpointsForApp,
} from './checkpoint.js';
import { createDemoDriver, LiveHttpDriver, SelectorBrokenError } from './workflow.js';
import {
  MissingSelectorsError,
  SimulatedIncident,
  type DriverCtx,
  type Snapshot,
  type WorkflowDriver,
} from './types.js';
import { sleep, jittered, nowIso } from './util.js';
import { NOVNC_PUBLIC_URL, VERSION } from './config.js';

type ClassifierFn = () => Promise<Classification>;

export class Engine {
  state: WState = WState.STOPPED;
  since = nowIso();
  step = '';
  currentAppId: string | null = null;
  paused = false;
  running = false;

  private startedAt = Date.now();
  private stopRequested = false;
  private driver: WorkflowDriver | null = null;
  private lastActivity = Date.now();
  private demoSeqRestored = 0;
  private authAlerted = false;

  snapshot(): Snapshot {
    const meta = STATE_META[this.state];
    return {
      state: this.state as string,
      stateRu: meta.ru,
      emoji: meta.emoji,
      since: this.since,
      currentAppId: this.currentAppId,
      step: this.step,
      paused: this.paused,
      running: this.running,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      processedToday: countToday(),
      mode: String(getSetting('mode')),
      speed: Number(getSetting('speed')) || 1,
      vncUrl: NOVNC_PUBLIC_URL,
      version: VERSION,
    };
  }

  applySettings(): void {
    const s = getAllSettings();
    this.driver = this.makeDriver(s.mode === 'simulation');
    log('info', 'CONTROL', 'Настройки применены');
    bus.emit('status', this.snapshot());
  }

  private makeDriver(simulation: boolean): WorkflowDriver {
    return simulation ? createDemoDriver(this.demoSeqRestored) : new LiveHttpDriver();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stopRequested = false;
    this.paused = false;
    this.startedAt = Date.now();
    const s = getAllSettings();
    const simulation = s.mode === 'simulation';

    if (!simulation && !s.siteUrl) {
      this.setState(WState.ERROR, 'Не задан адрес сайта в настройках');
      log('error', 'CONTROL', 'Запуск невозможен: не указан адрес сайта');
      return;
    }
    if (!simulation && !(s.username && s.password)) {
      log('warn', 'AUTH', 'Логин или пароль не заданы — при потере сессии потребуется оператор');
    }

    const cp = latestCheckpoint();
    if (cp && cp.next_action !== 'done' && cp.application_id) {
      log(
        'info',
        'WORKFLOW',
        `Восстановлен чекпоинт: заявка #${cp.application_id}, шаг «${cp.step ?? ''}» — продолжаю с безопасной точки`
      );
      this.currentAppId = cp.application_id;
      this.demoSeqRestored = Math.max(0, Number(cp.application_id) - 18490);
    }

    this.driver = this.makeDriver(simulation);
    log(
      'info',
      'CONTROL',
      simulation ? 'SEM запускается (демо-режим)' : 'SEM запускается (боевой режим)'
    );
    this.setState(WState.STARTING, simulation ? 'Инициализация' : 'Запуск браузера');

    if (!simulation) {
      try {
        await getPage();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.setState(WState.ERROR, `Браузер не запустился: ${msg.slice(0, 100)}`);
        log('error', 'SYSTEM', `Браузер не запустился: ${msg}`);
        return;
      }
    }

    this.running = true;
    this.setState(WState.RUNNING, 'Работа');
    void this.loop();
  }

  stop(): void {
    this.stopRequested = true;
    this.running = false;
    log('info', 'CONTROL', 'SEM остановлен оператором (браузер и сессия сохранены)');
    this.setState(WState.STOPPED, '');
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    log('info', 'CONTROL', 'Пауза по команде оператора');
    this.setState(WState.WAITING, 'Пауза');
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    log('info', 'CONTROL', 'Работа возобновлена');
    this.setState(WState.RUNNING, 'Работа');
  }

  async testLogin(): Promise<boolean> {
    const s = getAllSettings();
    if (s.mode === 'simulation') {
      log('info', 'AUTH', 'Демо-режим: тест входа имитируется успешно');
      return true;
    }
    if (!s.siteUrl || !s.username || !s.password) {
      log('warn', 'AUTH', 'Тест входа: заполните адрес сайта, логин и пароль');
      return false;
    }
    return await this.tryLogin(true);
  }

  private setState(s: WState, step?: string): void {
    const prev = this.state;
    if (step !== undefined) this.step = step;
    if (s === prev && step === undefined) return;
    this.state = s;
    this.since = nowIso();
    bus.emit('status', this.snapshot());
    if (s !== prev) {
      log('info', 'SYSTEM', `Состояние: ${STATE_META[prev].ru} → ${STATE_META[s].ru}`);
      if (
        s === WState.AUTH_REQUIRED ||
        s === WState.MANUAL_REVIEW ||
        s === WState.ERROR
      ) {
        void tgNotify(
          `${STATE_META[s].emoji} <b>SEM</b>: ${STATE_META[s].ru}\n${this.step ?? ''}`
        );
      }
    }
  }

  private makeCtx(page: Page): DriverCtx {
    const self = this;
    return {
      page,
      log,
      setStep(label: string): void {
        self.step = label;
        bus.emit('status', self.snapshot());
      },
      async delay(mult = 1): Promise<void> {
        const base = Number(getSetting('actionDelayMs')) || 800;
        const speed = Number(getSetting('speed')) || 1;
        await sleep(jittered(base * mult * speed));
      },
      async beginIntent(appId: string, type: string): Promise<string> {
        self.currentAppId = appId;
        bus.emit('status', self.snapshot());
        return beginIntent(appId, type);
      },
      async confirmIntent(id: string): Promise<void> {
        confirmIntent(id);
      },
      async failIntent(id: string, note?: string): Promise<void> {
        failIntent(id, note);
      },
      async getPendingIntents(appId: string) {
        return pendingIntentsForApp(appId);
      },
      async recordApplication(a): Promise<void> {
        recordApplication(a);
        if (a.appId) resolveCheckpointsForApp(a.appId);
        bus.emit('status', self.snapshot());
      },
      async saveCheckpoint(c): Promise<void> {
        saveCheckpoint(c);
      },
      rand(): number {
        return Math.random();
      },
    };
  }

  private classifierFor(simulation: boolean, page: Page | null): ClassifierFn {
    if (simulation || !page) {
      return async () => {
        await sleep(2500);
        return { kind: 'NORMAL', reason: 'demo' };
      };
    }
    return () => classifyPage(page);
  }

  private async loop(): Promise<void> {
    let unexpectedCount = 0;
    while (this.running && !this.stopRequested) {
      try {
        if (this.paused) {
          await sleep(1500);
          continue;
        }
        const s = getAllSettings();
        const simulation = s.mode === 'simulation';
        let page: Page | null = null;
        let cls: Classification = { kind: 'NORMAL', reason: '' };

        if (!simulation) {
          page = await getPage();
          cls = await classifyPage(page);
          if (cls.kind === 'SECURITY') {
            await this.securityWait(this.classifierFor(false, page));
            continue;
          }
          if (cls.kind === 'AUTH') {
            await this.handleAuthLost();
            continue;
          }
          if (cls.kind === 'UNEXPECTED') {
            unexpectedCount += 1;
            if (unexpectedCount <= 2) {
              log('warn', 'SYSTEM', `Страница не распознана (${cls.reason}) — возвращаюсь на сайт`);
              const target = s.listUrl || s.siteUrl;
              try {
                await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });
              } catch {
                /* retry next cycle */
              }
              await sleep(2000);
              continue;
            }
            await this.manualReview(`Не удалось вернуться на сайт: ${cls.reason}`);
            continue;
          }
          unexpectedCount = 0;
        }

        this.lastActivity = Date.now();
        await this.driver!.cycle(this.makeCtx(page ?? ({} as Page)));

        const idleMs = Date.now() - this.lastActivity;
        const keepaliveSec = Number(getSetting('keepaliveSec')) || 180;
        if (!simulation && page && idleMs > keepaliveSec * 1000) {
          await this.keepalive(page);
        }
      } catch (e) {
        if (e instanceof SimulatedIncident) {
          if (e.kind === 'SECURITY') {
            await this.securityWait(this.classifierFor(true, null), true);
          } else {
            await this.handleAuthLost(true);
          }
          continue;
        }
        if (e instanceof MissingSelectorsError) {
          await this.manualReview(e.message);
          continue;
        }
        if (e instanceof SelectorBrokenError) {
          const shot = await screenshot(`broken-${e.key.replace(/\W+/g, '_')}`);
          log('error', 'WORKFLOW', `Элемент сайта не найден: ${e.key}. Скриншот сохранён, заявки не трогаю.`);
          void tgNotify(
            `🟠 <b>SEM</b>: элемент <code>${e.key}</code> на сайте не найден.\nСайт изменился? Обновите селекторы в Настройках (без передеплоя).\nСкриншот в журнале.`
          );
          await this.manualReview(e.message);
          continue;
        }
        const msg = e instanceof Error ? e.message : String(e);
        log('error', 'WORKFLOW', `Сбой цикла: ${msg.slice(0, 160)}`);
        this.setState(WState.ERROR, msg.slice(0, 140));
        await sleep(6000);
        if (this.running && !this.stopRequested) this.setState(WState.RUNNING);
      }
    }
  }

  private async keepalive(page: Page): Promise<void> {
    try {
      await page.mouse.move(200 + Math.random() * 300, 150 + Math.random() * 200);
      await page.mouse.wheel(0, 60 + Math.random() * 80);
      await page.mouse.wheel(0, -(60 + Math.random() * 80));
      log('info', 'SYSTEM', 'Поддержание активности сессии (без перезагрузки страницы)');
      this.lastActivity = Date.now();
    } catch {
      /* ignore */
    }
  }

  private async revalidate(classify: ClassifierFn): Promise<boolean> {
    log('info', 'SYSTEM', 'Перепроверка состояния: сайт → сессия → текущая заявка');
    await sleep(1200);
    const cls = await classify();
    log('info', 'SYSTEM', cls.kind === 'NORMAL'
      ? 'Проверка пройдена: страница и сессия в норме'
      : `Проверка: ${cls.reason}`);
    return cls.kind === 'NORMAL';
  }

  private async securityWait(classify: ClassifierFn, simulated = false): Promise<void> {
    const timeoutMin = Number(getSetting('securityTimeoutMin')) || 30;
    log(
      'warn',
      'SECURITY',
      `Обнаружена проверка безопасности сайта. Действия приостановлены, жду автоматического завершения (лимит ${timeoutMin} мин). Обход проверки не выполняется.`
    );
    await screenshot('security-wait');
    void tgNotify(`🛡 <b>SEM</b>: сайт показал проверку безопасности. Ожидаю автоматического завершения…`);
    this.setState(WState.SECURITY_VERIFICATION_WAIT, 'Ожидание проверки сайта');

    const deadline = Date.now() + timeoutMin * 60000;
    while (Date.now() < deadline && this.running && !this.stopRequested) {
      await sleep(simulated ? 3000 : 5000);
      const cls = await classify().catch(() => ({ kind: 'UNEXPECTED' as const, reason: 'poll' }));
      if (cls.kind === 'NORMAL') {
        log('success', 'SECURITY', 'Проверка завершилась автоматически. Перепроверяю состояние…');
        await this.revalidate(classify);
        this.setState(WState.RUNNING, 'Возобновление после проверки');
        log('success', 'SECURITY', 'Работа возобновлена с контрольной точки без потери заявки');
        return;
      }
      if (cls.kind === 'AUTH') {
        await this.handleAuthLost();
        return;
      }
    }
    await screenshot('security-timeout');
    await this.safeStop(
      `Проверка безопасности не завершилась за ${timeoutMin} мин. Состояние сохранено (SAFE_STOP).`
    );
  }

  private async handleAuthLost(simulated = false): Promise<void> {
    log('warn', 'AUTH', 'Сессия истекла: сайт требует вход. Пробую войти автоматически…');
    await screenshot('auth-lost');
    if (!this.authAlerted) {
      void tgNotify('🔐 <b>SEM</b>: сессия истекла. Выполняю автоматический вход…');
      this.authAlerted = true;
    }
    this.setState(WState.AUTH_REQUIRED, 'Автоматический вход');

    const ok = simulated ? await this.simLogin() : await this.tryLogin();
    if (ok) {
      this.authAlerted = false;
      log('success', 'AUTH', 'Вход выполнен. Продолжаю с контрольной точки.');
      this.setState(WState.RUNNING, 'Возобновление после входа');
      return;
    }

    log('error', 'AUTH', 'Автоматический вход не удался. Жду оператора (панель / VNC).');
    void tgNotify('🔐 <b>SEM</b>: не удалось войти автоматически. Требуется помощь оператора.');
    this.setState(WState.AUTH_REQUIRED, 'Ожидаю вход оператором');

    const deadline = Date.now() + 120 * 60000;
    const s = getAllSettings();
    while (Date.now() < deadline && this.running && !this.stopRequested) {
      await sleep(8000);
      if (simulated) {
        log('success', 'AUTH', '(Демо) Оператор «вошёл». Возобновляю работу.');
        this.setState(WState.RUNNING, 'Возобновление после входа');
        return;
      }
      const page = await getPage().catch(() => null);
      if (!page) continue;
      const cls = await classifyPage(page).catch(() => ({ kind: 'UNEXPECTED' as const, reason: '' }));
      if (cls.kind === 'NORMAL') {
        log('success', 'AUTH', 'Обнаружен успешный вход. Возобновляю работу.');
        this.setState(WState.RUNNING, 'Возобновление после входа');
        return;
      }
      void s;
    }
    if (this.running && !this.stopRequested) {
      await this.safeStop('Вход не выполнен за 120 минут ожидания.');
    }
  }

  private async simLogin(): Promise<boolean> {
    log('info', 'AUTH', '(Демо) Ввожу логин и пароль…');
    await sleep(2200);
    log('info', 'AUTH', '(Демо) Отправляю форму входа…');
    await sleep(1500);
    return true;
  }

  private async tryLogin(quiet = false): Promise<boolean> {
    const s = getAllSettings();
    try {
      const page = await getPage();
      await page.goto(s.siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);
      const userLoc = page
        .locator(
          'input[type=email]:visible, input[name*=user i], input[name*=login i], input[type=text]:visible'
        )
        .first();
      const passLoc = page.locator('input[type=password]:visible').first();
      if ((await userLoc.count()) === 0 || (await passLoc.count()) === 0) {
        if (!quiet) log('warn', 'AUTH', 'Форма входа не найдена на странице');
        return false;
      }
      await userLoc.fill(s.username);
      await passLoc.fill(s.password);
      const submit = page
        .locator(
          'button[type=submit], input[type=submit], button:has-text("Войти"), button:has-text("Log in"), button:has-text("Sign in")'
        )
        .first();
      await submit.click();
      await sleep(3500);
      const cls = await classifyPage(page);
      return cls.kind !== 'AUTH';
    } catch (e) {
      if (!quiet) log('error', 'AUTH', `Ошибка входа: ${String(e).slice(0, 120)}`);
      return false;
    }
  }

  private async manualReview(reason: string): Promise<void> {
    log('warn', 'SYSTEM', `Ручное вмешательство: ${reason}`);
    await screenshot('manual-review');
    void tgNotify(`🟠 <b>SEM</b>: требуется внимание оператора.\n${reason}`);
    this.setState(WState.MANUAL_REVIEW, reason.slice(0, 120));

    const s = getAllSettings();
    const simulate = s.mode === 'simulation';
    const deadline = Date.now() + 120 * 60000;
    const page = simulate ? null : await getPage().catch(() => null);
    const classify = this.classifierFor(simulate, page);
    while (Date.now() < deadline && this.running && !this.stopRequested) {
      await sleep(simulate ? 4000 : 10000);
      const cls = await classify().catch(() => ({ kind: 'UNEXPECTED' as const, reason: '' }));
      if (cls.kind === 'NORMAL') {
        log('success', 'SYSTEM', 'Проблема устранена. Перепроверяю и продолжаю работу.');
        await this.revalidate(classify);
        this.setState(WState.RUNNING, 'Возобновление работы');
        return;
      }
    }
    if (this.running && !this.stopRequested) {
      await this.safeStop('Ручная проверка не завершена за отведённое время.');
    }
  }

  private async safeStop(reason: string): Promise<void> {
    log('error', 'SYSTEM', `SAFE_STOP: ${reason}`);
    void tgNotify(`⏸ <b>SEM</b>: безопасная остановка.\n${reason}\nЧекпоинт сохранён — запуск возобновит работу.`);
    this.running = false;
    this.stopRequested = true;
    this.setState(WState.MANUAL_REVIEW, reason.slice(0, 140));
  }

  async shutdown(): Promise<void> {
    this.stop();
    await closeBrowser();
  }
}
