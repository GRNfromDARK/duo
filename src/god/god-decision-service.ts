/**
 * Unified God Decision Service — single entry point for all God decisions.
 * Source: FR-003 (Runtime Core Loop), FR-004 (God Decision Envelope)
 * Card: C.1
 *
 * Replaces the 5 scattered God call points (routePostCoder / routePostReviewer /
 * evaluateConvergence / makeAutoDecision / classifyTask) with a single unified
 * makeDecision(observations, context) → GodDecisionEnvelope call.
 *
 * Existing call points are preserved as deprecated — migration happens in Phase D.
 */

import type { GodAdapter } from '../types/god-adapter.js';
import type { GodDecisionEnvelope } from '../types/god-envelope.js';
import type { Observation } from '../types/observation.js';
import { GodDecisionEnvelopeSchema } from '../types/god-envelope.js';
import { extractWithRetry } from '../parsers/god-json-extractor.js';
import { collectGodAdapterOutput } from './god-call.js';
import { DegradationManager } from './degradation-manager.js';

// ── Types ──

export interface GodDecisionContext {
  taskGoal: string;
  currentPhaseId: string;
  currentPhaseType?: 'explore' | 'code' | 'discuss' | 'review' | 'debug';
  phases?: {
    id: string;
    name: string;
    type: string;
    description: string;
  }[];
  round: number;
  maxRounds: number;
  previousDecisions: GodDecisionEnvelope[];
  availableAdapters: string[];
  activeRole: 'coder' | 'reviewer' | null;
  sessionDir: string;
}

// ── Constants ──

// Bug 8 fix: 30s too short for claude-code God adapter (TASK_INIT alone can take 17s)
const GOD_TIMEOUT_MS = 90_000;

const SEVERITY_ORDER: Record<string, number> = {
  fatal: 0,
  error: 1,
  warning: 2,
  info: 3,
};

// ── Fallback Envelope ──

function buildFallbackEnvelope(context: GodDecisionContext): GodDecisionEnvelope {
  // BUG-22 fix: include a wait action so execution produces an observation,
  // preventing the death spiral where empty actions → empty results → lost observations.
  return {
    diagnosis: {
      summary: 'Fallback: God decision service failed to produce valid envelope',
      currentGoal: context.taskGoal,
      currentPhaseId: context.currentPhaseId,
      notableObservations: [],
    },
    authority: {
      userConfirmation: 'not_required',
      reviewerOverride: false,
      acceptAuthority: 'reviewer_aligned',
    },
    actions: [
      { type: 'wait', reason: 'God decision parsing failed — will retry with preserved context' },
    ],
    messages: [
      { target: 'system_log', content: 'God decision fallback activated — waiting to retry' },
    ],
  };
}

// ── Reviewer Verdict Extraction (Card D.2: FR-010) ──

const VERDICT_PATTERN = /\[(APPROVED|CHANGES_REQUESTED)\]/;

/**
 * Extract reviewer verdict from a review_output observation.
 * Returns 'APPROVED' | 'CHANGES_REQUESTED' | null.
 */
export function extractReviewerVerdict(obs: Observation): 'APPROVED' | 'CHANGES_REQUESTED' | null {
  if (obs.source !== 'reviewer' || obs.type !== 'review_output') return null;

  const text = obs.rawRef ?? obs.summary;
  const match = VERDICT_PATTERN.exec(text);
  return match ? (match[1] as 'APPROVED' | 'CHANGES_REQUESTED') : null;
}

// ── Prompt Building ──

/**
 * Sort observations: higher severity first, then by timestamp ascending.
 */
function sortObservations(observations: Observation[]): Observation[] {
  return [...observations].sort((a, b) => {
    const sevDiff = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return a.timestamp.localeCompare(b.timestamp);
  });
}

/**
 * Build the observations section for God prompt.
 * Card D.2: highlights reviewer verdict when present.
 *
 * Budget management: each observation gets up to MAX_OBS_CHARS characters.
 * Work/review observations (the most important) get full budget;
 * runtime signals get a smaller budget since they're metadata.
 */
const MAX_OBS_CHARS = 20000;
const MAX_RUNTIME_OBS_CHARS = 300;

/**
 * Strip ANSI escape sequences from text (terminal control codes, mouse events, etc.).
 * These can appear in task input when users paste from terminals.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\[<[0-9;]*[mM]/g;

export function stripAnsiEscapes(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '').trim();
}

/**
 * Strip tool/shell markers from worker output before forwarding to God.
 * These markers (e.g. [Read], [Glob result], [shell], [shell result]) are
 * noise for God decision-making — God only needs the analysis conclusions.
 */
const TOOL_MARKER_PATTERN = /^\[(?:Read|Edit|Glob|Grep|Bash|Write|Agent|Tool)(?:\s+(?:result|error))?\].*$/gm;
const SHELL_MARKER_PATTERN = /^\[shell(?:\s+result)?\].*$/gm;
const EXCESSIVE_BLANK_LINES = /\n{3,}/g;

