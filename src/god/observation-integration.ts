/**
 * Observation Integration — GLUE layer connecting the observation classifier
 * to coder/reviewer/interrupt/error output sources.
 * Source: FR-005 (Observation Normalization), FR-006 (Non-Work Outputs Must Not Advance)
 * Card: B.2
 */

import { classifyOutput, createObservation, guardNonWorkOutput } from './observation-classifier.js';
import type { Observation } from '../types/observation.js';

/**
 * Process coder/reviewer output through the observation pipeline.
 * Returns the observation and routing decision.
 *
 * Usage: call this before sending CODE_COMPLETE / REVIEW_COMPLETE.
 * Only send the completion event if `isWork === true`.
 */
export function processWorkerOutput(
  raw: string,
  role: 'coder' | 'reviewer',
  meta: { round: number; phaseId?: string; adapter?: string },
): {
  observation: Observation;
  isWork: boolean;
  shouldRouteToGod: boolean;
} {
  const source = role === 'reviewer' ? 'reviewer' as const : 'coder' as const;
  const observation = classifyOutput(raw, source, meta);
  const guard = guardNonWorkOutput(observation);
  return { observation, ...guard };
}

/**
 * Create an observation for a human interrupt (Ctrl+C).
 */
export function createInterruptObservation(
  round: number,
  opts?: { phaseId?: string },
): Observation {
  return createObservation('human_interrupt', 'human', 'User pressed Ctrl+C', {
    round,
    severity: 'warning',
    phaseId: opts?.phaseId,
  });
}

/**
 * Create an observation for a text interrupt (user typed during LLM execution).
 */
export function createTextInterruptObservation(
  userText: string,
  round: number,
  opts?: { phaseId?: string },
): Observation {
  return createObservation('human_message', 'human', userText, {
    round,
    severity: 'info',
    rawRef: userText,
    phaseId: opts?.phaseId,
  });
}

/**
 * Create an observation for a process error.
 */
export function createProcessErrorObservation(
  errorMessage: string,
  round: number,
  opts?: { phaseId?: string; adapter?: string },
): Observation {
  return createObservation('tool_failure', 'runtime', errorMessage, {
    round,
    severity: 'error',
    rawRef: errorMessage,
    phaseId: opts?.phaseId,
    adapter: opts?.adapter,
  });
}

/**
 * Create an observation for a process timeout.
 */
export function createTimeoutObservation(
  round: number,
  opts?: { phaseId?: string; adapter?: string },
): Observation {
  return createObservation('tool_failure', 'runtime', 'Process timeout', {
    round,
    severity: 'error',
    phaseId: opts?.phaseId,
    adapter: opts?.adapter,
  });
}
