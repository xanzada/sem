# sem-work жобалық нұсқаулық

## Мақсат
SEM — сайттағы өтініштерді өңдеуші worker + веб-панель (RU, dark, mobile-first).

## Стек
Node 22 + TypeScript (ESM, NodeNext), Fastify, better-sqlite3, Playwright 1.49, ws.
Frontend: vanilla JS/CSS (public/), Chart.js CDN.

## Командалар
- `npm run typecheck` — tsc --noEmit (міндетті, commit алдында)
- `npm run build && npm start` — dist арқылы іске қосу
- Smoke: `HEADLESS=true PORT=8099 SEM_DATA_DIR=./tmp-data node dist/index.js` → curl `/api/status`, `/healthz`

## Ережелер
- Пароль/telegram token чатқа, git-ке, log-қа кірмейді. UI `__SAVED__` placeholder қолданады.
- Security challenge ешқашан обход жасалмайды: тек WAIT → DETECT → REVALIDATE → RESUME.
- Critical әрекет алдынынан ledger intent жазылады; resume кезінде reconcile міндетті (duplicate protection).
- Reload тек UNEXPECTED recovery-де ғана; SECURITY_WAIT ішінде reload/pagination жоқ.
- Жаңа driver қосу үшін WorkflowDriver interface-ін ұстану (src/types.ts).

## Белгісіздер / кезектегі жұмыстар
- Нақты сайттың селекторлары мен login эвристикасы — тапсырыс берушінің скриншоттары келгенше generic.
- noVNC сыртқы домен/авторизация (NOVNC_PUBLIC_URL) — deploy кезінде шешіледі.
