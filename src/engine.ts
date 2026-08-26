import type { Page } from 'playwright';
import { WState, STATE_META } from './states.js';
import { getAllSettings, getSetting } from './settings.js';
import { classifyPage, type Classification } from './classifier.js';
import { getPage, closeBrowser, screenshot, backupSession } from './browser.js';
import { TZ } from './config.js';
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
import { createDemoDriver, LiveHttpDriver, parseSteps, StepsDriver, AiLoopDriver, SelectorBrokenError } from './workflow.js';
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
  private sessionBackupTimer: NodeJS.Timeout | null = null;
  private authAlerted = false;
  private pausedBySchedule = false;

  private hourNow(): number {
    try {
      return Number(
        new Intl.DateTimeFormat('en-GB', {
          hour: '2-digit',
          hour12: false,
          timeZone: TZ,
        }).format(new Date())
      );
    } catch {
      return new Date().getHours();
    }
  }

  private checkSchedule(): void {
    const s = getAllSettings();
    const inside = (() => {
      if (!s.scheduleEnabled) return true;
      const from = Number(s.scheduleFrom) || 0;
      const to = Number(s.scheduleTo) || 24;
      const h = this.hourNow();
      return from <= to ? h >= from && h < to : h >= from || h < to;
    })();

    if (!inside && this.running && !this.paused) {
      this.paused = true;
      this.pausedBySchedule = true;
      log(
        'info',
        'CONTROL',
        `Внерабочее время (сейчас ${this.hourNow()} ч) — автопауза. Браузер закрывается для экономии ресурсов.`
      );
      this.setState(WState.WAITING, 'Внерабочее время — автопауза');
      void closeBrowser();
    } else if (inside && this.paused && this.pausedBySchedule) {
      this.pausedBySchedule = false;
      this.paused = false;
      log('info', 'CONTROL', 'Рабочее время наступило — автоматическое возобновление работы.');
      this.setState(WState.RUNNING, 'Работа');
    }
  }

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
    const s = getAllSettings();
    if (!simulation && s.mode === 'ai') return new AiLoopDriver();
    if (!simulation && parseSteps().length > 0) return new StepsDriver();
    return simulation ? createDemoDriver(this.demoSeqRestored) : new LiveHttpDriver();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stopRequested = false;
    this.paused = false;
    this.startedAt = Date.now();
    const s = getAllSettings();
    const simulation = s.mode === 'simulation';
    const aiMode = s.mode === 'ai';

    if (!simulation && aiMode) {
      if (!String(s.aiApiKey || '')) {
        this.setState(WState.ERROR, 'Не задан API-ключ модели (Настройки → Доступ к модели)');
        log('error', 'CONTROL', 'Запуск невозможен: нет API-ключа модели');
        return;
      }
      if (!String(s.aiInstruction || '').trim()) {
        this.setState(WState.ERROR, 'Задайте постоянную инструкцию для ИИ-агента');
        log('error', 'CONTROL', 'Запуск невозможен: пустая инструкция ИИ-агента');
        return;
      }
    } else if (!simulation && !s.siteUrl) {
      this.setState(WState.ERROR, 'Не задан адрес сайта в настройках');
      log('error', 'CONTROL', 'Запуск невозможен: не указан адрес сайта');
      return;
    }
    if (!simulation && !aiMode && !(s.username && s.password)) {
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
        await backupSession();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.setState(WState.ERROR, `Браузер не запустился: ${msg.slice(0, 100)}`);
        log('error', 'SYSTEM', `Браузер не запустился: ${msg}`);
        return;
      }
    }

    this.running = true;
    this.setState(WState.RUNNING, 'Работа');
    if (!this.sessionBackupTimer) {
      this.sessionBackupTimer = setInterval(() => {
        void backupSession();
      }, 10 * 60000);
      this.sessionBackupTimer.unref?.();
    }
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
    this.pausedBySchedule = false;
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
      async shot(name: string) {
        return screenshot(name);
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
        this.checkSchedule();
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
      await page.evaluate(
        `fetch(location.href,{method:'HEAD',cache:'no-store'}).catch(()=>{})`
      );
      await page.mouse.move(200 + Math.random() * 300, 150 + Math.random() * 200);
      await page.mouse.wheel(0, 60 + Math.random() * 80);
      await page.mouse.wheel(0, -(60 + Math.random() * 80));
      log('info', 'SYSTEM', 'Поддержание активности сессии (HTTP-пинг без перезагрузки)');
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
      await backupSession();
      log('success', 'AUTH', 'Вход выполнен. Сессия сохранена (backup). Продолжаю с контрольной точки.');
      this.setState(WState.RUNNING, 'Возобновление после входа');
      return;
    }

    let waitHint = 'Жду оператора (панель / VNC).';
    try {
      const pg = await getPage();
      const otpish = await pg.evaluate(
        `(() => {
          const el = [...document.querySelectorAll('input')].find((x) =>
            x.offsetParent &&
            /one-time-code|sms|code|код/i.test((x.name || '') + (x.id || '') + (x.placeholder || ''))
          );
          const txt = document.body.innerText.slice(0, 2500);
          return !!(el || /введите код|код из sms|смс-код/i.test(txt));
        })()`
      );
      if (otpish) {
        waitHint = 'Похоже, нужен код из SMS — введите его через VNC, бот сам продолжит.';
      }
    } catch {
      /* page unavailable */
    }

    log('error', 'AUTH', `Автоматический вход не удался. ${waitHint}`);
    void tgNotify(`🔐 <b>SEM</b>: автоматический вход не удался. ${waitHint}`);
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
        log('success', 'AUTH', 'Обнаружен успешный вход. Сессия сохраняется. Возобновляю работу.');
        await backupSession();
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

  private async robustFill(
    page: Page,
    loc: import('playwright').Locator,
    value: string
  ): Promise<void> {
    await loc.click({ timeout: 4000 }).catch(() => {});
    await loc.fill(value, { timeout: 4000 }).catch(async () => {
      await loc.pressSequentially(value, { delay: 40 }).catch(() => {});
    });
    const v = await loc.inputValue().catch(() => '');
    if (v !== value) {
      await loc.click().catch(() => {});
      await loc.pressSequentially(value, { delay: 40 }).catch(() => {});
    }
  }

  private async tryLogin(quiet = false): Promise<boolean> {
    const s = getAllSettings();
    let custom: { user?: string[]; password?: string[]; submit?: string[] } = {};
    try {
      if (s.loginSelectorsJson.trim()) custom = JSON.parse(s.loginSelectorsJson);
    } catch {
      /* ignore bad json */
    }
    const userCands = [
      ...(custom.user ?? []),
      'input[type=email]:visible',
      '#hub-identifier',
      'input[name*=user i]',
      'input[name*=login i]',
      'input[name*=mail i]',
      'input[type=text]:visible',
    ];
    const passCands = [...(custom.password ?? []), 'input[type=password]:visible'];
    const submitCands = [
      ...(custom.submit ?? []),
      'button[type=submit]',
      '.partner-auth-submit',
      'input[type=submit]',
      'button:has-text("Войти")',
      'button:has-text("Log in")',
      'button:has-text("Sign in")',
    ];

    const firstVisible = async (cands: string[]) => {
      for (const c of cands) {
        try {
          const l = page0.locator(c).first();
          if ((await l.count()) > 0 && (await l.isVisible())) return l;
        } catch {
          /* next */
        }
      }
      return null;
    };

    let page0!: Page;
    try {
      page0 = await getPage();
      await page0.goto(s.siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
      const userLoc = await firstVisible(userCands);
      const passLoc = await firstVisible(passCands);
      if (!userLoc || !passLoc) {
        if (!quiet) log('warn', 'AUTH', 'Форма входа не найдена на странице');
        return false;
      }
      await this.robustFill(page0, userLoc, s.username);
      await this.robustFill(page0, passLoc, s.password);
      let submit = await firstVisible(submitCands);
      if (!submit) submit = passLoc;
      await submit.click({ timeout: 5000 }).catch(async () => {
        await passLoc.press('Enter').catch(() => {});
      });
      await sleep(4000);
      const cls = await classifyPage(page0);
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
