import type { Page } from 'playwright';
import { WState, STATE_META } from './states.js';
import { getAllSettings } from './settings.js';
import { getPage, closeBrowser, screenshot } from './browser.js';
import { TZ, VERSION, NOVNC_PUBLIC_URL } from './config.js';
import { log } from './logger.js';
import { bus } from './bus.js';
import { tgNotify } from './telegram.js';
import { recordCatch, countToday } from './analytics.js';
import { activeRule, markRuleResult, type Rule } from './rules.js';
import { ensureWatcher, stopWatcher, takeHits } from './watcher.js';
import { sleep, nowIso } from './util.js';

export interface Snapshot {
  state: string;
  stateRu: string;
  emoji: string;
  since: string;
  step: string;
  running: boolean;
  uptimeSec: number;
  caughtToday: number;
  /** Белсенді ереже туралы қысқа мәлімет. */
  ruleName: string;
  ruleWatch: string;
  /** Күзетші бетті қанша рет тексерді. */
  scans: number;
  /** Бақыланатын беттің адресі. */
  watchUrl: string;
  vncUrl: string;
  version: string;
}

/**
 * Күзет қозғалтқышы.
 *
 * Негізгі принцип: шешім де, клик те бет ішінде жасалады (src/watcher.ts).
 * Node тек үш нәрсеге жауапты:
 *   1) күзетші тірі ме — жоқ болса қайта енгізу (навигациядан кейін);
 *   2) сессия үзілмеуі үшін тінтуірді қозғау — бет ЖАҢАРТЫЛМАЙДЫ;
 *   3) нәтижелерді журнал мен статистикаға жазу.
 *
 * Бет ешқашан reload/goto жасалмайды: сайт wizard-пен жүреді, қайта жүктеу
 * барлық толтырылған қадамды нөлге қайтарады. Операторды бет ашық қалдырады.
 */
export class Engine {
  state: WState = WState.STOPPED;
  since = nowIso();
  step = '';
  running = false;

  private startedAt = Date.now();
  private stopRequested = false;
  private rule: Rule | null = null;
  private scans = 0;
  private watchUrl = '';
  private lastMouseMove = 0;
  private pausedBySchedule = false;
  private loopHandle: Promise<void> | null = null;

  snapshot(): Snapshot {
    const meta = STATE_META[this.state];
    return {
      state: this.state as string,
      stateRu: meta.ru,
      emoji: meta.emoji,
      since: this.since,
      step: this.step,
      running: this.running,
      uptimeSec: this.running ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      caughtToday: countToday(),
      ruleName: this.rule?.name ?? '',
      ruleWatch: this.rule?.watchText ?? '',
      scans: this.scans,
      watchUrl: this.watchUrl,
      vncUrl: NOVNC_PUBLIC_URL,
      version: VERSION,
    };
  }

  /** Ереже өзгерсе күзетшіні жаңа ережемен қайта енгізу керек. */
  applySettings(): void {
    const fresh = activeRule();
    const changed = JSON.stringify(fresh) !== JSON.stringify(this.rule);
    this.rule = fresh;
    if (this.running && changed) {
      log('info', 'CONTROL', 'Правило изменилось — обновляю наблюдателя без перезагрузки страницы');
      void this.reinstall();
    }
    bus.emit('status', this.snapshot());
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.rule = activeRule();
    if (!this.rule) {
      this.setState(WState.ERROR, 'Правило не выучено');
      log('error', 'CONTROL', 'Запуск невозможен: сначала обучите робота (кнопка «Обучить»)');
      return;
    }

    let page: Page;
    try {
      page = await getPage();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setState(WState.ERROR, `Браузер недоступен: ${msg.slice(0, 90)}`);
      log('error', 'SYSTEM', `Браузер не запустился: ${msg}`);
      return;
    }

    const url = page.url();
    if (!url || url === 'about:blank') {
      this.setState(WState.ERROR, 'Страница не открыта');
      log(
        'error',
        'CONTROL',
        'Запуск невозможен: откройте нужную страницу во вкладке «Экран» и доведите её до состояния ожидания'
      );
      return;
    }

    this.stopRequested = false;
    this.running = true;
    this.startedAt = Date.now();
    this.scans = 0;
    this.watchUrl = url;
    this.lastMouseMove = Date.now();

    const s = getAllSettings();
    const inst = await ensureWatcher(page, this.rule, s.scanIntervalMs, s.confirmDelayMs);
    if (!inst.alive) {
      this.running = false;
      this.setState(WState.ERROR, 'Наблюдатель не встал на страницу');
      log('error', 'SYSTEM', `Не удалось внедрить наблюдателя: ${inst.error ?? 'неизвестная ошибка'}`);
      return;
    }
    log(
      'success',
      'CONTROL',
      `👁 Наблюдение началось: жду «${this.rule.watchText}», проверка каждые ${s.scanIntervalMs} мс. Страница не перезагружается.`
    );
    this.setState(WState.RUNNING, `Жду «${this.rule.watchText}»`);
    this.loopHandle = this.loop();
  }

