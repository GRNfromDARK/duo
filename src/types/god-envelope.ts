/**
 * GodDecisionEnvelope + Authority types for Sovereign God Runtime.
 * Source: FR-001 (Sovereign God Authority), FR-002 (Authority Override Must Be Explicit),
 *         FR-004 (God Decision Envelope), FR-016 (State Changes Must Be Action-Backed)
 * Card: A.2
 *
 * This single Envelope replaces the 5 legacy schemas (GodTaskAnalysis /
 * GodPostCoderDecision / GodPostReviewerDecision / GodConvergenceJudgment /
 * GodAutoDecision). Those schemas are retained as deprecated in god-schemas.ts.
 */

import { z } from 'zod';
import { GodActionSchema } from './god-actions.js';

// --- Sub-schemas ---

export const DiagnosisSchema = z.object({
  summary: z.string(),
  currentGoal: z.string(),
  currentPhaseId: z.string(),
  notableObservations: z.array(z.string()),
});

export const AuthoritySchema = z.object({
  userConfirmation: z.enum(['human', 'god_override', 'not_required']),
  reviewerOverride: z.boolean(),
  acceptAuthority: z.enum(['reviewer_aligned', 'god_override', 'forced_stop']),
});

export const EnvelopeMessageTargetSchema = z.enum(['coder', 'reviewer', 'user', 'system_log']);

export const EnvelopeMessageSchema = z.object({
  target: EnvelopeMessageTargetSchema,
  content: z.string(),
});

// --- Main Envelope schema with authority semantic constraints ---

export const GodDecisionEnvelopeSchema = z.object({
  diagnosis: DiagnosisSchema,
  authority: AuthoritySchema,
  actions: z.array(GodActionSchema),
  messages: z.array(EnvelopeMessageSchema),
}).superRefine((data, ctx) => {
  const hasSystemLog = data.messages.some(m => m.target === 'system_log');
  const hasUserMessage = data.messages.some(m => m.target === 'user');

  // When reviewerOverride = true, messages must contain a system_log entry
  if (data.authority.reviewerOverride && !hasSystemLog) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'When reviewerOverride is true, messages must contain a target: "system_log" entry with override reason',
      path: ['authority', 'reviewerOverride'],
    });
  }

  // When acceptAuthority = 'god_override', messages must contain a system_log entry
  if (data.authority.acceptAuthority === 'god_override' && !hasSystemLog) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'When acceptAuthority is "god_override", messages must contain a target: "system_log" entry with override reason',
      path: ['authority', 'acceptAuthority'],
    });
  }

  // BUG-18 fix: When userConfirmation = 'god_override', messages must contain a system_log entry
  if (data.authority.userConfirmation === 'god_override' && !hasSystemLog) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'When userConfirmation is "god_override", messages must contain a target: "system_log" entry with override reason',
      path: ['authority', 'userConfirmation'],
    });
  }

  // When acceptAuthority = 'forced_stop', messages must contain a user-targeted summary
  if (data.authority.acceptAuthority === 'forced_stop' && !hasUserMessage) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'When acceptAuthority is "forced_stop", messages must contain a target: "user" summary message',
      path: ['authority', 'acceptAuthority'],
    });
  }
});

// --- Inferred types ---

export type Diagnosis = z.infer<typeof DiagnosisSchema>;
export type Authority = z.infer<typeof AuthoritySchema>;
export type EnvelopeMessage = z.infer<typeof EnvelopeMessageSchema>;
export type EnvelopeMessageTarget = z.infer<typeof EnvelopeMessageTargetSchema>;
export type GodDecisionEnvelope = z.infer<typeof GodDecisionEnvelopeSchema>;
