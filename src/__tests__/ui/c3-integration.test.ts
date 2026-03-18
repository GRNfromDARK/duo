/**
 * Integration tests for Card C.3: Reclassify Overlay (Ctrl+R) + Phase Transition
 * FR-002a (AC-010, AC-011, AC-012), FR-010 (AC-033, AC-034)
 */

import { describe, it, expect } from 'vitest';
import type { Key } from 'ink';
import { processKeybinding, type KeyContext, KEYBINDING_LIST } from '../../ui/keybindings.js';
import { canTriggerReclassify, RECLASSIFY_ALLOWED_STATES } from '../../ui/reclassify-overlay.js';

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  };
}

const defaultCtx: KeyContext = {
  overlayOpen: null,
  inputEmpty: true,
  pageSize: 20,
};

// ── AC-1: Ctrl+R triggers reclassify action ──

describe('AC-1: Ctrl+R in CODING/REVIEWING/GOD_DECIDING/PAUSED', () => {
  it('Ctrl+R produces reclassify action', () => {
    const action = processKeybinding('r', key({ ctrl: true }), defaultCtx);
    expect(action.type).toBe('reclassify');
  });

  it('Ctrl+R is listed in KEYBINDING_LIST', () => {
    const entry = KEYBINDING_LIST.find(e => e.shortcut === 'Ctrl+R');
    expect(entry).toBeDefined();
    expect(entry!.description).toContain('Reclassify');
  });

  it('canTriggerReclassify allows CODING', () => {
    expect(canTriggerReclassify('CODING')).toBe(true);
  });

  it('canTriggerReclassify allows REVIEWING', () => {
    expect(canTriggerReclassify('REVIEWING')).toBe(true);
  });

  it('canTriggerReclassify allows GOD_DECIDING', () => {
    expect(canTriggerReclassify('GOD_DECIDING')).toBe(true);
  });

  it('canTriggerReclassify allows PAUSED', () => {
    expect(canTriggerReclassify('PAUSED')).toBe(true);
  });

  it('canTriggerReclassify rejects IDLE', () => {
    expect(canTriggerReclassify('IDLE')).toBe(false);
  });

  it('canTriggerReclassify rejects DONE', () => {
    expect(canTriggerReclassify('DONE')).toBe(false);
  });

  it('RECLASSIFY_ALLOWED_STATES matches AC-010 spec', () => {
    expect(RECLASSIFY_ALLOWED_STATES).toEqual([
      'CODING',
      'REVIEWING',
      'GOD_DECIDING',
      'PAUSED',
    ]);
  });
});

// AC-4/AC-5 phase transition tests removed — tested evaluatePhaseTransition
// from the now-deleted phase-transition.ts module.
