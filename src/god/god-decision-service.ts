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
import { extractGodJson } from '../parsers/god-json-extractor.js';
import { collectGodAdapterOutput } from './god-call.js';
import { WatchdogService } from './watchdog.js';

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

const GOD_TIMEOUT_MS = 600_000;

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
 */

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
    const cleaned = isWorkObs ? stripToolMarkers(obs.summary) : obs.summary;
    const summary = cleaned;

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
   — [NOT YET IMPLEMENTED] Switch adapter for a role. Currently has no runtime effect.

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

/**
 * Build a slim prompt for resume rounds.
 * God's session context already contains: system prompt, Hand catalog, task goal,
 * previous decisions, available adapters, phase plan.
 * Only send: phase & round, observations, format reminder.
 */
function buildResumePrompt(observations: Observation[], context: GodDecisionContext): string {
  const sections: string[] = [];

  const phaseTypeStr = context.currentPhaseType ? ` (type: ${context.currentPhaseType})` : '';
  sections.push(`## Phase & Round\nPhase: ${context.currentPhaseId}${phaseTypeStr}\nRound: ${context.round} of ${context.maxRounds}\nActive Role: ${context.activeRole ?? 'none'}`);

  sections.push(buildObservationsSection(observations));

  sections.push('Reminder: re-read your system prompt and follow all instructions. Output a single GodDecisionEnvelope JSON code block.');

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
- For ANY phase type: when Coder proposes multiple approaches or solutions, you MUST send_to_reviewer for design evaluation before directing implementation — regardless of whether the phase is explore, debug, or code type
- Use set_phase ONLY with phase IDs defined in the Phase Plan
- If the coder's output already covers a later phase's work, still route through the current phase's review before advancing

Mandatory review before code changes:
- Before ANY code/debug phase transitions to implementation (Coder will modify files), you MUST send_to_reviewer first so the Reviewer can evaluate the Coder's proposed plan
- This applies even when Coder proposes only ONE approach — single proposals still need Reviewer validation
- The correct sequence is: Coder proposes → send_to_reviewer → Reviewer evaluates → then send_to_coder to implement (or iterate if Reviewer requests changes)
- Do NOT combine set_phase + send_to_coder to skip Reviewer — always route through Reviewer after Coder's proposal before directing implementation
- accept_task with rationale "reviewer_aligned" is only valid when Reviewer has actually participated and expressed agreement in the current task`;

// Decision reflection: God self-checks before finalizing envelope
export const DECISION_REFLECTION_INSTRUCTIONS = `Decision reflection — pause and self-check before finalizing high-stakes decisions.

A decision is high-stakes when it: sets or narrows direction (scope, plan), accepts or advances work product, pushes the workflow forward (advancing phases, concluding task, transitioning between task stages), deviates from the established plan, overrides another agent's judgment, or makes a choice on behalf of others. Routine same-phase handoffs that follow the obvious next step (e.g. CHANGES_REQUESTED → send_to_coder within the same phase) are low-stakes and need no reflection.

When reflection is triggered, verify:
- Scope: re-read the user's original request — does your plan or action cover every item the user explicitly named? Do not silently narrow scope.
- Quality: if coder delivered new implementation, were corresponding tests written? If not, send_to_coder to add test coverage before advancing.
- Plan consistency: if your actions deviate from the phase plan (skipping, reordering, creating ad-hoc phases), explain why in a system_log message.
- Proposal check: if Coder proposed multiple approaches and you are about to pick one yourself → STOP. You MUST route to reviewer first. Do not make design choices without reviewer input.`;

// BUG-24 fix: Proxy decision-making instructions
export const PROXY_DECISION_INSTRUCTIONS = `Worker question interception (proxy decision-making):
- Do NOT forward worker questions to the human via request_user_input. Instead, distinguish between two categories:
  a) Implementation detail questions (variable naming, library choice for an agreed approach, config values) → YOU answer them autonomously.
  b) Design proposals with multiple approaches (Coder presents options A/B/C, trade-off comparisons) → Do NOT pick an approach yourself. Route to Reviewer via send_to_reviewer for design evaluation first.
- For autonomously resolved questions (category a), fill the "autonomousResolutions" array with:
  1. "choice": your initial decision based on codebase context and task goals
  2. "reflection": review your choice — check consistency with task goals, feasibility, risks, and alternatives
  3. "finalChoice": your definitive answer after reflection (may differ from initial choice if reflection reveals issues)
