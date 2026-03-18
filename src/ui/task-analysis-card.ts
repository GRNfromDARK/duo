/**
 * TaskAnalysisCard — pure state logic for the task analysis intent echo card.
 * Card F.1: FR-001a (AC-004, AC-005, AC-006, AC-007)
 *
 * This module is framework-agnostic: it exports pure functions that manage
 * state transitions. The TUI component layer consumes these functions.
 */

import type { GodTaskAnalysis } from '../types/god-schemas.js';

export type TaskType = 'explore' | 'code' | 'discuss' | 'review' | 'debug' | 'compound';

/** Ordered list for UI selection. Number keys 1-N map to this order. */
export const TASK_TYPE_LIST: TaskType[] = [
  'explore',
  'code',
  'discuss',
  'review',
  'debug',
  'compound',
];

export interface TaskAnalysisCardState {
  analysis: GodTaskAnalysis;
  selectedType: TaskType;
  countdown: number;       // 8-second countdown
  countdownPaused: boolean;
  confirmed: boolean;
}

const INITIAL_COUNTDOWN = 8;

export function createTaskAnalysisCardState(analysis: GodTaskAnalysis): TaskAnalysisCardState {
  return {
    analysis,
    selectedType: analysis.taskType as TaskType,
    countdown: INITIAL_COUNTDOWN,
    countdownPaused: false,
    confirmed: false,
  };
}

export function handleKeyPress(state: TaskAnalysisCardState, key: string): TaskAnalysisCardState {
  if (state.confirmed) return state;

  // Number keys 1-N: direct select + confirm
  const num = parseInt(key, 10);
  if (num >= 1 && num <= TASK_TYPE_LIST.length) {
    return {
      ...state,
      selectedType: TASK_TYPE_LIST[num - 1],
      confirmed: true,
    };
  }

  // Arrow keys: move selection + pause countdown
  if (key === 'arrow_down' || key === 'arrow_up') {
    const currentIndex = TASK_TYPE_LIST.indexOf(state.selectedType);
    const delta = key === 'arrow_down' ? 1 : -1;
    const nextIndex = (currentIndex + delta + TASK_TYPE_LIST.length) % TASK_TYPE_LIST.length;
    return {
      ...state,
      selectedType: TASK_TYPE_LIST[nextIndex],
      countdownPaused: true,
    };
  }

  // Enter: confirm current selection
  if (key === 'enter') {
    return { ...state, confirmed: true };
  }

  // Space: confirm with recommended type
  if (key === 'space') {
    return {
      ...state,
      selectedType: state.analysis.taskType as TaskType,
      confirmed: true,
    };
  }

  return state;
}

export function tickCountdown(state: TaskAnalysisCardState): TaskAnalysisCardState {
  if (state.confirmed || state.countdownPaused) return state;
  if (state.countdown <= 0) return state;

  const next = state.countdown - 1;
  if (next <= 0) {
    return { ...state, countdown: 0, confirmed: true };
  }
  return { ...state, countdown: next };
}
