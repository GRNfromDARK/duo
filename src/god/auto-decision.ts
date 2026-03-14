/**
 * Auto Decision — GOD_DECIDING 自主决策服务
 * Source: FR-008 (AC-025, AC-026, AC-027)
 *
 * God autonomously decides in GOD_DECIDING:
 * - accept: task complete
 * - continue_with_instruction: inject instruction and continue
 *
 * Decisions are checked against rule engine before execution (AC-025).
 * Reasoning is written to audit log (AC-027).
 * AI-REVIEW: God 自主决策需经 rule engine 校验后才执行，确保 NFR-001 状态变化必须 action-backed。
 */

import type { GodAdapter } from '../types/god-adapter.js';
import type { GodAutoDecision } from '../types/god-schemas.js';
import { GodAutoDecisionSchema } from '../types/god-schemas.js';
import { extractWithRetry } from '../parsers/god-json-extractor.js';
import { appendAuditLog, type GodAuditEntry } from './god-audit.js';
import type { RuleEngineResult, ActionContext } from './rule-engine.js';
import { collectGodAdapterOutput } from './god-call.js';

type AutoDecisionPhaseType = 'explore' | 'code' | 'discuss' | 'review' | 'debug';

interface AutoDecisionPhase {
  id: string;
  name: string;
  type: AutoDecisionPhaseType;
  description: string;
}

interface AutoDecisionLogEntry {
  round: number;
  classification: string;
  blockingIssueCount: number;
}

export interface AutoDecisionContext {
  round: number;
  maxRounds: number;
  taskGoal: string;
  sessionDir: string;
  seq: number;
  waitingReason: string;
  projectDir?: string;
  lastCoderOutput?: string;
  lastReviewerOutput?: string;
  currentPhaseId?: string;
  currentPhaseType?: AutoDecisionPhaseType;
  phases?: AutoDecisionPhase[];
  convergenceLog?: AutoDecisionLogEntry[];
  unresolvedIssues?: string[];
}

export interface AutoDecisionResult {
  decision: GodAutoDecision;
  ruleCheck: RuleEngineResult;
  blocked: boolean;
  reasoning: string;
}

const GOD_TIMEOUT_MS = 30_000;

