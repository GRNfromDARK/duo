/**
 * Observation type system for Sovereign God Runtime.
 * Source: FR-005 (Observation Normalization)
 * Card: A.1
 */

import { z } from 'zod';

/** All 13 observation types. */
export const OBSERVATION_TYPES = [
  'work_output',
  'review_output',
  'quota_exhausted',
  'auth_failed',
  'adapter_unavailable',
  'empty_output',
  'meta_output',
  'tool_failure',
  'human_interrupt',
  'human_message',
  'clarification_answer',
  'phase_progress_signal',
  'runtime_invariant_violation',
] as const;

export const ObservationTypeSchema = z.enum(OBSERVATION_TYPES);
export type ObservationType = z.infer<typeof ObservationTypeSchema>;

export const ObservationSourceSchema = z.enum(['coder', 'reviewer', 'god', 'human', 'runtime']);
export type ObservationSource = z.infer<typeof ObservationSourceSchema>;

export const ObservationSeveritySchema = z.enum(['info', 'warning', 'error', 'fatal']);
export type ObservationSeverity = z.infer<typeof ObservationSeveritySchema>;

export const ObservationSchema = z.object({
  source: ObservationSourceSchema,
  type: ObservationTypeSchema,
  summary: z.string(),
  rawRef: z.string().optional(),
  severity: ObservationSeveritySchema.default('error'),
  timestamp: z.string(),
  phaseId: z.string().nullable().optional(),
  adapter: z.string().optional(),
});

export type Observation = z.infer<typeof ObservationSchema>;

/**
 * Type guard: only `work_output` and `review_output` are work observations.
 * All other types (quota_exhausted, empty_output, etc.) return false.
 */
export function isWorkObservation(obs: Observation): boolean {
  return obs.type === 'work_output' || obs.type === 'review_output';
}
