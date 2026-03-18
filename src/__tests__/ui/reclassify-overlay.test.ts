/**
 * Tests for ReclassifyOverlay state logic.
 * Card F.2: ReclassifyOverlay 运行中重分类 (FR-002a)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createReclassifyState,
  handleReclassifyKey,
  RECLASSIFY_ALLOWED_STATES,
  canTriggerReclassify,
  writeReclassifyAudit,
} from '../../ui/reclassify-overlay.js';
import type { ReclassifyOverlayState } from '../../ui/reclassify-overlay.js';

describe('createReclassifyState', () => {
  it('should create state with visible=true and correct defaults', () => {
    const state = createReclassifyState('code');

    expect(state.visible).toBe(true);
    expect(state.currentType).toBe('code');
    expect(state.selectedType).toBe('code');
    expect(state.availableTypes).toContain('explore');
    expect(state.availableTypes).toContain('code');
    expect(state.availableTypes).toContain('review');
    expect(state.availableTypes).toContain('debug');
  });

  it('should not include compound in available types', () => {
    const state = createReclassifyState('code');
    expect(state.availableTypes).not.toContain('compound');
  });

  it('should set selectedType to current type', () => {
    const state = createReclassifyState('debug');
    expect(state.selectedType).toBe('debug');
  });
});

describe('canTriggerReclassify — AC-1: Ctrl+R in CODING/REVIEWING/GOD_DECIDING/PAUSED', () => {
  it('should allow in CODING state', () => {
    expect(canTriggerReclassify('CODING')).toBe(true);
  });

  it('should allow in REVIEWING state', () => {
    expect(canTriggerReclassify('REVIEWING')).toBe(true);
  });

  it('should allow in GOD_DECIDING state', () => {
    expect(canTriggerReclassify('GOD_DECIDING')).toBe(true);
  });

  it('should allow in PAUSED state', () => {
    expect(canTriggerReclassify('PAUSED')).toBe(true);
  });

  it('should not allow in IDLE state', () => {
    expect(canTriggerReclassify('IDLE')).toBe(false);
  });

  it('should not allow in DONE state', () => {
    expect(canTriggerReclassify('DONE')).toBe(false);
  });

  it('should not allow in ERROR state', () => {
    expect(canTriggerReclassify('ERROR')).toBe(false);
  });

  it('should export RECLASSIFY_ALLOWED_STATES with correct values', () => {
    expect(RECLASSIFY_ALLOWED_STATES).toEqual([
      'CODING',
      'REVIEWING',
      'GOD_DECIDING',
      'PAUSED',
    ]);
  });
});

describe('handleReclassifyKey — arrow keys', () => {
  it('should move selection down with arrow_down', () => {
    const state = createReclassifyState('code');
    const codeIndex = state.availableTypes.indexOf('code');
    const { state: next } = handleReclassifyKey(state, 'arrow_down');

    expect(next.selectedType).toBe(state.availableTypes[codeIndex + 1]);
  });

  it('should move selection up with arrow_up', () => {
    const state = createReclassifyState('code');
    const { state: moved } = handleReclassifyKey(state, 'arrow_down');
    const { state: next } = handleReclassifyKey(moved, 'arrow_up');

    expect(next.selectedType).toBe('code');
  });

  it('should wrap around at bottom', () => {
    const state = createReclassifyState('debug');
    // debug is last in the reclassify list
    const { state: next } = handleReclassifyKey(state, 'arrow_down');

    expect(next.selectedType).toBe(state.availableTypes[0]);
  });

  it('should wrap around at top', () => {
    const state = createReclassifyState('explore');
    // explore is first
    const { state: next } = handleReclassifyKey(state, 'arrow_up');

    expect(next.selectedType).toBe(state.availableTypes[state.availableTypes.length - 1]);
  });

  it('should not produce an action on arrow keys', () => {
    const state = createReclassifyState('code');
    const { action } = handleReclassifyKey(state, 'arrow_down');

    expect(action).toBeUndefined();
  });
});

describe('handleReclassifyKey — number keys', () => {
  it('should select type by number key 1', () => {
    const state = createReclassifyState('code');
    const { state: next, action } = handleReclassifyKey(state, '1');

    expect(next.selectedType).toBe(state.availableTypes[0]);
    expect(action).toBe('confirm');
  });

  it('should select type by number key 4', () => {
    const state = createReclassifyState('code');
    const { state: next, action } = handleReclassifyKey(state, '4');

    expect(next.selectedType).toBe(state.availableTypes[3]);
    expect(action).toBe('confirm');
  });

  it('should ignore number keys beyond available types', () => {
    const state = createReclassifyState('code');
    const { state: next, action } = handleReclassifyKey(state, '9');

    expect(next.selectedType).toBe(state.selectedType);
    expect(action).toBeUndefined();
  });
});

describe('handleReclassifyKey — enter (confirm)', () => {
  it('should confirm current selection and return confirm action', () => {
    const state = createReclassifyState('code');
    // Move to a different type first
    const { state: moved } = handleReclassifyKey(state, 'arrow_down');
    const { state: next, action } = handleReclassifyKey(moved, 'enter');

    expect(action).toBe('confirm');
    expect(next.visible).toBe(false);
  });

  it('should confirm with same type (no change)', () => {
    const state = createReclassifyState('code');
    const { action } = handleReclassifyKey(state, 'enter');

    expect(action).toBe('confirm');
  });
});

describe('handleReclassifyKey — escape (cancel) — AC: 取消恢复原状', () => {
  it('should cancel and return cancel action', () => {
    const state = createReclassifyState('code');
    const { state: next, action } = handleReclassifyKey(state, 'escape');

    expect(action).toBe('cancel');
    expect(next.visible).toBe(false);
  });

  it('should restore original type on cancel after selection change', () => {
    const state = createReclassifyState('code');
    const { state: moved } = handleReclassifyKey(state, 'arrow_down');
    expect(moved.selectedType).not.toBe('code');

    const { state: next, action } = handleReclassifyKey(moved, 'escape');

    expect(action).toBe('cancel');
    expect(next.selectedType).toBe('code'); // restored to currentType
  });
});

describe('handleReclassifyKey — unknown keys', () => {
  it('should ignore unknown keys', () => {
    const state = createReclassifyState('code');
    const { state: next, action } = handleReclassifyKey(state, 'x');

    expect(next).toEqual(state);
    expect(action).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// BUG-13 (P2): discuss/compound types have no highlighted selection
// ══════════════════════════════════════════════════════════════

describe('BUG-13: createReclassifyState with discuss/compound types', () => {
  it('should fallback selectedType to first available when currentType is discuss', () => {
    const state = createReclassifyState('discuss' as any);

    // selectedType should NOT be 'discuss' since it's not in availableTypes
    expect(state.availableTypes).not.toContain('discuss');
    expect(state.selectedType).toBe(state.availableTypes[0]);
    expect(state.selectedType).toBe('explore');
  });

  it('should fallback selectedType to first available when currentType is compound', () => {
    const state = createReclassifyState('compound' as any);

    expect(state.availableTypes).not.toContain('compound');
    expect(state.selectedType).toBe(state.availableTypes[0]);
    expect(state.selectedType).toBe('explore');
  });

  it('should still set selectedType to currentType when it is in availableTypes', () => {
    const state = createReclassifyState('debug');

    expect(state.selectedType).toBe('debug');
  });

  it('should not confirm a no-op reclassify when discuss enters and presses Enter', () => {
    const state = createReclassifyState('discuss' as any);
    const { state: next, action } = handleReclassifyKey(state, 'enter');

    expect(action).toBe('confirm');
    // selectedType should be 'explore' (first available), NOT 'discuss'
    expect(next.selectedType).toBe('explore');
    expect(next.selectedType).not.toBe('discuss');
  });

  it('arrow_down from discuss-fallback navigates predictably', () => {
    const state = createReclassifyState('discuss' as any);
    // selectedType should be 'explore' (index 0)
    expect(state.selectedType).toBe('explore');

    const { state: next } = handleReclassifyKey(state, 'arrow_down');
    // Should move to index 1 ('code')
    expect(next.selectedType).toBe('code');
  });
});

describe('writeReclassifyAudit — AC-3: 重分类事件写入 audit log', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reclassify-audit-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should write a RECLASSIFY entry to god-audit.jsonl', () => {
    writeReclassifyAudit(tmpDir, {
      seq: 10,
      fromType: 'code',
      toType: 'debug',
    });

    const logPath = join(tmpDir, 'god-audit.jsonl');
    const content = readFileSync(logPath, 'utf-8').trim();
    const entry = JSON.parse(content);

    expect(entry.decisionType).toBe('RECLASSIFY');
    expect(entry.seq).toBe(10);
    expect(entry.decision).toEqual({ fromType: 'code', toType: 'debug' });
    expect(entry.inputSummary).toContain('code');
    expect(entry.inputSummary).toContain('debug');
    expect(entry.timestamp).toBeDefined();
  });

  it('should include fromType and toType in summaries', () => {
    writeReclassifyAudit(tmpDir, {
      seq: 1,
      fromType: 'explore',
      toType: 'review',
    });

    const logPath = join(tmpDir, 'god-audit.jsonl');
    const entry = JSON.parse(readFileSync(logPath, 'utf-8').trim());

    expect(entry.inputSummary).toContain('explore');
    expect(entry.inputSummary).toContain('review');
    expect(entry.outputSummary).toContain('explore');
    expect(entry.outputSummary).toContain('review');
  });

  it('should append multiple reclassify entries', () => {
    writeReclassifyAudit(tmpDir, { seq: 1, fromType: 'code', toType: 'debug' });
    writeReclassifyAudit(tmpDir, { seq: 2, fromType: 'debug', toType: 'review' });

    const logPath = join(tmpDir, 'god-audit.jsonl');
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).decision.toType).toBe('debug');
    expect(JSON.parse(lines[1]).decision.toType).toBe('review');
  });
});