  stop(): void {
    if (!this.running) {
      this.setState(WState.STOPPED, '');
      return;
    }
    this.stopRequested = true;
    this.running = false;
    void getPage()
      .then((p) => stopWatcher(p))
      .catch(() => {});
    log('info', 'CONTROL', '⏹ Наблюдение остановлено оператором. Страница осталась как есть.');
    this.setState(WState.STOPPED, '');
  }

  private async reinstall(): Promise<void> {
    if (!this.rule) return;
    const s = getAllSettings();
    try {
      const page = await getPage();
      await ensureWatcher(page, this.rule, s.scanIntervalMs, s.confirmDelayMs);
    } catch {
      /* келесі циклде қайталанады */
    }
  }

  private hourNow(): number {
    try {
      return Number(
        new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ }).format(
          new Date()
        )
      );
    } catch {
      return new Date().getHours();
    }
  }

  private insideSchedule(): boolean {
    const s = getAllSettings();
    if (!s.scheduleEnabled) return true;
    const from = Number(s.scheduleFrom) || 0;
    const to = Number(s.scheduleTo) || 24;
    const h = this.hourNow();
    return from <= to ? h >= from && h < to : h >= from || h < to;
  }

  /**
   * Сессияны тірі ұстау: тінтуірді сәл қозғау және бетке фокус беру.
   * Ешқандай reload, goto немесе форма жіберу жоқ — тек «мен осындамын» сигналы.
   */
  private async nudge(page: Page): Promise<void> {
    try {
      const x = 120 + Math.random() * 500;
      const y = 120 + Math.random() * 350;
      await page.mouse.move(x, y, { steps: 3 });
      /* Скролл кейін орнына қайтарылады: күзетші көретін аймақ өзгермеуі керек. */
      const d = 20 + Math.random() * 40;
      await page.mouse.wheel(0, d);
      await sleep(120);
      await page.mouse.wheel(0, -d);
      this.lastMouseMove = Date.now();
    } catch {
      /* бет жабылып қалса келесі циклде көрінеді */
    }
  }

  private async loop(): Promise<void> {
    let missingWatcher = 0;

    while (this.running && !this.stopRequested) {
      try {
        /* График: жұмыс уақытынан тыс тек бақылауды тоқтатамыз, браузерді
         * жаппаймыз — оператордың ашып қойған беті жоғалмауы керек. */
        if (!this.insideSchedule()) {
          if (!this.pausedBySchedule) {
            this.pausedBySchedule = true;
            const page = await getPage().catch(() => null);
            if (page) await stopWatcher(page);
            log('info', 'CONTROL', `Внерабочее время (${this.hourNow()} ч) — наблюдение на паузе, страница сохранена`);
            this.setState(WState.WAITING, 'Внерабочее время');
          }
          await sleep(20000);
          continue;
        }
        if (this.pausedBySchedule) {
          this.pausedBySchedule = false;
          await this.reinstall();
          log('info', 'CONTROL', 'Рабочее время началось — наблюдение возобновлено');
          this.setState(WState.RUNNING, `Жду «${this.rule?.watchText ?? ''}»`);
        }

        const page = await getPage();
        const s = getAllSettings();

        /* Күзетші тірі ме. Бет ішінде ajax-навигация болса қайта енеді. */
        const inst = await ensureWatcher(page, this.rule!, s.scanIntervalMs, s.confirmDelayMs);
        if (inst.installed) {
          missingWatcher += 1;
          /* Қайта енгізу қалыпты (бет өзгерді), бірақ ол әрдайым сәтсіз болса —
           * күзет мүлдем жұмыс істемей тұр, мұны жасыруға болмайды. */
          if (!inst.alive) {
            if (missingWatcher <= 3 || missingWatcher % 25 === 0) {
              log('error', 'SYSTEM', `Наблюдатель не встаёт: ${inst.error ?? 'ошибка внедрения'}`);
            }
          } else if (missingWatcher <= 2 || missingWatcher % 50 === 0) {
            log('info', 'SYSTEM', 'Наблюдатель переустановлен (страница изменилась)');
          }
        }

        const url = page.url();
        if (url !== this.watchUrl) {
          this.watchUrl = url;
          log('warn', 'SYSTEM', `Адрес страницы изменился: ${url.slice(0, 120)}`);
        }

        const report = await takeHits(page);
        if (report) {
          this.scans = report.scans;
          for (const h of report.hits) {
            await this.onHit(h);
          }
        }

        if (Date.now() - this.lastMouseMove > s.mouseMoveSec * 1000) {
          await this.nudge(page);
        }

        /* Node тарапындағы цикл жиілігі реакцияға әсер етпейді: клик бет ішінде
         * жасалады, бұл жерде тек есеп жиналады. */
        await sleep(400);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log('error', 'SYSTEM', `Сбой наблюдения: ${msg.slice(0, 160)}`);
        this.setState(WState.ERROR, msg.slice(0, 120));
        await sleep(5000);
        if (this.running && !this.stopRequested) {
          this.setState(WState.RUNNING, `Жду «${this.rule?.watchText ?? ''}»`);
        }
      }
    }
  }

  private async onHit(h: {
    found: string;
    clicked: string;
    reactionMs: number;
    confirmed: boolean;
    confirmNotes: string[];
    totalMs: number;
  }): Promise<void> {
    const ruleId = this.rule?.id;
    recordCatch({
      label: h.found || 'слот',
      ok: h.confirmed,
      totalMs: h.totalMs,
      reactionMs: h.reactionMs,
      ruleId,
    });
    if (ruleId) markRuleResult(ruleId, h.confirmed);

    const detail = h.confirmNotes.length ? ` · ${h.confirmNotes.join(' → ')}` : '';
    if (h.confirmed) {
      log(
        'success',
        'WORKFLOW',
        `✅ Поймано за ${h.reactionMs} мс: «${h.found}» → нажато «${h.clicked}»${detail} (всего ${h.totalMs} мс)`
      );
      void tgNotify(`✅ <b>SEM</b>: поймал слот за ${h.reactionMs} мс\n${h.found}`);
    } else {
      log(
        'warn',
        'WORKFLOW',
        `⚠️ Клик выполнен за ${h.reactionMs} мс, но подтверждение не завершилось: «${h.found}»${detail}`
      );
      void tgNotify(`⚠️ <b>SEM</b>: клик был, подтверждение не прошло.\n${h.found}${detail}`);
    }
    await screenshot(h.confirmed ? 'catch-ok' : 'catch-partial');
    bus.emit('status', this.snapshot());
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
      if (s === WState.ERROR) {
        void tgNotify(`${STATE_META[s].emoji} <b>SEM</b>: ${STATE_META[s].ru}\n${this.step}`);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stop();
    await closeBrowser();
  }
}
