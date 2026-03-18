/**
 * ReclassifyOverlay — pure state logic for runtime task reclassification overlay.
 * Card F.2: FR-002a (AC-010, AC-011, AC-012)
 *
 * Ctrl+R triggers a full-screen overlay allowing the user to change the task type
 * mid-session. Pure functions — no framework dependency.
 */

import type { TaskType } from './task-analysis-card.js';
import { appendAuditLog, type GodAuditEntry } from '../god/god-audit.js';

/** Task types available for reclassification (excludes compound). */
const RECLASSIFY_TYPES: TaskType[] = ['explore', 'code', 'review', 'debug'];

/** XState states where Ctrl+R is allowed (AC-010). */
export const RECLASSIFY_ALLOWED_STATES: string[] = [
  'CODING',
  'REVIEWING',
  'GOD_DECIDING',
  'PAUSED',
];

export interface ReclassifyOverlayState {
  visible: boolean;
  currentType: TaskType;
  selectedType: TaskType;
  availableTypes: TaskType[];
}

/**
 * Check whether the current workflow state allows reclassification.
 */
export function canTriggerReclassify(workflowState: string): boolean {
  return RECLASSIFY_ALLOWED_STATES.includes(workflowState);
}

/**
 * Create initial overlay state when Ctrl+R is pressed.
 */
export function createReclassifyState(
  currentType: TaskType,
): ReclassifyOverlayState {
  return {
    visible: true,
    currentType,
    selectedType: RECLASSIFY_TYPES.includes(currentType) ? currentType : RECLASSIFY_TYPES[0],
    availableTypes: [...RECLASSIFY_TYPES],
  };
}

/**
 * Handle a key press within the reclassify overlay.
 * Returns updated state and optional action ('confirm' | 'cancel').
 */
export function handleReclassifyKey(
  state: ReclassifyOverlayState,
  key: string,
): { state: ReclassifyOverlayState; action?: 'confirm' | 'cancel' } {
  const { availableTypes, selectedType, currentType } = state;

  // Number keys 1-N: direct select + confirm
  const num = parseInt(key, 10);
  if (num >= 1 && num <= availableTypes.length) {
    return {
      state: { ...state, selectedType: availableTypes[num - 1], visible: false },
      action: 'confirm',
    };
  }

  // Arrow keys: move selection
  if (key === 'arrow_down' || key === 'arrow_up') {
    const currentIndex = availableTypes.indexOf(selectedType);
    const delta = key === 'arrow_down' ? 1 : -1;
    const nextIndex = (currentIndex + delta + availableTypes.length) % availableTypes.length;
    return {
      state: { ...state, selectedType: availableTypes[nextIndex] },
    };
  }

  // Enter: confirm current selection
  if (key === 'enter') {
    return {
      state: { ...state, visible: false },
      action: 'confirm',
    };
  }

  // Escape: cancel — restore to currentType
  if (key === 'escape') {
    return {
      state: { ...state, selectedType: currentType, visible: false },
      action: 'cancel',
    };
  }

  // Unknown key: no-op
  return { state };
}

/**
 * Write a reclassify event to the audit log.
 * Called when the user confirms a reclassification (action='confirm').
 */
export function writeReclassifyAudit(
  sessionDir: string,
  opts: { seq: number; fromType: TaskType; toType: TaskType },
): void {
  const entry: GodAuditEntry = {
    seq: opts.seq,
    timestamp: new Date().toISOString(),
    decisionType: 'RECLASSIFY',
    inputSummary: `User reclassified task from "${opts.fromType}" to "${opts.toType}"`,
    outputSummary: `Task type changed: ${opts.fromType} → ${opts.toType}`,
    decision: { fromType: opts.fromType, toType: opts.toType },
  };
  appendAuditLog(sessionDir, entry);
}
