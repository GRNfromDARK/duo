/**
 * God LLM output Zod schemas.
 * Source: AR-002, OQ-002, OQ-003
 * SPEC-DECISION: Schema field names follow Card A.1 spec (refined from FR-001/004/005/008).
 * AI-REVIEW: GodDecisionEnvelope 结构对齐 FR-004 (AC-011~013)，action 与 message 分离确保状态变化仅通过 Hand 执行。
 */

import { z } from 'zod';

// 6 种任务类型
export const TaskTypeSchema = z.enum(['explore', 'code', 'discuss', 'review', 'debug', 'compound']);

// GodTaskAnalysis — FR-001 意图解析输出
export const GodTaskAnalysisSchema = z.object({
  taskType: TaskTypeSchema,
  reasoning: z.string(),
  phases: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: TaskTypeSchema,
    description: z.string(),
  })).nullable().optional(), // compound 类型必须有 phases; non-compound may omit or use null
  confidence: z.number().min(0).max(1),
  suggestedMaxRounds: z.number().int().min(1).max(20),
  terminationCriteria: z.array(z.string()),
}).refine(
  (data) => data.taskType !== 'compound' || (data.phases && data.phases.length > 0),
  { message: 'phases must be non-empty when taskType is compound' },
);

// GodPostCoderDecision — FR-004 Coder 输出后路由
export const GodPostCoderDecisionSchema = z.object({
  action: z.enum(['continue_to_review', 'retry_coder']),
  reasoning: z.string(),
  retryHint: z.string().optional(), // retry_coder 时提供
});

// GodPostReviewerDecision — FR-004 Reviewer 输出后路由
export const GodPostReviewerDecisionSchema = z.object({
  action: z.enum(['route_to_coder', 'converged', 'phase_transition', 'loop_detected']),
  reasoning: z.string(),
  unresolvedIssues: z.array(z.string()).optional(), // route_to_coder 必须非空
  confidenceScore: z.number().min(0).max(1),
  progressTrend: z.enum(['improving', 'stagnant', 'declining']),
  nextPhaseId: z.string().optional(), // phase_transition 时指定目标阶段
}).refine(
  (data) => data.action !== 'route_to_coder' || (data.unresolvedIssues && data.unresolvedIssues.length > 0),
  { message: 'unresolvedIssues must be non-empty when action is route_to_coder' },
);

// GodConvergenceJudgment — FR-005 收敛判断
export const GodConvergenceJudgmentSchema = z.object({
  classification: z.enum(['approved', 'changes_requested', 'needs_discussion']),
  shouldTerminate: z.boolean(),
  reason: z.string().nullable(),
  blockingIssueCount: z.number().int().min(0),
  criteriaProgress: z.array(z.object({
    criterion: z.string(),
    satisfied: z.boolean(),
  })),
  reviewerVerdict: z.string(),
});

// GodAutoDecision — FR-008 GOD_DECIDING 自主决策
/** Max reasoning length to prevent UI overflow in escape window preview */
export const MAX_REASONING_LENGTH = 2000;

export const GodAutoDecisionSchema = z.object({
  action: z.enum(['accept', 'continue_with_instruction']),
  reasoning: z.string().max(MAX_REASONING_LENGTH),
  instruction: z.string().optional(), // continue_with_instruction 时提供
});

export type GodTaskAnalysis = z.infer<typeof GodTaskAnalysisSchema>;
export type GodPostCoderDecision = z.infer<typeof GodPostCoderDecisionSchema>;
export type GodPostReviewerDecision = z.infer<typeof GodPostReviewerDecisionSchema>;
export type GodConvergenceJudgment = z.infer<typeof GodConvergenceJudgmentSchema>;
export type GodAutoDecision = z.infer<typeof GodAutoDecisionSchema>;
