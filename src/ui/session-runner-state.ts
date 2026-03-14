import type { ChoiceDetectionResult } from '../decision/choice-detector.js';
import type { WorkflowContext } from '../engine/workflow-machine.js';
import type { DegradationState } from '../god/degradation-manager.js';
import type { ConvergenceLogEntry } from '../god/god-convergence.js';
import type { RoundRecord } from '../session/context-manager.js';
import type { LoadedSession, SessionState } from '../session/session-manager.js';
import type { OutputChunk } from '../types/adapter.js';
import type { GodTaskAnalysis } from '../types/god-schemas.js';
import type { SessionConfig } from '../types/session.js';
import type { Message, RoleName } from '../types/ui.js';

export interface StreamAggregation {
  fullText: string;
  displayText: string;
  displayBodyText: string;
  errorMessages: string[];
  activeToolName: string | null;
  toolUpdateCount: number;
  toolWarningCount: number;
  latestToolSummary: string | null;
}

export type StreamOutcome =
  | { kind: 'success'; fullText: string; displayText: string }
  | { kind: 'error'; fullText: string; displayText: string; errorMessage: string }
  | { kind: 'no_output'; fullText: string; displayText: string };

export interface ChoiceRoute {
  source: 'coder' | 'reviewer';
  target: 'coder' | 'reviewer';
  prompt: string;
}

export interface RouteDecision {
  event: 'ROUTE_TO_REVIEW' | 'ROUTE_TO_EVALUATE' | 'ROUTE_TO_CODER';
  choiceRoute?: ChoiceRoute;
  clearChoiceRoute?: boolean;
}

export type UserDecision =
  | { type: 'confirm'; action: 'accept' | 'continue'; pendingInstruction?: string }
  | { type: 'resume'; input: string; resumeAs: 'coder' | 'reviewer' };

export type RestoreEventType =
  | 'RESTORED_TO_CODING'
  | 'RESTORED_TO_REVIEWING'
  | 'RESTORED_TO_WAITING'
  | 'RESTORED_TO_INTERRUPTED';

export interface RestoredSessionRuntime {
  workflowInput: Partial<WorkflowContext>;
  restoreEvent: RestoreEventType;
  messages: Message[];
  rounds: RoundRecord[];
  reviewerOutputs: string[];
  tokenCount: number;
  /** Persisted CLI session ID for the coder adapter */
  coderSessionId?: string;
  /** Persisted CLI session ID for the reviewer adapter */
  reviewerSessionId?: string;
  /** God task analysis restored from session (FR-011) */
  godTaskAnalysis?: GodTaskAnalysis;
  /** God convergence log restored from session (FR-011) */
  godConvergenceLog?: ConvergenceLogEntry[];
  /** God degradation state restored from session (FR-G01) */
  degradationState?: DegradationState;
  /** Current phase ID for compound tasks */
  currentPhaseId?: string | null;
}

interface ChoiceDetectorLike {
  detect(text: string): ChoiceDetectionResult;
  buildForwardPrompt(result: ChoiceDetectionResult, taskContext: string): string;
}

const CHARS_PER_TOKEN = 4;

export function createStreamAggregation(): StreamAggregation {
  return {
    fullText: '',
    displayText: '',
    displayBodyText: '',
    errorMessages: [],
    activeToolName: null,
    toolUpdateCount: 0,
    toolWarningCount: 0,
    latestToolSummary: null,
  };
}

