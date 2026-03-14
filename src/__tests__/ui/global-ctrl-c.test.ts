import { describe, expect, it } from 'vitest';
import { DOUBLE_CTRL_C_THRESHOLD_MS, resolveGlobalCtrlCAction } from '../../ui/global-ctrl-c.js';

describe('resolveGlobalCtrlCAction', () => {
  it('treats the first Ctrl+C as an interrupt request', () => {
    expect(resolveGlobalCtrlCAction(1_000, 0)).toEqual({
      action: 'interrupt',
      nextLastCtrlCAt: 1_000,
    });
  });

  it('treats a second Ctrl+C within the threshold as safe_exit', () => {
    expect(resolveGlobalCtrlCAction(1_000 + DOUBLE_CTRL_C_THRESHOLD_MS, 1_000)).toEqual({
      action: 'safe_exit',
      nextLastCtrlCAt: 0,
    });
  });

  it('treats a late second Ctrl+C as a fresh interrupt sequence', () => {
    expect(resolveGlobalCtrlCAction(1_000 + DOUBLE_CTRL_C_THRESHOLD_MS + 1, 1_000)).toEqual({
      action: 'interrupt',
      nextLastCtrlCAt: 1_000 + DOUBLE_CTRL_C_THRESHOLD_MS + 1,
    });
  });
});
