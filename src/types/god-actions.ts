/**
 * Hand / GodAction catalog — simplified to 5 actions.
 * send_to_coder, send_to_reviewer, accept_task, wait, request_user_input
 */

import { z } from 'zod';
import { DispatchTypeSchema } from './god-schemas.js';

// --- Individual action schemas ---

export const SendToCoderSchema = z.object({
  type: z.literal('send_to_coder'),
  dispatchType: DispatchTypeSchema,
  message: z.string(),
});

export const SendToReviewerSchema = z.object({
  type: z.literal('send_to_reviewer'),
  message: z.string(),
});

export const AcceptTaskSchema = z.object({
  type: z.literal('accept_task'),
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

// --- Discriminated union ---

export const GodActionSchema = z.discriminatedUnion('type', [
  SendToCoderSchema,
  SendToReviewerSchema,
  AcceptTaskSchema,
  WaitSchema,
  RequestUserInputSchema,
]);

// --- Inferred types ---

export type SendToCoder = z.infer<typeof SendToCoderSchema>;
export type SendToReviewer = z.infer<typeof SendToReviewerSchema>;
export type AcceptTask = z.infer<typeof AcceptTaskSchema>;
export type Wait = z.infer<typeof WaitSchema>;
export type RequestUserInput = z.infer<typeof RequestUserInputSchema>;

export type GodAction = z.infer<typeof GodActionSchema>;
