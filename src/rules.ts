import { db } from './db.js';
import { nowIso } from './util.js';

/**
 * Үйренген ереже: «нені күту керек» және «нені басу керек».
 *
 * Ереже бір рет ИИ арқылы жазылады, содан кейін бет ішінде орындалады —
 * әрбір қабылдауда модельге сұраныс жіберілмейді. Себебі бір decide() шақыруы
 * 3–8 секунд алады, ал бос орын секундтың бөлігінде жоғалады.
 */
export interface RuleStep {
  /** Басылатын элементтің мәтіні (ішінара сәйкестік, регистрге тәуелсіз). */
  text?: string;
  /** Немесе тікелей CSS-селектор. */
  selector?: string;
  /** Осы қадамға дейін күту, мс (әдепкі 0 — бірден). */
  waitMs?: number;
  /** Элемент пайда болуын күтудің шегі, мс. */
  timeoutMs?: number;
  /** Міндетті емес қадам: болмаса өткізіп жібереді (мыс. кейде шығатын модаль). */
  optional?: boolean;
}

export interface Rule {
  id: string;
  name: string;
  /** Пайда болуын күтетін мәтін, мыс. «Свободно». */
  watchText: string;
  /** Іздеу аймағы (міндетті емес), мыс. «table tbody» — қалған бетті елемейді. */
  watchScope: string;
  /** Табылған элементке қатысты басылатын нысан. */
  clickText: string;
  clickSelector: string;
  /** self — өзін басу, row — сол жолдан іздеу, document — бүкіл беттен. */
  clickScope: 'self' | 'row' | 'document';
  /** Клик жасалғаннан кейінгі растау тізбегі. */
  confirm: RuleStep[];
  /** Осы ережемен сәтті/сәтсіз аяқталған әрекеттер саны. */
  successCount: number;
  failCount: number;
  /** Ереже белсенді ме (күзет осыны қолданады). */
  active: boolean;
  learnedAt: string;
  learnedUrl: string;
  lastUsedAt: string | null;
}

interface RuleRow {
  id: string;
  name: string;
  watch_text: string;
  watch_scope: string;
  click_text: string;
  click_selector: string;
  click_scope: string;
  confirm_json: string;
  success_count: number;
  fail_count: number;
  active: number;
  learned_at: string;
  learned_url: string;
  last_used_at: string | null;
}

function toRule(r: RuleRow): Rule {
  let confirm: RuleStep[] = [];
  try {
    const p = JSON.parse(r.confirm_json) as unknown;
    if (Array.isArray(p)) confirm = p as RuleStep[];
  } catch {
    /* бүлінген JSON — бос тізбек */
  }
  return {
    id: r.id,
    name: r.name,
    watchText: r.watch_text,
    watchScope: r.watch_scope,
    clickText: r.click_text,
    clickSelector: r.click_selector,
    clickScope: (['self', 'row', 'document'].includes(r.click_scope)
      ? r.click_scope
      : 'row') as Rule['clickScope'],
    confirm,
    successCount: r.success_count,
    failCount: r.fail_count,
    active: r.active === 1,
    learnedAt: r.learned_at,
    learnedUrl: r.learned_url,
    lastUsedAt: r.last_used_at,
  };
}

export function listRules(): Rule[] {
  const rows = db
    .prepare('SELECT * FROM rules ORDER BY active DESC, success_count DESC, learned_at DESC')
    .all() as RuleRow[];
  return rows.map(toRule);
}

/** Күзет қолданатын ереже: белсенді және ең сәтті. */
export function activeRule(): Rule | null {
  const row = db
    .prepare('SELECT * FROM rules WHERE active=1 ORDER BY success_count DESC LIMIT 1')
    .get() as RuleRow | undefined;
  return row ? toRule(row) : null;
}

export function getRule(id: string): Rule | null {
  const row = db.prepare('SELECT * FROM rules WHERE id=?').get(id) as RuleRow | undefined;
  return row ? toRule(row) : null;
}

export function saveRule(r: {
  name: string;
  watchText: string;
  watchScope?: string;
  clickText?: string;
  clickSelector?: string;
  clickScope?: Rule['clickScope'];
  confirm?: RuleStep[];
  learnedUrl?: string;
  activate?: boolean;
}): Rule {
  const id = `r${Date.now().toString(36)}`;
  db.prepare(
    `INSERT INTO rules(id,name,watch_text,watch_scope,click_text,click_selector,click_scope,
       confirm_json,success_count,fail_count,active,learned_at,learned_url,last_used_at)
     VALUES(?,?,?,?,?,?,?,?,0,0,?,?,?,NULL)`
  ).run(
    id,
    r.name.slice(0, 120),
    r.watchText.slice(0, 200),
    (r.watchScope ?? '').slice(0, 200),
    (r.clickText ?? '').slice(0, 200),
    (r.clickSelector ?? '').slice(0, 300),
    r.clickScope ?? 'row',
    JSON.stringify(r.confirm ?? []),
    r.activate === false ? 0 : 1,
    nowIso(),
    (r.learnedUrl ?? '').slice(0, 300)
  );
  if (r.activate !== false) activateRule(id);
  return getRule(id)!;
}

/** Бір ғана ереже белсенді болады — екеуі бірге істесе қосарланған клик шығады. */
export function activateRule(id: string): void {
  db.prepare('UPDATE rules SET active=0').run();
  db.prepare('UPDATE rules SET active=1 WHERE id=?').run(id);
}

export function deactivateAll(): void {
  db.prepare('UPDATE rules SET active=0').run();
}

export function deleteRule(id: string): void {
  db.prepare('DELETE FROM rules WHERE id=?').run(id);
}

export function markRuleResult(id: string, ok: boolean): void {
  db.prepare(
    ok
      ? 'UPDATE rules SET success_count=success_count+1, last_used_at=? WHERE id=?'
      : 'UPDATE rules SET fail_count=fail_count+1, last_used_at=? WHERE id=?'
  ).run(nowIso(), id);
}
