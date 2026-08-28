import { getPage } from './browser.js';
import { getAllSettings } from './settings.js';
import { log } from './logger.js';
import { bus } from './bus.js';
import { runAgentSession, AgentAborted, type AiAction } from './gemini.js';
import { screenshot } from './browser.js';
import { recordApplication } from './analytics.js';
import { beginIntent, confirmIntent } from './ledger.js';
import { saveCheckpoint } from './checkpoint.js';

export interface AgentRunState {
  running: boolean;
  task: string;
  step: number;
  lastAction: string;
  startedAt: string;
}

let current: AgentRunState = {
  running: false,
  task: '',
  step: 0,
  lastAction: '',
  startedAt: '',
};

/** Оператор «СТОП» басты ма. Ұзақ HTTP сұраныс ішінде де тексеріледі. */
let abortRequested = false;

export function agentState(): AgentRunState {
  return current;
}

/** Ағымдағы проходты тоқтату. Агент жүрмесе де ештеңе бүлдірмейді. */
export function stopAiTask(): { ok: boolean; wasRunning: boolean } {
  const wasRunning = current.running;
  abortRequested = true;
  if (wasRunning) {
    log('info', 'CONTROL', '⏹ Агенту дана команда остановиться');
    current = { ...current, lastAction: '⏹ Останавливаюсь…' };
    bus.emit('agent', current);
  } else {
    /* «Агент работает» деп қатып қалған күйді де тазалаймыз. */
    current = { ...current, running: false };
    bus.emit('agent', current);
  }
  return { ok: true, wasRunning };
}

const ACT_RU: Record<string, string> = {
  click: '🖱 Клик',
  fill: '⌨️ Заполнение поля',
  select: '📋 Выбор из списка',
  check: '☑️ Отметка',
  type: '⌨️ Ввод текста',
  key: '⌨️ Клавиша',
  scroll: '↕ Прокрутка',
  wait: '⏳ Ожидание',
  goto: '🌐 Переход',
  back: '↩ Назад',
  done: '✅ Задача выполнена',
  fail: '⚠️ Не получилось',
};

function describeAction(a: AiAction): string {
  const base = ACT_RU[a.act] ?? a.act;
  const target = a.ref ? ` [${a.ref}]` : a.act === 'click' && a.x != null ? ` (${a.x}, ${a.y})` : '';
  const extra = a.text ? ` «${a.text.slice(0, 30)}»` : '';
  return `${base}${target}${extra}${a.why ? ' — ' + a.why : ''}`;
}

/** Разовый запуск ИИ-агента с текстовой командой. */
export async function runAiTask(task: string, maxSteps = 25): Promise<{
  ok: boolean;
  done?: boolean;
  steps?: number;
  reason?: string;
  aborted?: boolean;
}> {
  const s = getAllSettings();
  if (!s.aiApiKey) return { ok: false, reason: 'Не задан API-ключ модели (Настройки → Доступ к модели)' };
  if (!task.trim()) return { ok: false, reason: 'Пустая команда' };
  if (current.running) return { ok: false, reason: 'Агент уже работает' };

  abortRequested = false;
  current = {
    running: true,
    task,
    step: 0,
    lastAction: '',
    startedAt: new Date().toISOString(),
  };
  bus.emit('agent', current);
  log('info', 'CONTROL', `🤖 ИИ-агент получил команду: ${task.slice(0, 120)}`);

  try {
    const page = await getPage();
    if (s.siteUrl && (page.url() === 'about:blank' || page.url().startsWith('chrome'))) {
      await page.goto(s.siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
    const res = await runAgentSession({
      page,
      key: String(s.aiApiKey),
      model: String(s.aiModel || 'gemini-flash-latest'),
      baseUrl: String(s.aiBaseUrl || ''),
      task,
      maxSteps,
      actionDelayMs: Number(s.actionDelayMs) || 800,
      speed: Number(s.speed) || 1,
      shouldContinue: () => !abortRequested,
      onAction: async (a, step) => {
        current = { ...current, step, lastAction: describeAction(a) };
        bus.emit('agent', current);
        log(
          a.act === 'fail' ? 'warn' : 'info',
          'WORKFLOW',
          `Шаг ${step}: ${describeAction(a)}`
        );
        if (a.act === 'click') {
          const shot = await screenshot(`ai-step-${step}`);
          if (shot) {
            saveCheckpoint({
              appId: null,
              step: `ai-${step}`,
              nextAction: a.act,
              url: page.url(),
              lastStatus: a.why ?? '',
            });
          }
        }
      },
    });

    if (res.done) {
      const id = beginIntent(`ai-${Date.now()}`, 'ai-task');
      confirmIntent(id);
      recordApplication({
        appId: `ai-${new Date().toISOString().slice(11, 19)}`,
        action: 'ai-task',
        result: 'done',
        durationMs: Date.now() - new Date(current.startedAt).getTime(),
      });
      log('success', 'WORKFLOW', `✅ Задача выполнена за ${res.steps} шаг(ов): ${res.lastWhy}`);
    } else {
      log('warn', 'WORKFLOW', `⚠️ Задача не завершена (${res.steps} шаг.): ${res.lastWhy}`);
    }
    await screenshot('ai-final');
    return { ok: true, done: res.done, steps: res.steps, reason: res.lastWhy };
  } catch (e) {
    if (e instanceof AgentAborted) {
      log('info', 'CONTROL', '⏹ Агент остановлен оператором');
      return { ok: true, done: false, aborted: true, reason: 'Остановлено оператором' };
    }
    const msg = e instanceof Error ? e.message : String(e);
    log('error', 'WORKFLOW', `ИИ-агент: ошибка — ${msg.slice(0, 180)}`);
    await screenshot('ai-error');
    return { ok: false, reason: msg.slice(0, 200) };
  } finally {
    abortRequested = false;
    current = { ...current, running: false };
    bus.emit('agent', current);
  }
}