export function applyOutputChunk(
  state: StreamAggregation,
  chunk: OutputChunk,
): StreamAggregation {
  let fullText = state.fullText;
  let displayBodyText = state.displayBodyText;
  const errorMessages = [...state.errorMessages];
  let activeToolName = state.activeToolName;
  let toolUpdateCount = state.toolUpdateCount;
  let toolWarningCount = state.toolWarningCount;
  let latestToolSummary = state.latestToolSummary;

  if (chunk.type === 'text' || chunk.type === 'code') {
    fullText = appendContent(fullText, chunk.content);
    displayBodyText = appendContent(displayBodyText, chunk.content);
  } else if (chunk.type === 'tool_use') {
    const toolName = (chunk.metadata?.tool as string) ?? 'Tool';
    const formatted = formatToolUse(toolName, chunk);
    activeToolName = toolName;
    toolUpdateCount += 1;
    latestToolSummary = formatted.displaySummary;
    fullText = appendLine(fullText, formatted.historyLine);
  } else if (chunk.type === 'tool_result') {
    const toolName = activeToolName ?? ((chunk.metadata?.tool as string) ?? 'Tool');
    toolUpdateCount += 1;
    if (chunk.metadata?.isError === true) {
      fullText = appendLine(fullText, `[${toolName} error] ${chunk.content}`);
      toolWarningCount += 1;
    } else {
      const lineCount = chunk.content.trim() === '' ? 0 : chunk.content.split('\n').length;
      fullText = appendLine(fullText, `[${toolName} result] ${lineCount} lines`);
    }
    activeToolName = null;
  } else if (chunk.type === 'error') {
    fullText = appendLine(fullText, `Error: ${chunk.content}`);
    displayBodyText = appendLine(displayBodyText, `**Error:** ${chunk.content}`);
    if (chunk.metadata?.fatal !== false) {
      errorMessages.push(chunk.content);
    }
  }

  const displayText = buildDisplayText(displayBodyText, {
    toolUpdateCount,
    toolWarningCount,
    latestToolSummary,
  });

  return {
    fullText,
    displayText,
    displayBodyText,
    errorMessages,
    activeToolName,
    toolUpdateCount,
    toolWarningCount,
    latestToolSummary,
  };
}

export function finalizeStreamAggregation(state: StreamAggregation): StreamOutcome {
  if (state.errorMessages.length > 0) {
    return {
      kind: 'error',
      fullText: state.fullText,
      displayText: state.displayText,
      errorMessage: state.errorMessages.join('\n'),
    };
  }

  if (state.fullText.trim() === '' && state.displayText.trim() === '') {
    return {
      kind: 'no_output',
      fullText: state.fullText,
      displayText: state.displayText,
    };
  }

  return {
    kind: 'success',
    fullText: state.fullText,
    displayText: state.displayText,
  };
}

export function resolveUserDecision(
  stateValue: string,
  text: string,
  lastInterruptedRole: 'coder' | 'reviewer' | null,
): UserDecision | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (stateValue === 'WAITING_USER' || stateValue === 'MANUAL_FALLBACK') {
    if (lower === 'a' || lower === 'accept') {
      return { type: 'confirm', action: 'accept' };
    }

    if (lower === 'c' || lower === 'continue') {
      return { type: 'confirm', action: 'continue' };
    }

    return {
      type: 'confirm',
      action: 'continue',
      pendingInstruction: trimmed,
    };
  }

  if (stateValue === 'INTERRUPTED' && trimmed) {
    return {
      type: 'resume',
      input: text,
      resumeAs: lastInterruptedRole ?? 'coder',
    };
  }

  return null;
}

export function decidePostCodeRoute(
  output: string,
  taskContext: string,
  detector: ChoiceDetectorLike,
  activeChoiceRoute: ChoiceRoute | null,
): RouteDecision {
  if (activeChoiceRoute?.source === 'reviewer' && activeChoiceRoute.target === 'coder') {
    return {
      event: 'ROUTE_TO_REVIEW',
      clearChoiceRoute: true,
    };
  }

  const detection = detector.detect(output);
  if (detection.detected) {
    return {
      event: 'ROUTE_TO_REVIEW',
      choiceRoute: createChoiceRoute('coder', taskContext, detector, detection),
    };
  }

  return { event: 'ROUTE_TO_REVIEW' };
}