export function stripToolMarkers(text: string): string {
  return text
    .replace(TOOL_MARKER_PATTERN, '')
    .replace(SHELL_MARKER_PATTERN, '')
    .replace(EXCESSIVE_BLANK_LINES, '\n\n')
    .trim();
}

export function buildObservationsSection(observations: Observation[]): string {
  const sorted = sortObservations(observations);
  const lines = sorted.map((obs, i) => {
    const isWorkObs = obs.type === 'work_output' || obs.type === 'review_output';
    const budget = isWorkObs ? MAX_OBS_CHARS : MAX_RUNTIME_OBS_CHARS;
    const cleaned = isWorkObs ? stripToolMarkers(obs.summary) : obs.summary;
    const summary = cleaned.length > budget
      ? cleaned.slice(0, budget) + '...'
      : cleaned;

    let line = `${i + 1}. [${obs.severity.toUpperCase()}] (${obs.source}/${obs.type}) ${summary}`;
    // Card D.2: highlight reviewer verdict for God's attention
    if (obs.source === 'reviewer' && obs.type === 'review_output') {
      const verdict = extractReviewerVerdict(obs);
      if (verdict) {
        line += ` — Reviewer verdict: [${verdict}]`;
      }
    }
    return line;
  });
  return `## Recent Observations\n${lines.join('\n')}`;
}

export function buildPreviousDecisionSection(decisions: GodDecisionEnvelope[]): string {
  if (decisions.length === 0) return '';

  const last = decisions[decisions.length - 1];
  const actionTypes = last.actions.map(a => a.type).join(', ');
  let section = `## Last Decision Summary\n- Diagnosis: ${last.diagnosis.summary}\n- Actions: ${actionTypes || 'none'}\n- Authority: userConfirmation=${last.authority.userConfirmation}, reviewerOverride=${last.authority.reviewerOverride}, acceptAuthority=${last.authority.acceptAuthority}`;

  // BUG-24: Include autonomous resolutions so God maintains context consistency
  if (last.autonomousResolutions && last.autonomousResolutions.length > 0) {
    const resolutionLines = last.autonomousResolutions.map((r, i) =>
      `  ${i + 1}. Q: ${r.question}\n     Decision: ${r.finalChoice}`,
    );
    section += `\n\n### Autonomous Resolutions (God proxy decisions)\n${resolutionLines.join('\n')}`;
  }

  return section;
}

// SPEC-DECISION: Hand catalog is generated as a structured list (not full JSON Schema)
// because God needs to understand action semantics, not machine-parse the schema.
// Full JSON Schema would bloat the prompt. A readable list is sufficient for God to
// select and parameterize actions correctly.
function buildHandCatalog(): string {
  return `## Available Hand Actions (actions array)

Each action is a JSON object with a "type" field. Available types:

1. send_to_coder { type: "send_to_coder", message: string }
   — Send work instruction to coder

2. send_to_reviewer { type: "send_to_reviewer", message: string }
   — Send review instruction to reviewer

3. stop_role { type: "stop_role", role: "coder"|"reviewer", reason: string }
   — Stop a running role

4. retry_role { type: "retry_role", role: "coder"|"reviewer", hint?: string }
   — Retry a role with optional hint

5. switch_adapter { type: "switch_adapter", role: "coder"|"reviewer"|"god", adapter: string, reason: string }
   — Switch adapter for a role

6. set_phase { type: "set_phase", phaseId: string, summary?: string }
   — Set current phase (explicit phase transition)

7. accept_task { type: "accept_task", rationale: "reviewer_aligned"|"god_override"|"forced_stop", summary: string }
   — Accept/complete the task (must carry rationale)

8. wait { type: "wait", reason: string, estimatedSeconds?: number }
   — Enter wait state

9. request_user_input { type: "request_user_input", question: string }
   — Request human input

10. resume_after_interrupt { type: "resume_after_interrupt", resumeStrategy: "continue"|"redirect"|"stop" }
    — Resume after human interrupt

11. emit_summary { type: "emit_summary", content: string }
    — Emit management summary`;
}

function buildPhasePlanSection(context: GodDecisionContext): string {
  if (!context.phases || context.phases.length === 0) return '';

  const phaseList = context.phases
    .map((phase) => {
      const marker = phase.id === context.currentPhaseId ? '→' : ' ';
      return `${marker} ${phase.id} (${phase.type}): ${phase.name} — ${phase.description}`;
    })
    .join('\n');

  return `## Phase Plan\nCurrent: ${context.currentPhaseId} (type: ${context.currentPhaseType ?? 'unknown'})\n\n${phaseList}`;
}

