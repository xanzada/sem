import { Engine } from './engine.js';
import { buildServer } from './server.js';
import { log } from './logger.js';
import { getSetting } from './settings.js';
import { PORT } from './config.js';

const engine = new Engine();
await buildServer(engine);
log('info', 'SYSTEM', `SEM панель запущена на порту ${PORT}`);

if (getSetting('autostart')) {
  void engine.start();
}

let shuttingDown = false;
const shutdown = (sig: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'SYSTEM', `Завершение работы (${sig}): состояние и сессия сохраняются…`);
  void engine.shutdown();
  setTimeout(() => process.exit(0), 800);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => {
  log('error', 'SYSTEM', `Необработанная ошибка: ${String(e).slice(0, 160)}`);
});
