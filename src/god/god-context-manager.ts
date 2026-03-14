/**
 * God Context Manager — incremental prompt management for God.
 * Source: FR-012 (AC-037, AC-038), AR-006
 *
 * Core principle: God CLI maintains conversation history via --resume.
 * Duo only sends incremental information each round, not full history.
 * When context window is exhausted, rebuild session with convergenceLog summary.
 */

import type { ConvergenceLogEntry } from './god-convergence.js';
import type { GodDecisionEnvelope } from '../types/god-envelope.js';
import type { Observation } from '../types/observation.js';

// ── Constants ──

/** Approximate chars per token for estimation */
export const CHARS_PER_TOKEN = 4;

/** Max God prompt size in tokens (AC-037) */
const MAX_PROMPT_TOKENS = 10_000;
const MAX_PROMPT_CHARS = MAX_PROMPT_TOKENS * CHARS_PER_TOKEN;

/** Threshold ratio for session rebuild trigger */
const REBUILD_THRESHOLD = 0.9;

/** Max chars for coder/reviewer output sections in incremental prompt */
const MAX_OUTPUT_SECTION_CHARS = 15_000;

// ── GodContextManager ──

export class GodContextManager {
  /**
   * Build an incremental prompt for God containing only the latest round's data
   * plus a concise trend summary. Does NOT include full history (AC-037).
   */
  buildIncrementalPrompt(params: {
    latestCoderOutput: string;
    latestReviewerOutput?: string;
    convergenceLog: ConvergenceLogEntry[];
    round: number;
  }): string {
    const sections: string[] = [];

    sections.push(`## Round ${params.round} Update`);

    // Latest Coder output (truncated if needed)
    const coderOutput = truncate(params.latestCoderOutput, MAX_OUTPUT_SECTION_CHARS);
    sections.push(`## Latest Coder Output\n${coderOutput}`);

    // Latest Reviewer output (if available)
    if (params.latestReviewerOutput) {
      const reviewerOutput = truncate(params.latestReviewerOutput, MAX_OUTPUT_SECTION_CHARS);
      sections.push(`## Latest Reviewer Output\n${reviewerOutput}`);
    }

    // Trend summary (concise, not full history)
    if (params.convergenceLog.length > 0) {
      const trend = this.buildTrendSummary(params.convergenceLog);
      sections.push(`## Convergence Trend\n${trend}`);
    }

    let prompt = sections.join('\n\n');

    // Enforce AC-037: < 10k tokens
    if (prompt.length > MAX_PROMPT_CHARS) {
      prompt = prompt.slice(0, MAX_PROMPT_CHARS - 3) + '...';
    }

    return prompt;
  }

  /**
   * Build a concise trend summary from convergenceLog.
   * Shows blocking issue count trend and criteria progress, not full entries.
   */
  buildTrendSummary(convergenceLog: ConvergenceLogEntry[]): string {
    if (convergenceLog.length === 0) return '';

    const parts: string[] = [];

    // Blocking issue count trend: "5→3→1"
    const counts = convergenceLog.map(e => e.blockingIssueCount);
    const trendLine = `Blocking issues: ${counts.join('→')}`;
    parts.push(trendLine);

    // Classify overall trend
    const trend = classifyTrend(counts);
    parts.push(`Trend: ${trend}`);

    // Latest criteria progress
    const latest = convergenceLog[convergenceLog.length - 1];
    if (latest.criteriaProgress.length > 0) {
      const satisfied = latest.criteriaProgress.filter(c => c.satisfied).length;
      const total = latest.criteriaProgress.length;
      parts.push(`Criteria: ${satisfied}/${total} satisfied`);
    }

    return parts.join('\n');
  }

  /**
   * Check if God session should be rebuilt due to context window exhaustion.
   * Returns true when tokenEstimate reaches REBUILD_THRESHOLD of limit.
   */
  shouldRebuildSession(tokenEstimate: number, limit: number): boolean {
    return tokenEstimate >= limit * REBUILD_THRESHOLD;
  }

  // ── Observation-based prompt building (Card C.3) ──

