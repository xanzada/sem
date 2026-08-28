import { getPage } from './browser.js';
import { getAllSettings } from './settings.js';
import { log } from './logger.js';
import { collectDom, renderDom } from './dom.js';
import { askVision } from './gemini.js';
import { saveRule, type Rule, type RuleStep } from './rules.js';

/**
 * Ережені бір рет үйрену.
 *
 * Оператор бетті керек жерге дейін өзі әкеледі және тапсырманы сөзбен жазады
 * («Свободно шықса, сол жолдағы Записаться басып, Подтвердить ет»). Модель бір
 * рет қана шақырылады: беттің суреті мен элементтер тізімін көріп, «нені күту»
 * және «нені басу» ережесін JSON етіп қайтарады. Одан кейін жұмыс бет ішінде
 * жүреді — API-ға сұраныс жіберілмейді.
 */

interface LearnedJson {
  name?: string;
  watchText?: string;
  watchScope?: string;
  clickText?: string;
  clickSelector?: string;
  clickScope?: string;
  confirm?: { text?: string; selector?: string; waitMs?: number; timeoutMs?: number; optional?: boolean }[];
  note?: string;
}

function buildPrompt(task: string, url: string, domText: string): string {
  return [
    'Ты настраиваешь робота-наблюдателя для сайта электронной очереди.',
    'Робот НЕ будет спрашивать тебя снова: он получит одно правило и будет',
    'выполнять его внутри страницы миллисекунды после появления нужного элемента.',
    '',
    `Адрес страницы: ${url}`,
    `ЗАДАЧА ОПЕРАТОРА: ${task}`,
    '',
    'ЭЛЕМЕНТЫ СТРАНИЦЫ СЕЙЧАС (нужного может ещё не быть — он появится позже):',
    domText,
    '',
    'Верни ОДИН JSON-объект:',
    '{',
    '  "name": "короткое имя правила",',
    '  "watchText": "текст, появление которого означает «можно занимать» (например Свободно)",',
    '  "watchScope": "CSS-селектор области поиска или пустая строка для всей страницы",',
    '  "clickText": "текст кнопки, которую надо нажать",',
    '  "clickSelector": "CSS-селектор кнопки, если он надёжен, иначе пустая строка",',
    '  "clickScope": "row | self | document",',
    '  "confirm": [{"text":"Подтвердить","timeoutMs":6000,"optional":false}],',
    '  "note": "одно предложение: что именно будет делать робот"',
    '}',
    '',
    'ПРАВИЛА ЗАПОЛНЕНИЯ:',
    '- watchText должен быть КОРОТКИМ и появляться ТОЛЬКО когда слот реально свободен.',
    '  Не бери слова, которые есть на странице постоянно (иначе робот сработает сразу и зря).',
    '- clickScope="row" — кнопка находится в той же строке/карточке, что и найденный текст.',
    '  Это самый частый случай для списков и таблиц.',
    '- clickScope="self" — сам найденный элемент и есть кнопка.',
    '- clickScope="document" — кнопка в другом месте страницы (модальное окно и т.п.).',
    '- confirm — шаги ПОСЛЕ первого клика: подтверждения, «Далее», «Да».',
    '  Каждый шаг: text ИЛИ selector. optional:true — если окно появляется не всегда.',
    '  Если подтверждать ничего не нужно, верни пустой массив.',
    '- Только JSON, без пояснений вокруг.',
  ].join('\n');
}

function parseLearned(raw: string): LearnedJson {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  const body = start >= 0 ? cleaned.slice(start, cleaned.lastIndexOf('}') + 1) : cleaned;
  return JSON.parse(body) as LearnedJson;
}

function normSteps(raw: LearnedJson['confirm']): RuleStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 8)
    .map((s) => ({
      text: s.text ? String(s.text).slice(0, 120) : undefined,
      selector: s.selector ? String(s.selector).slice(0, 200) : undefined,
      waitMs: Number.isFinite(Number(s.waitMs)) ? Math.min(15000, Math.max(0, Number(s.waitMs))) : 0,
      timeoutMs: Number.isFinite(Number(s.timeoutMs))
        ? Math.min(30000, Math.max(500, Number(s.timeoutMs)))
        : 6000,
      optional: s.optional === true,
    }))
    .filter((s) => s.text || s.selector);
}

export async function learnRule(task: string): Promise<{
  ok: boolean;
  rule?: Rule;
  reason?: string;
  note?: string;
}> {
  const s = getAllSettings();
  if (!s.aiApiKey) return { ok: false, reason: 'Не задан API-ключ модели (Настройки → Доступ к модели)' };
  if (!task.trim()) return { ok: false, reason: 'Опишите задачу словами' };

  const page = await getPage();
  const url = page.url();
  if (!url || url === 'about:blank') {
    return { ok: false, reason: 'Сначала откройте нужную страницу во вкладке «Экран»' };
  }

  log('info', 'CONTROL', `🎓 Учусь правилу: ${task.slice(0, 120)}`);

  const dom = await collectDom(page);
  const shot = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 20000 }).catch(() => undefined);

  let learned: LearnedJson;
  try {
    const raw = await askVision({
      key: String(s.aiApiKey),
      model: String(s.aiModel || 'gemini-flash-latest'),
      baseUrl: String(s.aiBaseUrl || ''),
      prompt: buildPrompt(task, url, renderDom(dom)),
      shotJpeg: shot,
    });
    learned = parseLearned(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('error', 'CONTROL', `Не удалось выучить правило: ${msg.slice(0, 180)}`);
    return { ok: false, reason: msg.slice(0, 200) };
  }

  const watchText = String(learned.watchText ?? '').trim();
  if (!watchText) {
    return { ok: false, reason: 'Модель не смогла определить, чего ждать. Опишите задачу подробнее.' };
  }

  const scope = ['self', 'row', 'document'].includes(String(learned.clickScope))
    ? (String(learned.clickScope) as Rule['clickScope'])
    : 'row';

  const rule = saveRule({
    name: String(learned.name ?? task).slice(0, 120),
    watchText,
    watchScope: String(learned.watchScope ?? '').trim(),
    clickText: String(learned.clickText ?? '').trim(),
    clickSelector: String(learned.clickSelector ?? '').trim(),
    clickScope: scope,
    confirm: normSteps(learned.confirm),
    learnedUrl: url,
    activate: true,
  });

  log(
    'success',
    'CONTROL',
    `🎓 Правило выучено: ждать «${rule.watchText}» → нажать «${rule.clickText || rule.clickSelector || 'элемент в строке'}»`
      + (rule.confirm.length ? `, затем ${rule.confirm.length} шаг(ов) подтверждения` : '')
  );

  return { ok: true, rule, note: learned.note ? String(learned.note).slice(0, 200) : undefined };
}
