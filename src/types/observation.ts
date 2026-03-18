/**
 * Observation type system — simplified.
 * Classifier removed; only types produced by the runtime remain.
 */

import { z } from 'zod';

export const OBSERVATION_TYPES = [
  'work_output',
  'review_output',
  'human_message',
  'human_interrupt',
  'runtime_error',
  'phase_progress_signal',
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
  severity: ObservationSeveritySchema.default('info'),
  timestamp: z.string(),
  adapter: z.string().optional(),
});

export type Observation = z.infer<typeof ObservationSchema>;

export function isWorkObservation(obs: Observation): boolean {
  return obs.type === 'work_output' || obs.type === 'review_output';
}
