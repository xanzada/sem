import type { Page } from 'playwright';

export interface AiAction {
  act: 'click' | 'type' | 'key' | 'scroll' | 'goto' | 'back' | 'done' | 'fail';
  x?: number;
  y?: number;
  dy?: number;
  text?: string;
  key?: string;
  url?: string;
  why?: string;
}

const SYS = (task: string, w: number, h: number, url: string, history: string[]) => [
  'Ты — агент, управляющий браузером по скриншоту. Экран ' + w + 'x' + h + ' пикселей.',
  'Текущий адрес: ' + url,
  'ЗАДАЧА: ' + task,
  history.length ? 'Уже сделано: ' + history.slice(-8).join(' | ') : 'Действий ещё не было.',
  '',
  'Верни ОДИН JSON-объект со следующим действием:',
  '{"act":"click","x":число,"y":число,"why":"кратко"} — клик мышью в точку (реальные пиксели скриншота)',
  '{"act":"type","text":"...","why":"..."} — напечатать текст в активное поле (сначала отдельно кликни по полю)',
  '{"act":"key","key":"Enter","why":"..."} — нажать клавишу (Enter/Tab/Esc)',
  '{"act":"scroll","dy":число,"why":"..."} — прокрутить (dy>0 вниз)',
  '{"act":"goto","url":"https://...","why":"..."} — открыть адрес',
  '{"act":"back","why":"..."} — вернуться назад',
  '{"act":"done","why":"..."} — задача полностью выполнена',
  '{"act":"fail","why":"..."} — выполнить невозможно (объясни причину)',
  '',
  'Правила: координаты бери точно по скриншоту. Один ответ = один шаг.',
  'Если задача уже выполнена — done. Если на экране нет пути к цели — scroll или done с объяснением.',
].join('\n');

export async function geminiDecide(opts: {
  key: string;
  model: string;
  task: string;
  history: string[];
  shotJpeg: Buffer;
  width: number;
  height: number;
  url: string;
}): Promise<AiAction> {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: SYS(opts.task, opts.width, opts.height, opts.url, opts.history) },
          { inline_data: { mime_type: 'image/jpeg', data: opts.shotJpeg.toString('base64') } },
        ],
      },
    ],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 300 },
  };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${encodeURIComponent(opts.key)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    }
  );
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`Gemini API ${r.status}: ${errText.slice(0, 140)}`);
  }
  const j = (await r.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const raw = j.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed: Partial<AiAction>;
  try {
    parsed = JSON.parse(cleaned) as Partial<AiAction>;
  } catch {
    throw new Error(`Gemini вернул не JSON: ${cleaned.slice(0, 120)}`);
  }
  const act = (parsed.act ?? 'fail') as AiAction['act'];
  return {
    act,
    x: Number(parsed.x ?? 0),
    y: Number(parsed.y ?? 0),
    dy: Number(parsed.dy ?? 300),
    text: parsed.text ? String(parsed.text).slice(0, 200) : undefined,
    key: parsed.key ? String(parsed.key).slice(0, 20) : undefined,
    url: parsed.url ? String(parsed.url).slice(0, 300) : undefined,
    why: parsed.why ? String(parsed.why).slice(0, 160) : undefined,
  };
}

export interface AgentSessionResult {
  steps: number;
  done: boolean;
  lastWhy: string;
}

/** Один проход ИИ-агента по задаче: скриншот → решение → действие → повтор. */
export async function runAgentSession(opts: {
  page: Page;
  key: string;
  model: string;
  task: string;
  maxSteps?: number;
  onAction?: (a: AiAction, step: number) => Promise<void> | void;
}): Promise<AgentSessionResult> {
  const page = opts.page;
  const maxSteps = opts.maxSteps ?? 25;
  const history: string[] = [];
  let lastWhy = '';

  for (let step = 1; step <= maxSteps; step++) {
    const shot = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 15000 });
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    const action = await geminiDecide({
      key: opts.key,
      model: opts.model,
      task: opts.task,
      history,
      shotJpeg: shot,
      width: vp.width,
      height: vp.height,
      url: page.url(),
    });
    lastWhy = action.why ?? action.act;
    history.push(`${action.act}(${lastWhy.slice(0, 60)})`);
    await (opts.onAction?.(action, step) ?? Promise.resolve());

    switch (action.act) {
      case 'click': {
        if (!action.x || !action.y) throw new Error('ИИ не дал координаты для клика');
        await page.mouse.click(action.x, action.y);
        await page.waitForTimeout(900);
        break;
      }
      case 'type': {
        await page.keyboard.type(action.text ?? '', { delay: 35 });
        await page.waitForTimeout(300);
        break;
      }
      case 'key': {
        await page.keyboard.press((action.key ?? 'Enter').replace(/^Key/i, ''));
        await page.waitForTimeout(500);
        break;
      }
      case 'scroll': {
        await page.mouse.wheel(0, action.dy ?? 400);
        await page.waitForTimeout(400);
        break;
      }
      case 'goto': {
        if (action.url) await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(800);
        break;
      }
      case 'back': {
        await page.goBack().catch(() => {});
        await page.waitForTimeout(700);
        break;
      }
      case 'done':
        return { steps: step, done: true, lastWhy };
      case 'fail':
        return { steps: step, done: false, lastWhy };
    }
  }
  return { steps: maxSteps, done: false, lastWhy: 'Достигнут лимит шагов' };
}
