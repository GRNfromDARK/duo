/**
 * God TASK_INIT service — intent parsing + task classification.
 * Source: FR-001 (AC-001, AC-002, AC-003), FR-002 (AC-008, AC-009)
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
