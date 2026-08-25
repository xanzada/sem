export enum WState {
  STOPPED = 'STOPPED',
  STARTING = 'STARTING',
  RUNNING = 'RUNNING',
  WAITING = 'WAITING',
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  SECURITY_VERIFICATION_WAIT = 'SECURITY_VERIFICATION_WAIT',
  MANUAL_REVIEW = 'MANUAL_REVIEW',
  ERROR = 'ERROR',
}

export const STATE_META: Record<WState, { ru: string; emoji: string; color: string }> = {
  [WState.STOPPED]: { ru: 'Остановлен', emoji: '⏸', color: '#6b7280' },
  [WState.STARTING]: { ru: 'Запуск', emoji: '🔄', color: '#38bdf8' },
  [WState.RUNNING]: { ru: 'Работает', emoji: '🟢', color: '#22c55e' },
  [WState.WAITING]: { ru: 'Пауза', emoji: '🟡', color: '#eab308' },
  [WState.AUTH_REQUIRED]: { ru: 'Требуется вход на сайт', emoji: '🔐', color: '#f59e0b' },
  [WState.SECURITY_VERIFICATION_WAIT]: {
    ru: 'Ожидание проверки безопасности',
    emoji: '🛡',
    color: '#38bdf8',
  },
  [WState.MANUAL_REVIEW]: { ru: 'Требуется внимание оператора', emoji: '🟠', color: '#f97316' },
  [WState.ERROR]: { ru: 'Ошибка', emoji: '🔴', color: '#ef4444' },
};
