/**
 * Hand / GodAction catalog for Sovereign God Runtime.
 * Source: FR-007 (Structured Hand Catalog), FR-008 (NL Message Channel), FR-017 (Accept Must Carry Rationale)
 * Card: A.1
 */

import { z } from 'zod';

// --- Individual action schemas ---

export const SendToCoderSchema = z.object({
  type: z.literal('send_to_coder'),
  message: z.string(),
});

export const SendToReviewerSchema = z.object({
  type: z.literal('send_to_reviewer'),
  message: z.string(),
});

export const StopRoleSchema = z.object({
  type: z.literal('stop_role'),
  role: z.enum(['coder', 'reviewer']),
  reason: z.string(),
});

export const RetryRoleSchema = z.object({
  type: z.literal('retry_role'),
  role: z.enum(['coder', 'reviewer']),
  hint: z.string().optional(),
});

export const SwitchAdapterSchema = z.object({
  type: z.literal('switch_adapter'),
  role: z.enum(['coder', 'reviewer', 'god']),
  adapter: z.string(),
  reason: z.string(),
});

export const SetPhaseSchema = z.object({
  type: z.literal('set_phase'),
  phaseId: z.string(),
  summary: z.string().optional(),
});

export const AcceptTaskSchema = z.object({
  type: z.literal('accept_task'),
  rationale: z.enum(['reviewer_aligned', 'god_override', 'forced_stop']),
  summary: z.string(),
});

export const WaitSchema = z.object({
  type: z.literal('wait'),
  reason: z.string(),
  estimatedSeconds: z.number().optional(),
});

export const RequestUserInputSchema = z.object({
  type: z.literal('request_user_input'),
  question: z.string(),
});

export const ResumeAfterInterruptSchema = z.object({
  type: z.literal('resume_after_interrupt'),
  resumeStrategy: z.enum(['continue', 'redirect', 'stop']),
});

export const EmitSummarySchema = z.object({
  type: z.literal('emit_summary'),
  content: z.string(),
});

// --- Discriminated union ---

export const GodActionSchema = z.discriminatedUnion('type', [
  SendToCoderSchema,
  SendToReviewerSchema,
  StopRoleSchema,
  RetryRoleSchema,
  SwitchAdapterSchema,
  SetPhaseSchema,
  AcceptTaskSchema,
  WaitSchema,
  RequestUserInputSchema,
  ResumeAfterInterruptSchema,
  EmitSummarySchema,
]);

// --- Inferred types ---

export type SendToCoder = z.infer<typeof SendToCoderSchema>;
export type SendToReviewer = z.infer<typeof SendToReviewerSchema>;
export type StopRole = z.infer<typeof StopRoleSchema>;
export type RetryRole = z.infer<typeof RetryRoleSchema>;
export type SwitchAdapter = z.infer<typeof SwitchAdapterSchema>;
export type SetPhase = z.infer<typeof SetPhaseSchema>;
export type AcceptTask = z.infer<typeof AcceptTaskSchema>;
export type Wait = z.infer<typeof WaitSchema>;
export type RequestUserInput = z.infer<typeof RequestUserInputSchema>;
export type ResumeAfterInterrupt = z.infer<typeof ResumeAfterInterruptSchema>;
export type EmitSummary = z.infer<typeof EmitSummarySchema>;

export type GodAction = z.infer<typeof GodActionSchema>;