export function decidePostReviewRoute(
  output: string,
  taskContext: string,
  detector: ChoiceDetectorLike,
  activeChoiceRoute: ChoiceRoute | null,
): RouteDecision {
  if (activeChoiceRoute?.source === 'coder' && activeChoiceRoute.target === 'reviewer') {
    return {
      event: 'ROUTE_TO_CODER',
      clearChoiceRoute: true,
    };
  }

  const detection = detector.detect(output);
  if (detection.detected) {
    return {
      event: 'ROUTE_TO_CODER',
      choiceRoute: createChoiceRoute('reviewer', taskContext, detector, detection),
    };
  }

  return { event: 'ROUTE_TO_EVALUATE' };
}

export function buildRestoredSessionRuntime(
  loaded: LoadedSession,
  config: SessionConfig,
): RestoredSessionRuntime {
  const history = [...loaded.history].sort((a, b) => a.timestamp - b.timestamp);
  const messages = history.map((entry) => toMessage(entry, config));
  const rounds = buildRounds(history);
  const reviewerOutputs = rounds
    .map((round) => round.reviewerOutput)
    .filter((output) => output.trim().length > 0);
  const tokenCount = Math.ceil(
    history.reduce((total, entry) => total + entry.content.length, 0) / CHARS_PER_TOKEN,
  );

  return {
    workflowInput: {
      round: loaded.state.round,
      sessionId: loaded.metadata.id,
      taskPrompt: loaded.metadata.task,
      lastCoderOutput: getLastRoleContent(history, 'coder'),
      lastReviewerOutput: getLastRoleContent(history, 'reviewer'),
      // BUG-16 fix: restore clarification context for CLARIFYING state resume
      ...(loaded.state.clarification ? {
        frozenActiveProcess: loaded.state.clarification.frozenActiveProcess,
        clarificationRound: loaded.state.clarification.clarificationRound,
      } : {}),
    },
    restoreEvent: mapRestoreEvent(loaded.state),
    messages,
    rounds,
    reviewerOutputs,
    tokenCount,
    coderSessionId: loaded.state.coderSessionId,
    reviewerSessionId: loaded.state.reviewerSessionId,
    godTaskAnalysis: loaded.state.godTaskAnalysis,
    godConvergenceLog: loaded.state.godConvergenceLog,
    degradationState: loaded.state.degradationState,
    currentPhaseId: loaded.state.currentPhaseId ?? null,
  };
}

function createChoiceRoute(
  source: 'coder' | 'reviewer',
  taskContext: string,
  detector: ChoiceDetectorLike,
  detection: ChoiceDetectionResult,
): ChoiceRoute {
  return {
    source,
    target: source === 'coder' ? 'reviewer' : 'coder',
    prompt: detector.buildForwardPrompt(detection, taskContext),
  };
}

function toMessage(
  entry: LoadedSession['history'][number],
  config: SessionConfig,
): Message {
  const isCoder = entry.role === 'coder';

  return {
    id: `restored-${entry.round}-${entry.role}-${entry.timestamp}`,
    role: (isCoder ? config.coder : config.reviewer) as RoleName,
    roleLabel: isCoder ? 'Coder' : 'Reviewer',
    content: entry.content,
    timestamp: entry.timestamp,
  };
}

function buildRounds(history: LoadedSession['history']): RoundRecord[] {
  const byRound = new Map<number, RoundRecord>();

  for (const entry of history) {
    const index = entry.round + 1;
    const existing = byRound.get(entry.round) ?? {
      index,
      coderOutput: '',
      reviewerOutput: '',
      timestamp: entry.timestamp,
    };

    if (entry.role === 'coder') {
      existing.coderOutput = entry.content;
    } else if (entry.role === 'reviewer') {
      existing.reviewerOutput = entry.content;
    }

    existing.timestamp = Math.max(existing.timestamp, entry.timestamp);
    byRound.set(entry.round, existing);
  }

  return [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, round]) => round);
}

function getLastRoleContent(
  history: LoadedSession['history'],
  role: 'coder' | 'reviewer',
): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === role) {
      return history[i].content;
    }
  }

  return null;
}