function buildUserPrompt(observations: Observation[], context: GodDecisionContext): string {
  const sections: string[] = [];

  sections.push(`## Task Goal\n${stripAnsiEscapes(context.taskGoal)}`);

  const phaseTypeStr = context.currentPhaseType ? ` (type: ${context.currentPhaseType})` : '';
  sections.push(`## Phase & Round\nPhase: ${context.currentPhaseId}${phaseTypeStr}\nRound: ${context.round} of ${context.maxRounds}\nActive Role: ${context.activeRole ?? 'none'}`);

  const phasePlan = buildPhasePlanSection(context);
  if (phasePlan) sections.push(phasePlan);

  sections.push(`## Available Adapters\n${context.availableAdapters.join(', ')}`);
  sections.push(buildObservationsSection(observations));

  const prevSection = buildPreviousDecisionSection(context.previousDecisions);
  if (prevSection) sections.push(prevSection);

  sections.push(buildHandCatalog());

  return sections.join('\n\n');
}

// Card D.2: Reviewer handling instructions (FR-010)
// Exported so tests can verify the prompt content.
export const REVIEWER_HANDLING_INSTRUCTIONS = `Reviewer conclusion handling:
- When a reviewer observation is present, reference the reviewer verdict in diagnosis.notableObservations
- If you agree with the reviewer: set authority.acceptAuthority = "reviewer_aligned"
- If you override the reviewer: set authority.reviewerOverride = true AND include a system_log message explaining why
- The reviewer's verdict is informational — you make the final decision
- Never ignore a reviewer observation — always acknowledge it in your diagnosis

Reviewer feedback auto-forwarding:
- When you route post-reviewer work back to Coder (send_to_coder), the Reviewer's FULL original analysis is automatically injected into the Coder's prompt by the platform
- Therefore, your send_to_coder.message should focus on ROUTING GUIDANCE: what to prioritize, what approach to take, which issues are most critical
- Do NOT repeat or summarize the Reviewer's analysis in your message — the Coder already has the complete original text
- Your message adds value by providing strategic direction that the Reviewer's analysis alone does not convey
- Example good message: "Focus on the scroll event propagation issue identified by the Reviewer. The CSS overflow approach is preferred over JS event listeners."
- Example bad message: "The Reviewer found that Ink uses readable + stdin.read() which captures mouse events. Please fix the scroll..."  (redundant — Coder already sees the full Reviewer text)`;

// Phase-following instructions for compound tasks (Bug 11 fix)
export const PHASE_FOLLOWING_INSTRUCTIONS = `Phase plan compliance:
- When a Phase Plan is provided, follow the defined phase sequence — do NOT skip phases or create ad-hoc phases
- For review-type phases: you MUST send_to_reviewer before advancing to the next phase — coder proposals alone are not sufficient
- Use set_phase ONLY with phase IDs defined in the Phase Plan
- If the coder's output already covers a later phase's work, still route through the current phase's review before advancing
- If you skip or merge phases, explain the reason in a system_log message — one set_phase per decision is preferred; multiple set_phase calls require explanation`;

// BUG-24 fix: Proxy decision-making instructions
export const PROXY_DECISION_INSTRUCTIONS = `Worker question interception (proxy decision-making):
- When worker output contains questions directed at the user (design decisions, confirmation requests, implementation choices), YOU answer them — do NOT use request_user_input to forward worker questions to the human.
- For each intercepted question, fill the "autonomousResolutions" array with a two-step process:
  1. "choice": your initial decision based on codebase context and task goals
  2. "reflection": review your choice — check consistency with task goals, feasibility, risks, and alternatives
  3. "finalChoice": your definitive answer after reflection (may differ from initial choice if reflection reveals issues)
- Then use send_to_coder or send_to_reviewer to communicate your resolved decisions.
- request_user_input is ONLY for: (a) a genuine human interrupt event was received, (b) the task is fundamentally impossible without information that does not exist anywhere in the codebase or task context.`;

