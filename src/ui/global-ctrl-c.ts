export const DOUBLE_CTRL_C_THRESHOLD_MS = 500;

export type GlobalCtrlCAction = 'interrupt' | 'safe_exit';

export function resolveGlobalCtrlCAction(
  now: number,
  lastCtrlCAt: number,
  thresholdMs = DOUBLE_CTRL_C_THRESHOLD_MS,
): { action: GlobalCtrlCAction; nextLastCtrlCAt: number } {
  if (lastCtrlCAt > 0 && now - lastCtrlCAt <= thresholdMs) {
    return {
      action: 'safe_exit',
      nextLastCtrlCAt: 0,
    };
  }

  return {
    action: 'interrupt',
    nextLastCtrlCAt: now,
  };
}
