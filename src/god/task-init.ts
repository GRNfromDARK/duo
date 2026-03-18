/**
 * God TASK_INIT service — intent parsing + task classification + dynamic rounds.
 * Source: FR-001 (AC-001, AC-002, AC-003), FR-002 (AC-008, AC-009), FR-007 (AC-023, AC-024)
 * AI-REVIEW: TASK_INIT 作为 God 意图解析入口，动态 rounds 受 taskType 约束避免失控回环 (FR-003 核心循环)。
 */

import type { GodAdapter } from '../types/god-adapter.js';
import type { GodTaskAnalysis } from '../types/god-schemas.js';
import { GodTaskAnalysisSchema } from '../types/god-schemas.js';
import { extractGodJson } from '../parsers/god-json-extractor.js';
import { collectGodAdapterOutput } from './god-call.js';

export interface TaskInitResult {
  analysis: GodTaskAnalysis;
  rawOutput: string;
}

// ── Task type → round range mapping (AC-023) ──

const ROUND_RANGES: Record<string, { min: number; max: number }> = {
  explore: { min: 2, max: 5 },
  code: { min: 3, max: 10 },
  review: { min: 1, max: 3 },
  debug: { min: 2, max: 6 },
  discuss: { min: 2, max: 5 },
  // compound: no fixed range, passes through
};

/**
 * Validate and clamp suggestedMaxRounds to the allowed range for a task type.
 * compound type passes through without clamping.
 */
export function validateRoundsForType(taskType: string, rounds: number): number {
  const range = ROUND_RANGES[taskType];
  if (!range) return rounds; // compound or unknown → pass through
  return Math.max(range.min, Math.min(range.max, rounds));
}

/**
 * Apply dynamic rounds adjustment at runtime.
 * Clamps the suggested value to the task type's allowed range.
 */
export function applyDynamicRounds(
  currentMax: number,
  suggested: number,
  taskType: string,
): number {
  return validateRoundsForType(taskType, suggested);
}

const GOD_TIMEOUT_MS = 600_000;

function buildTaskInitPrompt(taskPrompt: string): string {
  return [
    '## Decision Point: TASK_INIT',
    'Classify the task below for orchestration planning.',
    'Do not answer or solve the task itself.',
    '',
    '## User Task',
    taskPrompt,
    '',
    'Return only the TASK_INIT JSON described in the system instructions.',
    'For non-compound tasks, omit "phases" or set it to null.',
  ].join('\n');
}

/**
 * Initialize a task via the God adapter: send the task prompt with system prompt,
 * extract and validate the GodTaskAnalysis JSON from the output.
 *
 * Uses extractWithRetry: on schema validation failure, retries once with error hint.
 * Returns null if extraction/validation ultimately fails (caller decides fallback).
 */
export async function initializeTask(
  godAdapter: GodAdapter,
  taskPrompt: string,
  systemPrompt: string,
  projectDir?: string,
  sessionDir?: string,
  model?: string,
): Promise<TaskInitResult | null> {
  const prompt = buildTaskInitPrompt(taskPrompt);
  const rawOutput = await collectGodAdapterOutput({
    adapter: godAdapter,
    prompt,
    systemPrompt,
    projectDir,
    timeoutMs: GOD_TIMEOUT_MS,
    model,
    ...(sessionDir
      ? {
          logging: {
            sessionDir,
            round: 0,
            kind: 'god_task_init',
            meta: { attempt: 1 },
          },
        }
      : {}),
  });

  // Single extraction attempt — no internal retry.
  // Outer withRetry (Watchdog-powered) handles retries if needed.
  const result = extractGodJson(rawOutput, GodTaskAnalysisSchema);

  if (!result || !result.success) {
    return null;
  }

  return {
    analysis: result.data,
    rawOutput,
  };
}