  /**
   * Build a God user prompt based on Observation history and previous decisions.
   * Replaces the old RoundRecord-based approach.
   *
   * Includes:
   * - Recent observations sorted by severity (type + severity + summary)
   * - Compressed summaries for older observations
   * - Previous decision summaries (diagnosis.summary + action types)
   * - Available Hand action catalog
   * - GodDecisionEnvelope JSON output format requirement
   * - Authority constraint reminders
   */
  buildObservationPrompt(params: {
    observations: Observation[];
    previousDecisions: GodDecisionEnvelope[];
    tokenBudget: number;
  }): string {
    const maxChars = params.tokenBudget * CHARS_PER_TOKEN;
    const sections: string[] = [];

    // 1. Observations section — sorted by severity, recent ones in full
    const observationsSection = buildObservationsSection(
      params.observations,
      maxChars,
    );
    sections.push(observationsSection);

    // 2. Previous decisions summary
    if (params.previousDecisions.length > 0) {
      sections.push(buildDecisionsSummary(params.previousDecisions));
    }

    // 3. Hand action catalog (AC-2)
    sections.push(HAND_CATALOG);

    // 4. Output format requirement (AC-3) + Authority constraints
    sections.push(OUTPUT_FORMAT_REQUIREMENT);
    sections.push(AUTHORITY_CONSTRAINTS);

    let prompt = sections.join('\n\n');

    // Enforce token budget
    if (prompt.length > maxChars) {
      prompt = prompt.slice(0, maxChars - 3) + '...';
    }

    return prompt;
  }

  /**
   * Build a rebuild prompt after context exhaustion that preserves critical observations.
   * Critical = severity 'error' or 'fatal'.
   */
  buildObservationRebuildPrompt(params: {
    observations: Observation[];
    previousDecisions: GodDecisionEnvelope[];
  }): string {
    const sections: string[] = [];

    sections.push('## Session Rebuild — Observation Context Restored');
    sections.push('This is a session continuation. Previous context was exhausted and rebuilt from observation history.');

    // Preserve critical observations (error + fatal)
    const critical = params.observations.filter(
      o => o.severity === 'error' || o.severity === 'fatal',
    );
    if (critical.length > 0) {
      const lines = critical.map(
        (obs, i) => `${i + 1}. [${obs.severity}] (${obs.source}/${obs.type}) ${obs.summary}`,
      );
      sections.push(`## Critical Observations\n${lines.join('\n')}`);
    }

    // Recent non-critical observations summary
    const recent = params.observations.slice(-5);
    const recentNonCritical = recent.filter(
      o => o.severity !== 'error' && o.severity !== 'fatal',
    );
    if (recentNonCritical.length > 0) {
      const lines = recentNonCritical.map(
        (obs, i) => `${i + 1}. (${obs.source}/${obs.type}) ${obs.summary}`,
      );
      sections.push(`## Recent Observations\n${lines.join('\n')}`);
    }

    // Decision history summary
    if (params.previousDecisions.length > 0) {
      sections.push(buildDecisionsSummary(params.previousDecisions));
    }

    return sections.join('\n\n');
  }

  /**
   * Build a prompt for starting a new God session after context window exhaustion.
   * Contains convergenceLog summary for decision continuity (AC-038).
   */
  buildSessionRebuildPrompt(convergenceLog: ConvergenceLogEntry[]): string {
    const sections: string[] = [];

    sections.push('## Session Rebuild — Context Restored');
    sections.push('This is a session continuation. Previous context was exhausted and rebuilt from convergence history.');

    if (convergenceLog.length === 0) {
      sections.push('No prior convergence history available.');
      return sections.join('\n\n');
    }

    const lastRound = convergenceLog[convergenceLog.length - 1].round;
    sections.push(`## Progress (up to round ${lastRound})`);

    // Trend summary
    const trend = this.buildTrendSummary(convergenceLog);
    sections.push(trend);

    // Latest criteria detail
    const latest = convergenceLog[convergenceLog.length - 1];
    if (latest.criteriaProgress.length > 0) {
      const criteriaLines = latest.criteriaProgress
        .map(c => `- ${c.satisfied ? '✓' : '✗'} ${c.criterion}`)
        .join('\n');
      sections.push(`## Criteria Status\n${criteriaLines}`);
    }

    // Last classification
    sections.push(`Last classification: ${latest.classification}`);

    return sections.join('\n\n');
  }
}

