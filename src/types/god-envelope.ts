/**
 * GodDecisionEnvelope — simplified.
 * No authority, no autonomousResolutions, no currentPhaseId.
 */

import { z } from 'zod';
import { GodActionSchema } from './god-actions.js';

// --- Sub-schemas ---

export const DiagnosisSchema = z.object({
  summary: z.string(),
  currentGoal: z.string(),
  notableObservations: z.array(z.string()),
});

export const EnvelopeMessageTargetSchema = z.enum(['coder', 'reviewer', 'user', 'system_log']);

export const EnvelopeMessageSchema = z.object({
  target: EnvelopeMessageTargetSchema,
  content: z.string(),
});

// --- Main Envelope schema (no authority constraints) ---

export const GodDecisionEnvelopeSchema = z.object({
  diagnosis: DiagnosisSchema,
  actions: z.array(GodActionSchema),
  messages: z.array(EnvelopeMessageSchema),
});

// --- Inferred types ---

export type Diagnosis = z.infer<typeof DiagnosisSchema>;
export type EnvelopeMessage = z.infer<typeof EnvelopeMessageSchema>;
export type EnvelopeMessageTarget = z.infer<typeof EnvelopeMessageTargetSchema>;
export type GodDecisionEnvelope = z.infer<typeof GodDecisionEnvelopeSchema>;
