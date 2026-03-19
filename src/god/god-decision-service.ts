/**
 * Unified God Decision Service — simplified.
 * Single entry point: makeDecision(observations, context) → GodDecisionEnvelope.
 * 5 actions, no phases, no authority, no autonomousResolutions.
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
  return {
    diagnosis: {
      summary: 'Fallback: God decision service failed to produce valid envelope',
      currentGoal: context.taskGoal,
      notableObservations: [],
    },
    actions: [
      { type: 'wait', reason: 'God decision parsing failed — will retry with preserved context' },
    ],
    messages: [
      { target: 'system_log', content: 'God decision fallback activated — waiting to retry' },
    ],
  };
}

// ── Text Processing ──

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\[<[0-9;]*[mM]/g;

export function stripAnsiEscapes(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '').trim();
}

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

// ── Prompt Building ──

function sortObservations(observations: Observation[]): Observation[] {
  return [...observations].sort((a, b) => {
    const sevDiff = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return a.timestamp.localeCompare(b.timestamp);
  });
}

export function buildObservationsSection(observations: Observation[]): string {
  const sorted = sortObservations(observations);
  const lines = sorted.map((obs, i) => {
    const isWorkObs = obs.type === 'work_output' || obs.type === 'review_output';
    const cleaned = isWorkObs ? stripToolMarkers(obs.summary) : obs.summary;
    return `${i + 1}. [${obs.severity.toUpperCase()}] (${obs.source}/${obs.type}) ${cleaned}`;
  });
  return `## Recent Observations\n${lines.join('\n')}`;
}

function buildHandCatalog(): string {
  return `## Available Hand Actions (actions array)

Each action is a JSON object with a "type" field. Available types:

1. send_to_coder { type: "send_to_coder", dispatchType: "explore"|"code"|"debug"|"discuss", message: string }
   — Send work to coder. dispatchType controls coder's mode:
     "explore": read-only investigation, no file changes
     "discuss": evaluate options, recommend approach
     "code": implement, refactor, write tests (file changes allowed)
     "debug": diagnose and minimal fix (narrow file changes)

2. send_to_reviewer { type: "send_to_reviewer", message: string }
   — Send coder's work for review

3. accept_task { type: "accept_task", summary: string }
   — Task is done. Summary explains what was accomplished.

4. wait { type: "wait", reason: string, estimatedSeconds?: number }
   — Pause before next decision

5. request_user_input { type: "request_user_input", question: string }
   — Ask the human (use sparingly — only when truly needed)`;
}

function buildUserPrompt(observations: Observation[], context: GodDecisionContext): string {
  const sections: string[] = [];

  sections.push(`## Task Goal\n${stripAnsiEscapes(context.taskGoal)}`);
  sections.push(`## Active Role: ${context.activeRole ?? 'none'}`);
  sections.push(`## Available Adapters\n${context.availableAdapters.join(', ')}`);
  sections.push(buildObservationsSection(observations));
  sections.push(buildHandCatalog());

  return sections.join('\n\n');
}

function buildResumePrompt(observations: Observation[]): string {
  const sections: string[] = [];

  sections.push(buildObservationsSection(observations));
  sections.push('Reminder: re-read your system prompt and follow all instructions. Output a single GodDecisionEnvelope JSON code block.');

  return sections.join('\n\n');
}

// ── System Prompt ──

export const SYSTEM_PROMPT = `You are the God orchestrator of the Duo runtime.

Your job: route work between coder and reviewer until the task is done.

You have 5 actions:

1. send_to_coder(dispatchType, message) — send work to coder
   dispatchType options:
   - "explore": read-only investigation, no file changes
   - "discuss": evaluate options, recommend approach
   - "code": implement, refactor, write tests (file changes allowed)
   - "debug": diagnose and minimal fix (narrow changes)

2. send_to_reviewer(message) — send coder's work for review

3. accept_task(summary) — task is done

4. wait(reason) — pause before next decision

5. request_user_input(question) — ask the human (use sparingly)

Guidelines:
- LANGUAGE: Always respond in the same language as the user's task description.
- When coder presents multiple approaches, send to reviewer first before picking one
- Acknowledge reviewer feedback in your diagnosis.notableObservations
- When routing post-reviewer work back to coder, focus on strategic guidance — the full reviewer text is auto-forwarded
- Reflect before accepting task or overriding reviewer judgment
- If coder or reviewer seems stuck or looping, change strategy or ask the user
- You NEVER defer to humans for routine decisions — resolve ambiguities autonomously
- request_user_input is ONLY for: genuine human interrupt events, or when the task is fundamentally impossible without external information

Output format: a single JSON code block:

\`\`\`json
{
  "diagnosis": {
    "summary": "Brief situation assessment",
    "currentGoal": "What we are trying to achieve",
    "notableObservations": ["Key observations driving this decision"]
  },
  "actions": [
    // One or more Hand actions from the catalog
  ],
  "messages": [
    { "target": "coder" | "reviewer" | "user" | "system_log", "content": "..." }
  ]
}
\`\`\`

Do NOT output anything outside the JSON code block.

Worker output format notes:
- Different adapters produce output in different styles
- Focus on CONTENT and MEANING, not format
- Extract the substantive work/review result regardless of adapter structure`;

// ── Service ──

type GodCallResult =
  | { success: true; data: GodDecisionEnvelope }
  | { success: false; error: { kind: string; message: string }; rawOutput: string | null };

export class GodDecisionService {
  private readonly adapter: GodAdapter;
  private readonly watchdog: WatchdogService;
  private readonly model?: string;

  constructor(adapter: GodAdapter, watchdog: WatchdogService, model?: string) {
    this.adapter = adapter;
    this.watchdog = watchdog;
    this.model = model;
  }

  async makeDecision(
    observations: Observation[],
    context: GodDecisionContext,
    isResuming: boolean = false,
  ): Promise<GodDecisionEnvelope> {
    const godResult = await this.tryGodCall(observations, context, isResuming);
    if (godResult.success) {
      this.watchdog.handleSuccess();
      return godResult.data;
    }

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

    return buildFallbackEnvelope(context);
  }

  private async tryGodCall(
    observations: Observation[],
    context: GodDecisionContext,
    isResuming: boolean,
  ): Promise<GodCallResult> {
    const userPrompt = isResuming
      ? buildResumePrompt(observations)
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