export const SYSTEM_PROMPT = `You are the Sovereign God — the sole decision-maker of the Duo runtime.

Your role:
- Analyze all observations from coder, reviewer, human, and runtime
- Make the single authoritative decision for the next step
- You are fully autonomous — you NEVER defer to humans for design decisions, implementation choices, or requirement clarification
- All state changes MUST be expressed as structured actions (Hands), not implied in messages
- Coder and Reviewer are workers under your management — they do not have accept authority
- Scope preservation: if the user explicitly named specific roles, components, or items in the task, you MUST include all named items in scope — do not exclude any user-listed item from the MVP or plan

${PHASE_FOLLOWING_INSTRUCTIONS}

${REVIEWER_HANDLING_INSTRUCTIONS}

${PROXY_DECISION_INSTRUCTIONS}

Output format: You MUST output a single JSON code block containing a GodDecisionEnvelope:

\`\`\`json
{
  "diagnosis": {
    "summary": "Brief situation assessment",
    "currentGoal": "What we are trying to achieve",
    "currentPhaseId": "Current phase identifier",
    "notableObservations": ["Key observations driving this decision"]
  },
  "authority": {
    "userConfirmation": "human" | "god_override" | "not_required",
    "reviewerOverride": false,
    "acceptAuthority": "reviewer_aligned" | "god_override" | "forced_stop"
  },
  "actions": [
    // One or more Hand actions from the catalog
  ],
  "messages": [
    { "target": "coder" | "reviewer" | "user" | "system_log", "content": "..." }
  ],
  "autonomousResolutions": [
    {
      "question": "The worker question being resolved",
      "choice": "Your initial decision",
      "reflection": "Review of your choice — consistency, risks, alternatives",
      "finalChoice": "Your definitive answer after reflection"
    }
  ]
}
\`\`\`

Authority constraints:
- When reviewerOverride is true, messages MUST contain a system_log entry explaining why
- When acceptAuthority is "god_override", messages MUST contain a system_log entry explaining why
- When acceptAuthority is "forced_stop", messages MUST contain a user-targeted summary
- accept_task MUST carry a rationale field

Do NOT output anything outside the JSON code block.`;

// ── Service ──

export class GodDecisionService {
  private readonly adapter: GodAdapter;
  private readonly degradation: DegradationManager;
  private readonly model?: string;

  constructor(adapter: GodAdapter, degradation: DegradationManager, model?: string) {
    this.adapter = adapter;
    this.degradation = degradation;
    this.model = model;
  }

  /**
   * Unified God decision: observations + context → GodDecisionEnvelope.
   *
   * Flow:
   * 1. Build prompt with observations, context, Hand catalog, output format
   * 2. Call God adapter via collectGodAdapterOutput
   * 3. Parse JSON with extractWithRetry (Zod validation)
   * 4. On failure: trigger DegradationManager → return fallback envelope
   * 5. On success: reset DegradationManager → return envelope
   */
  async makeDecision(
    observations: Observation[],
    context: GodDecisionContext,
  ): Promise<GodDecisionEnvelope> {
    const userPrompt = buildUserPrompt(observations, context);

    let rawOutput: string;
    try {
      // Step 1: Call God adapter
      rawOutput = await collectGodAdapterOutput({
        adapter: this.adapter,
        prompt: userPrompt,
        systemPrompt: SYSTEM_PROMPT,
        timeoutMs: GOD_TIMEOUT_MS,
        model: this.model,
        logging: {
          sessionDir: context.sessionDir,
          round: context.round,
          kind: 'god_unified_decision',
          meta: { attempt: 1 },
        },
      });
    } catch (err) {
      // Bug 8 fix: catch adapter errors (timeout, tool_use, process crash)
      // instead of letting them propagate to MANUAL_FALLBACK
      const errorKind = err instanceof Error && err.constructor.name === 'ProcessTimeoutError'
        ? 'timeout' as const
        : 'process_exit' as const;
      this.degradation.handleGodFailure({
        kind: errorKind,
        message: `God adapter call failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return buildFallbackEnvelope(context);
    }

    // Step 2: Extract and validate with retry
    // BUG-23 fix: extractWithRetry now always returns ExtractResult (never null),
    // providing error details for diagnostics.
    let result: Awaited<ReturnType<typeof extractWithRetry<GodDecisionEnvelope>>>;
    try {
      result = await extractWithRetry(
        rawOutput,
        GodDecisionEnvelopeSchema,
        async (errorHint: string) => {
          const retryPrompt = `${userPrompt}\n\n[FORMAT ERROR] ${errorHint}\n\nPlease output a corrected JSON block.`;
          return collectGodAdapterOutput({
            adapter: this.adapter,
            prompt: retryPrompt,
            systemPrompt: SYSTEM_PROMPT,
            timeoutMs: GOD_TIMEOUT_MS,
            model: this.model,
            logging: {
              sessionDir: context.sessionDir,
              round: context.round,
              kind: 'god_unified_decision',
              meta: { attempt: 2, retryReason: 'schema_validation' },
            },
          });
        },
      );
    } catch (err) {
      // Retry call also failed (timeout, tool_use, etc.)
      this.degradation.handleGodFailure({
        kind: 'process_exit',
        message: `God adapter retry failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return buildFallbackEnvelope(context);
    }

    // Step 3: Handle result
    if (result.success) {
      this.degradation.handleGodSuccess();
      return result.data;
    }

    // Parse failed — trigger DegradationManager L3
    // BUG-23 fix: include specific error details in the failure message
    this.degradation.handleGodFailure({
      kind: 'schema_validation',
      message: `GodDecisionEnvelope extraction/validation failed: ${result.error}`,
    });

    return buildFallbackEnvelope(context);
  }
}
