/**
 * God LLM output Zod schemas.
 * Simplified: 4 task types (explore/code/debug/discuss), no phases.
 */

import { z } from 'zod';

export const TaskTypeSchema = z.enum(['explore', 'code', 'debug', 'discuss']);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const DispatchTypeSchema = z.enum(['explore', 'code', 'debug', 'discuss']);
export type DispatchType = z.infer<typeof DispatchTypeSchema>;

export const GodTaskAnalysisSchema = z.object({
  taskType: TaskTypeSchema,
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

export type GodTaskAnalysis = z.infer<typeof GodTaskAnalysisSchema>;