// ── Internal helpers ──

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

// ── Observation-based helpers (Card C.3) ──

const SEVERITY_ORDER: Record<string, number> = {
  fatal: 0,
  error: 1,
  warning: 2,
  info: 3,
};

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
 * Build the observations section of the prompt.
 * Priority: (1) high-severity obs always included, (2) most recent obs fill remaining budget.
 * Final display sorted by severity first, then timestamp.
 */
function buildObservationsSection(
  observations: Observation[],
  maxChars: number,
): string {
  // Reserve ~40% of budget for observations
  const obsBudget = Math.floor(maxChars * 0.4);
  const headerLen = '## Recent Observations\n'.length;

  // Phase 1: Always include high-severity (error + fatal) observations
  const highSeverity = observations.filter(o => o.severity === 'fatal' || o.severity === 'error');
  const rest = observations.filter(o => o.severity !== 'fatal' && o.severity !== 'error');

  // Phase 2: From remaining, take the most recent ones (by timestamp desc)
  const recentRest = [...rest].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const selected: Observation[] = [...highSeverity];
  let usedChars = headerLen;

  for (const obs of highSeverity) {
    usedChars += formatObsLine(obs, 0).length + 1;
  }

  for (const obs of recentRest) {
    const lineLen = formatObsLine(obs, 0).length + 1;
    if (usedChars + lineLen < obsBudget) {
      selected.push(obs);
      usedChars += lineLen;
    }
  }

  // Final sort for display: severity first, then timestamp
  const display = sortObservations(selected);
  const lines = display.map((obs, i) => formatObsLine(obs, i + 1));

  return `## Recent Observations\n${lines.join('\n')}`;
}

function formatObsLine(obs: Observation, index: number): string {
  return `${index}. [${obs.severity}] (${obs.source}/${obs.type}) ${obs.summary}`;
}

/**
 * Summarize previous GodDecisionEnvelopes.
 */
function buildDecisionsSummary(decisions: GodDecisionEnvelope[]): string {
  const lines = decisions.map((d, i) => {
    const actionTypes = d.actions.map(a => a.type).join(', ');
    return `${i + 1}. ${d.diagnosis.summary} — Actions: ${actionTypes || 'none'}`;
  });
  return `## Previous Decisions\n${lines.join('\n')}`;
}

// Hand action catalog — structured readable list for God's action selection
const HAND_CATALOG = `## Available Hand Actions (actions array)

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

// Output format requirement for GodDecisionEnvelope JSON
const OUTPUT_FORMAT_REQUIREMENT = `## Required Output Format

You MUST output a single JSON code block containing a GodDecisionEnvelope:

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
  ]
}
\`\`\``;

// Authority constraint reminders
const AUTHORITY_CONSTRAINTS = `## Authority Constraints

- When reviewerOverride is true, messages MUST contain a system_log entry explaining the override reason
- When acceptAuthority is "god_override", messages MUST contain a system_log entry explaining why
- When acceptAuthority is "forced_stop", messages MUST contain a user-targeted summary
- accept_task MUST carry a rationale field
- All state changes MUST be expressed as structured actions (Hands), not implied in messages`;

function classifyTrend(counts: number[]): string {
  if (counts.length < 2) return 'insufficient data';

  const last = counts[counts.length - 1];
  const first = counts[0];

  // Check if all values are the same
  if (counts.every(c => c === counts[0])) return 'stagnant';

  if (last < first) return 'improving';
  if (last > first) return 'declining';

  // first === last but intermediate values differ — detect oscillation
  // Count direction changes to identify volatile/oscillating patterns
  let directionChanges = 0;
  for (let i = 2; i < counts.length; i++) {
    const prevDir = Math.sign(counts[i - 1] - counts[i - 2]);
    const currDir = Math.sign(counts[i] - counts[i - 1]);
    if (prevDir !== 0 && currDir !== 0 && prevDir !== currDir) {
      directionChanges++;
    }
  }
  if (directionChanges > 0) return 'oscillating';

  return 'stagnant';
}