function appendLine(text: string, line: string): string {
  if (!line) {
    return text;
  }

  if (!text) {
    return line;
  }

  return `${text}\n${line}`;
}

function appendContent(text: string, content: string): string {
  if (!content) {
    return text;
  }

  if (!text) {
    return content;
  }

  const needsSeparator =
    !text.endsWith('\n')
    && !text.endsWith(':::')
    && !content.startsWith('\n');

  if (text.endsWith(':::') && !content.startsWith('\n')) {
    return `${text}\n${content}`;
  }

  return needsSeparator ? `${text}\n${content}` : `${text}${content}`;
}

function appendDisplayBlock(
  text: string,
  kind: 'activity' | 'result' | 'error',
  title: string,
  lines: string[],
): string {
  const block = `:::${kind} ${title}\n${lines.join('\n')}\n:::`;
  if (!text) {
    return block;
  }

  return `${text}\n\n${block}`;
}

function formatToolUse(
  toolName: string,
  chunk: OutputChunk,
): { historyLine: string; displaySummary: string } {
  const input =
    typeof chunk.metadata?.input === 'object' && chunk.metadata?.input !== null
      ? chunk.metadata.input as Record<string, unknown>
      : tryParseObject(chunk.content);

  if (toolName === 'Bash') {
    const description = asString(input?.description) ?? 'Run shell command';
    return {
      historyLine: `[Bash] ${description}`,
      displaySummary: `Bash: ${description}`,
    };
  }

  if (toolName === 'Read') {
    const filePath = asString(input?.file_path) ?? asString(input?.path) ?? chunk.content;
    const fileName = filePath.split('/').pop() ?? filePath;
    return {
      historyLine: `[Read] Read ${fileName}`,
      displaySummary: `Read: Read ${fileName}`,
    };
  }

  if (toolName === 'Explore') {
    const description = asString(input?.description) ?? 'Explore workspace';
    return {
      historyLine: `[Explore] ${description}`,
      displaySummary: `Explore: ${description}`,
    };
  }

  const summary = summarizeStructuredValue(input) ?? chunk.content;
  return {
    historyLine: `[${toolName}] ${summary.split('\n')[0]}`,
    displaySummary: `${toolName}: ${summary.split('\n')[0]}`,
  };
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function summarizeStructuredValue(value: Record<string, unknown> | null): string | null {
  if (!value) {
    return null;
  }

  return JSON.stringify(value, null, 2);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function buildDisplayText(
  bodyText: string,
  stats: {
    toolUpdateCount: number;
    toolWarningCount: number;
    latestToolSummary: string | null;
  },
): string {
  const lines: string[] = [];

  if (stats.toolUpdateCount > 0 && stats.latestToolSummary) {
    let summary = `⏺ ${stats.toolUpdateCount} tool updates`;
    if (stats.toolWarningCount > 0) {
      summary += ` · ${stats.toolWarningCount} warning`;
      if (stats.toolWarningCount > 1) {
        summary += 's';
      }
    }
    summary += ` · latest ${stats.latestToolSummary}`;
    lines.push(summary);
  }

  if (bodyText.trim()) {
    lines.push(bodyText);
  }

  return lines.join('\n');
}

function mapRestoreEvent(state: SessionState): RestoreEventType {
  switch (state.status) {
    case 'created':
    case 'coding':
      return 'RESTORED_TO_CODING';
    case 'reviewing':
    case 'routing_post_code':
      return 'RESTORED_TO_REVIEWING';
    case 'interrupted':
      return 'RESTORED_TO_INTERRUPTED';
    // BUG-16 fix: CLARIFYING state maps to INTERRUPTED so user can re-provide input
    case 'clarifying':
      return 'RESTORED_TO_INTERRUPTED';
    case 'god_deciding':
    case 'manual_fallback':
    case 'routing_post_review':
    case 'evaluating':
    case 'waiting_user':
    case 'error':
    case 'done':
    default:
      return 'RESTORED_TO_WAITING';
  }
}