function summarizeForPrompt(value: string, maxLength = 1500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function evaluateDecision(
  decision: GodAutoDecision,
  context: AutoDecisionContext,
  ruleEngine: (action: ActionContext) => RuleEngineResult,
): AutoDecisionResult {
  const effectiveCwd = context.projectDir ?? process.cwd();
  const ruleCheck = decision.action === 'continue_with_instruction' && decision.instruction
    ? ruleEngine({
      type: 'command_exec',
      command: decision.instruction,
      cwd: effectiveCwd,
      godApproved: true,
    })
    : { blocked: false, results: [] };

  return {
    decision,
    ruleCheck,
    blocked: ruleCheck.blocked,
    reasoning: decision.reasoning,
  };
}

function buildLocalAutoDecision(context: AutoDecisionContext): GodAutoDecision {
  if (
    context.lastReviewerOutput?.includes('[APPROVED]') &&
    (context.unresolvedIssues?.length ?? 0) === 0
  ) {
    return {
      action: 'accept',
      reasoning: 'Local fallback: reviewer approved and no unresolved issues remain.',
    };
  }

  const instruction = context.unresolvedIssues && context.unresolvedIssues.length > 0
    ? `Address the remaining issues: ${context.unresolvedIssues.join('; ')}`
    : context.currentPhaseId
      ? `Continue working on phase ${context.currentPhaseId} and make the next concrete improvement.`
      : 'Review the latest coder and reviewer outputs, then continue the task.';

  return {
    action: 'continue_with_instruction',
    reasoning: 'Local fallback: God unavailable for this turn, continuing autonomously.',
    instruction,
  };
}

export function makeLocalAutoDecision(
  context: AutoDecisionContext,
  ruleEngine: (action: ActionContext) => RuleEngineResult,
): AutoDecisionResult {
  return evaluateDecision(buildLocalAutoDecision(context), context, ruleEngine);
}

function buildAutoDecisionPrompt(context: AutoDecisionContext): string {
  const sections = [
    '## Auto Decision',
    '',
    `Task: ${context.taskGoal}`,
    `Round: ${context.round}/${context.maxRounds}`,
    `Waiting reason: ${context.waitingReason}`,
  ];

  if (context.currentPhaseId && context.phases) {
    const phaseList = context.phases
      .map((phase) => `${phase.id === context.currentPhaseId ? '->' : '  '} ${phase.id} (${phase.type}): ${phase.description}`)
      .join('\n');
    sections.push(
      '',
      `Current Phase: ${context.currentPhaseId} (${context.currentPhaseType ?? 'unknown'})`,
      `Phases:\n${phaseList}`,
    );
  }

  if (context.lastCoderOutput) {
    sections.push('', `## Last Coder Output\n${summarizeForPrompt(context.lastCoderOutput)}`);
  }

  if (context.lastReviewerOutput) {
    sections.push('', `## Last Reviewer Output\n${summarizeForPrompt(context.lastReviewerOutput)}`);
  }

  if (context.unresolvedIssues && context.unresolvedIssues.length > 0) {
    sections.push(
      '',
      `## Unresolved Issues\n${context.unresolvedIssues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}`,
    );
  }

  if (context.convergenceLog && context.convergenceLog.length > 0) {
    sections.push(
      '',
      `## Convergence History\n${context.convergenceLog.map((entry) => `Round ${entry.round}: ${entry.classification}, blocking=${entry.blockingIssueCount}`).join('\n')}`,
    );
  }

  sections.push(
    '',
    'You are the autonomous God orchestrator. You MUST decide and never defer to humans.',
    'Decide the next action. Output a JSON code block:',
    '```json',
    '{',
    '  "action": "accept" | "continue_with_instruction",',
    '  "reasoning": "...",',
    '  "instruction": "..."  // required if action is continue_with_instruction',
    '}',
    '```',
  );

  return sections.join('\n');
}

const SYSTEM_PROMPT = `You are the God orchestrator, the autonomous decision-maker for this AI coding system.
You MUST always make a decision.

Available actions:
- "accept": The task is complete and the output is satisfactory.
- "continue_with_instruction": More work is needed. Provide a clear instruction for the next iteration.

You are NEVER allowed to defer to a human.
If a Coder asks a question or proposes options, you choose the best option based on the task goal.
If there is a disagreement between Coder and Reviewer, you arbitrate and decide the direction.

For compound tasks with phases, evaluate whether the current phase goal is met.
If it is met, instruct the system to advance the work inside the next iteration.
Output a JSON code block with your decision.`;

export async function makeAutoDecision(
  godAdapter: GodAdapter,
  context: AutoDecisionContext,
  ruleEngine: (action: ActionContext) => RuleEngineResult,
): Promise<AutoDecisionResult> {
  const prompt = buildAutoDecisionPrompt(context);
  const rawOutput = await collectGodAdapterOutput({
    adapter: godAdapter,
    prompt,
    systemPrompt: SYSTEM_PROMPT,
    projectDir: context.projectDir,
    timeoutMs: GOD_TIMEOUT_MS,
    logging: {
      sessionDir: context.sessionDir,
      round: context.round,
      kind: 'god_auto_decision',
      meta: { attempt: 1, waitingReason: context.waitingReason },
    },
  });

  const extracted = await extractWithRetry(rawOutput, GodAutoDecisionSchema, async (hint) =>
    collectGodAdapterOutput({
      adapter: godAdapter,
      prompt: `${prompt}\n\nPrevious attempt had format errors: ${hint}\nPlease output valid JSON.`,
      systemPrompt: SYSTEM_PROMPT,
      projectDir: context.projectDir,
      timeoutMs: GOD_TIMEOUT_MS,
      logging: {
        sessionDir: context.sessionDir,
        round: context.round,
        kind: 'god_auto_decision',
        meta: { attempt: 2, waitingReason: context.waitingReason, retryReason: 'schema_validation' },
      },
    }),
  );

  const result = extracted && extracted.success
    ? evaluateDecision(extracted.data, context, ruleEngine)
    : makeLocalAutoDecision(context, ruleEngine);

  const entry: GodAuditEntry = {
    seq: context.seq,
    timestamp: new Date().toISOString(),
    round: context.round,
    decisionType: 'AUTO_DECISION',
    inputSummary: `waitingReason=${context.waitingReason}, taskGoal=${context.taskGoal}`.slice(0, 500),
    outputSummary: JSON.stringify(result.decision).slice(0, 500),
    decision: { ...result.decision, blocked: result.blocked },
  };
  appendAuditLog(context.sessionDir, entry);

  return result;
}