- Then use send_to_coder or send_to_reviewer to communicate your resolved decisions.
- request_user_input is ONLY for: (a) a genuine human interrupt event was received, (b) the task is fundamentally impossible without information that does not exist anywhere in the codebase or task context.`;

// Proposal routing: God must coordinate Coder-Reviewer consensus on design proposals
export const PROPOSAL_ROUTING_INSTRUCTIONS = `Design proposal routing:
- When Coder output contains multiple implementation proposals or approaches (e.g. 方案 A/B/C, Option 1/2/3, trade-off comparisons, pros/cons tables), you MUST route them to Reviewer via send_to_reviewer BEFORE selecting one.
- Reviewer evaluates the proposals and provides their opinion and recommendation.
- Route Reviewer's feedback back to Coder via send_to_coder so Coder can respond.
- Once Coder and Reviewer align on an approach (or after 2 rounds of disagreement), you make the final call and direct implementation.
- Signals that Coder is proposing approaches:
  - Multiple named options (方案 A/B/C, Option 1/2/3, Approach X/Y)
  - Pros/cons comparison tables or trade-off analysis
  - "推荐方案" / "建议的修复方案" / "recommended approach"
  - Explicit alternative solutions with different trade-offs`;

export const SYSTEM_PROMPT = `You are the Sovereign God — the orchestration coordinator of the Duo runtime.

Your role:
- Analyze all observations from coder, reviewer, human, and runtime
- Coordinate Coder and Reviewer to reach consensus on design decisions before implementation
- When Coder proposes multiple approaches, route to Reviewer for evaluation BEFORE picking one
- You have final authority — but your DEFAULT behavior is to facilitate Coder-Reviewer collaboration
- Only use autonomous decision-making when Coder and Reviewer cannot converge, or for implementation details
- You NEVER defer to humans for requirement clarification — resolve ambiguities autonomously
- All state changes MUST be expressed as structured actions (Hands), not implied in messages
- Coder and Reviewer are workers under your management — they do not have accept authority

${PHASE_FOLLOWING_INSTRUCTIONS}

${REVIEWER_HANDLING_INSTRUCTIONS}

${PROPOSAL_ROUTING_INSTRUCTIONS}

${PROXY_DECISION_INSTRUCTIONS}

${DECISION_REFLECTION_INSTRUCTIONS}

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

Do NOT output anything outside the JSON code block.

Worker output format notes:
- Different adapters produce output in different styles and structures
- Codex outputs may include JSON with fields like "confidence" (numeric 0-1), "reasoning", and structured response objects — these are Codex's native format, not GodDecisionEnvelope fields
- When analyzing worker output, focus on the CONTENT and MEANING, not the format
- Extract the substantive work/review result regardless of how the adapter structures its response`;

// ── Internal Result Type ──

type GodCallResult =
  | { success: true; data: GodDecisionEnvelope }
  | { success: false; error: { kind: string; message: string }; rawOutput: string | null };

// ── Service ──

export class GodDecisionService {
  private readonly adapter: GodAdapter;
  private readonly watchdog: WatchdogService;
  private readonly model?: string;

  constructor(adapter: GodAdapter, watchdog: WatchdogService, model?: string) {
    this.adapter = adapter;
    this.watchdog = watchdog;
    this.model = model;
  }

  /**
   * Unified God decision: observations + context → GodDecisionEnvelope.
   *
   * Flow:
   * 1. Try God adapter → extract envelope
   * 2. On failure → Watchdog decides whether to retry (up to 3 times with backoff)
   * 3. If retries exhausted → return fallback envelope and pause
   */
  async makeDecision(
    observations: Observation[],
    context: GodDecisionContext,
    isResuming: boolean = false,
  ): Promise<GodDecisionEnvelope> {
    // Step 1: Try God
    const godResult = await this.tryGodCall(observations, context, isResuming);
    if (godResult.success) {
      this.watchdog.handleSuccess();
      return godResult.data;
    }

    // Step 2: Retry with backoff (Watchdog tracks failures)
    if (this.watchdog.shouldRetry()) {
      const backoff = this.watchdog.getBackoffMs();
      await new Promise(resolve => setTimeout(resolve, backoff));
      this.adapter.clearSession?.();
      const retryResult = await this.tryGodCall(observations, context, false);
      if (retryResult.success) {
        this.watchdog.handleSuccess();
        return retryResult.data;
      }
    }

    // Step 3: Retries exhausted or retry failed → fallback
    return buildFallbackEnvelope(context);
  }

  private async tryGodCall(
    observations: Observation[],
    context: GodDecisionContext,
    isResuming: boolean,
  ): Promise<GodCallResult> {
    const userPrompt = isResuming
      ? buildResumePrompt(observations, context)
      : buildUserPrompt(observations, context);

    let rawOutput: string;
    try {
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
        },
      });
    } catch (err) {
      return {
        success: false,
        error: {
          kind: err instanceof Error && err.constructor.name === 'ProcessTimeoutError'
            ? 'timeout' : 'adapter_error',
          message: err instanceof Error ? err.message : String(err),
        },
        rawOutput: null,
      };
    }

    const result = extractGodJson(rawOutput, GodDecisionEnvelopeSchema);
    if (result && result.success) {
      return { success: true, data: result.data };
    }

    return {
      success: false,
      error: {
        kind: 'schema_validation',
        message: result ? result.error : `No JSON found in output. Length: ${rawOutput.length}`,
      },
      rawOutput,
    };
  }

}
