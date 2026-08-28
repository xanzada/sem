export enum WState {
  STOPPED = 'STOPPED',
  RUNNING = 'RUNNING',
  WAITING = 'WAITING',
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  ERROR = 'ERROR',
}

export const STATE_META: Record<WState, { ru: string; emoji: string; color: string }> = {
  [WState.STOPPED]: { ru: 'Остановлен', emoji: '⏸', color: '#6b7280' },
  [WState.RUNNING]: { ru: 'Наблюдает', emoji: '👁', color: '#22c55e' },
  [WState.WAITING]: { ru: 'Пауза по графику', emoji: '🟡', color: '#eab308' },
  [WState.AUTH_REQUIRED]: { ru: 'Требуется вход на сайт', emoji: '🔐', color: '#f59e0b' },
  [WState.ERROR]: { ru: 'Ошибка', emoji: '🔴', color: '#ef4444' },
};
