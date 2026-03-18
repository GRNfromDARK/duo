/**
 * App — Root Ink component for Duo.
 *
 * Two phases:
 * 1. Setup: interactive wizard when args are missing (dir → coder → reviewer → task)
 * 2. Session: orchestrates xstate workflow, adapters, and MainLayout
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, useStdout, useApp, useInput } from 'ink';
import { useMachine } from '@xstate/react';
import { workflowMachine, detectRoutingConflicts } from '../../engine/workflow-machine.js';
import type { WorkflowContext } from '../../engine/workflow-machine.js';
import { createAdapter } from '../../adapters/factory.js';
import { createGodAdapter } from '../../god/god-adapter-factory.js';
import { OutputStreamManager } from '../../adapters/output-stream-manager.js';
import { ContextManager } from '../../session/context-manager.js';
import type { RoundRecord } from '../../session/context-manager.js';
import { SessionManager } from '../../session/session-manager.js';
import type { LoadedSession } from '../../session/session-manager.js';
import { MainLayout } from './MainLayout.js';
import type { WorkflowStateHint } from './MainLayout.js';
import type { WorkflowStatus } from './StatusBar.js';
import { SetupWizard } from './SetupWizard.js';
import { createRoundSummaryMessage } from '../round-summary.js';
import type { SessionConfig } from '../../types/session.js';
import type { DetectedCLI } from '../../adapters/detect.js';
import type { CLIAdapter, OutputChunk } from '../../types/adapter.js';
import type { GodAdapter } from '../../types/god-adapter.js';
import type { Message, RoleName } from '../../types/ui.js';
import type { TimelineEvent } from './TimelineOverlay.js';
import {
  applyOutputChunk,
  buildRestoredSessionRuntime,
  createStreamAggregation,
  finalizeStreamAggregation,
  resolveUserDecision,
} from '../session-runner-state.js';
import * as path from 'node:path';
import { initializeTask } from '../../god/task-init.js';
import { buildGodSystemPrompt } from '../../god/god-system-prompt.js';
import { GodAuditLogger, logEnvelopeDecision } from '../../god/god-audit.js';
import { withRetry, isPaused } from '../god-fallback.js';
import type { GodTaskAnalysis, GodAutoDecision } from '../../types/god-schemas.js';
import type { GodDecisionEnvelope } from '../../types/god-envelope.js';
import { TaskAnalysisCard } from './TaskAnalysisCard.js';
import type { ConvergenceLogEntry } from '../../god/god-convergence.js';
import { generateCoderPrompt, generateReviewerPrompt, extractBlockingIssues } from '../../god/god-prompt-generator.js';
import type { PromptContext } from '../../god/god-prompt-generator.js';
import { GodDecisionBanner } from './GodDecisionBanner.js';
import { ReclassifyOverlay } from './ReclassifyOverlay.js';
import { PhaseTransitionBanner } from './PhaseTransitionBanner.js';
import { CompletionScreen } from './CompletionScreen.js';
import { canTriggerReclassify, writeReclassifyAudit } from '../reclassify-overlay.js';
import { classifyInterruptIntent } from '../../god/interrupt-clarifier.js';
import { buildContinuedTaskPrompt } from '../completion-flow.js';
import { resolveGlobalCtrlCAction } from '../global-ctrl-c.js';
import { performSafeShutdown } from '../safe-shutdown.js';
import { appendPromptLog } from '../../session/prompt-log.js';
import {
  processWorkerOutput,
  createProcessErrorObservation,
  createTimeoutObservation,
} from '../../god/observation-integration.js';
import { ProcessTimeoutError } from '../../adapters/process-manager.js';
import { classifyOutput, createObservation, deduplicateObservations } from '../../god/observation-classifier.js';
import { formatGodMessage } from '../god-message-style.js';
import { dispatchMessages, checkNLInvariantViolations } from '../../god/message-dispatcher.js';
import { GodDecisionService, type GodDecisionContext } from '../../god/god-decision-service.js';
import { WatchdogService } from '../../god/watchdog.js';
import { executeActions, type HandExecutionContext } from '../../god/hand-executor.js';

// ── Adapter session helpers (duck-typed to avoid modifying CLIAdapter interface) ──

interface SessionCapableAdapter {
  hasActiveSession(): boolean;
  getLastSessionId(): string | null;
  restoreSessionId(id: string): void;
}

function isSessionCapable(adapter: unknown): adapter is SessionCapableAdapter {
  return typeof adapter === 'object'
    && adapter !== null
    && 'hasActiveSession' in adapter
    && typeof (adapter as any).hasActiveSession === 'function'
    && 'getLastSessionId' in adapter
    && typeof (adapter as any).getLastSessionId === 'function'
    && 'restoreSessionId' in adapter
    && typeof (adapter as any).restoreSessionId === 'function';
}

// ── Props ──

export interface AppProps {
  initialConfig?: SessionConfig;
  detected: DetectedCLI[];
  resumeSession?: LoadedSession;
}

interface GlobalCtrlCHandlers {
  interrupt: () => void;
  safeExit: () => Promise<void> | void;
}

// ── Helper: map xstate state → UI status ──

function mapStateToStatus(stateValue: string): WorkflowStatus {
  switch (stateValue) {
    case 'CODING':
    case 'REVIEWING':
      return 'active';
    case 'GOD_DECIDING':
    case 'TASK_INIT':
    case 'OBSERVING':
    case 'EXECUTING':
      return 'routing';
    case 'MANUAL_FALLBACK':
      return 'interrupted';
    case 'INTERRUPTED':
      return 'interrupted';
    // Card E.2: CLARIFYING mapped to 'interrupted' visual status
    case 'CLARIFYING':
      return 'interrupted';
    case 'ERROR':
      return 'error';
    case 'DONE':
      return 'done';
    default:
      return 'idle';
  }
}

function getActiveAgentLabel(
  stateValue: string,
  config: SessionConfig,
  detected: DetectedCLI[],
): string | null {
  const findName = (name: string) =>
    detected.find((d) => d.name === name)?.displayName ?? name;

  if (stateValue === 'CODING') return `${findName(config.coder)}:Coder`;
  if (stateValue === 'REVIEWING') return `${findName(config.reviewer)}:Reviewer`;
  if (stateValue === 'TASK_INIT') return 'God:Init';
  if (stateValue === 'GOD_DECIDING') return 'God:Deciding';
  if (stateValue === 'OBSERVING') return 'God:Observing';
  if (stateValue === 'EXECUTING') return 'God:Executing';
  if (stateValue === 'CLARIFYING') return 'God:Clarifying';
  return null;
}

// ── Root App Component ──

export function App({ initialConfig, detected, resumeSession }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const hasFullConfig =
    initialConfig &&
    initialConfig.projectDir &&
    initialConfig.coder &&
    initialConfig.reviewer &&
    initialConfig.god &&
    initialConfig.task;

  const [sessionConfig, setSessionConfig] = useState<SessionConfig | null>(
    hasFullConfig ? initialConfig : null,
  );
  const [sessionRunKey, setSessionRunKey] = useState(0);
  const [activeResumeSession, setActiveResumeSession] = useState<LoadedSession | undefined>(
    resumeSession,
  );
  const globalCtrlCHandlersRef = useRef<GlobalCtrlCHandlers>({
    interrupt: () => {},
    safeExit: () => exit(),
  });
  const lastCtrlCRef = useRef(0);
  const safeExitInFlightRef = useRef(false);

  const { stdout } = useStdout();
  const columns = stdout.columns || 80;
  const rows = stdout.rows || 24;

  const registerGlobalCtrlCHandlers = useCallback((handlers: GlobalCtrlCHandlers | null) => {
    globalCtrlCHandlersRef.current = handlers ?? {
      interrupt: () => {},
      safeExit: () => exit(),
    };
  }, [exit]);

  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return;

    const result = resolveGlobalCtrlCAction(Date.now(), lastCtrlCRef.current);
    lastCtrlCRef.current = result.nextLastCtrlCAt;

    if (result.action === 'safe_exit') {
      if (safeExitInFlightRef.current) return;
      safeExitInFlightRef.current = true;
      void Promise.resolve(globalCtrlCHandlersRef.current.safeExit())
        .finally(() => {
          safeExitInFlightRef.current = false;
        });
      return;
    }

    globalCtrlCHandlersRef.current.interrupt();
  });

  // ── Setup Phase: use SetupWizard ──

  if (!sessionConfig) {
    return (
      <SetupWizard
        detected={detected}
        initialConfig={initialConfig}
        onComplete={(config) => setSessionConfig(config)}
      />
    );
  }

  // ── Session Phase ──

  return (
    <SessionRunner
      key={`${sessionRunKey}`}
      config={sessionConfig}
      detected={detected}
      columns={columns}
      rows={rows}
      resumeSession={activeResumeSession}
      registerGlobalCtrlCHandlers={registerGlobalCtrlCHandlers}
      onContinueCurrentTask={(followUp) => {
        setActiveResumeSession(undefined);
        setSessionConfig((prev) =>
          prev
            ? { ...prev, task: buildContinuedTaskPrompt(prev.task, followUp) }
            : prev,
        );
        setSessionRunKey((prev) => prev + 1);
      }}
      onCreateNewTask={(task) => {
        setActiveResumeSession(undefined);
        setSessionConfig((prev) =>
          prev
            ? { ...prev, task: task.trim() }
            : prev,
        );
        setSessionRunKey((prev) => prev + 1);
      }}
    />
  );
}

// ── Session Runner Component ──

interface SessionRunnerProps {
  config: SessionConfig;
  detected: DetectedCLI[];
  columns: number;
  rows: number;
  resumeSession?: LoadedSession;
  registerGlobalCtrlCHandlers: (handlers: GlobalCtrlCHandlers | null) => void;
  onContinueCurrentTask: (followUp: string) => void;
  onCreateNewTask: (task: string) => void;
}

function SessionRunner({
  config,
  detected,
  columns,
  rows,
  resumeSession,
  registerGlobalCtrlCHandlers,
  onContinueCurrentTask,
  onCreateNewTask,
}: SessionRunnerProps): React.ReactElement {
  const { exit } = useApp();
  const MAX_ROUNDS = 20;
  const restoredRuntime = resumeSession
    ? buildRestoredSessionRuntime(resumeSession, config)
    : null;

  // ── xstate actor ──
  const [snapshot, send] = useMachine(workflowMachine, {
    input: {
      maxRounds: MAX_ROUNDS,
      ...(restoredRuntime?.workflowInput ?? {}),
    },
  });

  const stateValue = snapshot.value as string;
  const ctx = snapshot.context as WorkflowContext;

  // ── Core services (stable refs) ──
  const coderAdapterRef = useRef<CLIAdapter>(createAdapter(config.coder));
  const reviewerAdapterRef = useRef<CLIAdapter>(createAdapter(config.reviewer));
  const godAdapterRef = useRef<GodAdapter>(createGodAdapter(config.god));
  const contextManagerRef = useRef(
    new ContextManager({
      contextWindowSize: 200000,
      promptsDir: path.join(config.projectDir, '.duo', 'prompts'),
    }),
  );
  const sessionManagerRef = useRef(
    new SessionManager(path.join(config.projectDir, '.duo', 'sessions')),
  );
  const outputManagerRef = useRef(new OutputStreamManager());
  const godAuditLoggerRef = useRef<GodAuditLogger | null>(null);

  // ── Mutable orchestration state ──
  const roundsRef = useRef<RoundRecord[]>(restoredRuntime?.rounds ?? []);
  const sessionIdRef = useRef<string | null>(
    (restoredRuntime?.workflowInput.sessionId as string | null) ?? null,
  );
  const reviewerOutputsRef = useRef<string[]>(restoredRuntime?.reviewerOutputs ?? []);
  const pendingInstructionRef = useRef<string | null>(null);
  const pendingReviewerInstructionRef = useRef<string | null>(null);
  const lastInterruptedRoleRef = useRef<'coder' | 'reviewer' | null>(
    resumeSession?.state.status === 'interrupted'
      ? (resumeSession.state.currentRole as 'coder' | 'reviewer' | null)
      : null,
  );
  const convergenceLogRef = useRef<ConvergenceLogEntry[]>(restoredRuntime?.godConvergenceLog ?? []);
  const lastUnresolvedIssuesRef = useRef<string[]>([]);
  const initializedRef = useRef(false);
  const auditSeqRef = useRef(0);
  // Card D.1: track which worker role just completed (for OBSERVING classification)
  const lastWorkerRoleRef = useRef<'coder' | 'reviewer'>('coder');
  /** Tracks whether Reviewer feedback has been consumed by Coder (Change 5) */
  const reviewerFeedbackPendingRef = useRef<boolean>(false);
  // Watchdog: simple retry+backoff+pause (no adapter needed)
  const watchdogRef = useRef(new WatchdogService());
  // Card D.1: unified God decision service instance (uses Watchdog for error recovery)
  const godDecisionServiceRef = useRef(
    new GodDecisionService(godAdapterRef.current, watchdogRef.current, config.godModel),
  );

  // ── God task analysis state ──
  const [taskAnalysis, setTaskAnalysis] = useState<GodTaskAnalysis | null>(restoredRuntime?.godTaskAnalysis ?? null);
  const taskAnalysisRef = useRef(taskAnalysis);
  taskAnalysisRef.current = taskAnalysis;
  const [showTaskAnalysisCard, setShowTaskAnalysisCard] = useState(false);

  // ── BUG-21 fix: reclassify trigger to re-run GOD_DECIDING auto-decision ──
  const [reclassifyTrigger, setReclassifyTrigger] = useState(0);

  // ── God auto-decision state ──
  // Currently unused since ESCAPE_WINDOW_MS=0 (instant execution bypasses the banner).
  // Kept for future re-enablement of the escape window.
  const [godDecision, setGodDecision] = useState<GodAutoDecision | null>(null);
  const [showGodBanner, setShowGodBanner] = useState(false);
  // Stores the pending envelope when GodDecisionBanner escape window is active
  const pendingEnvelopeRef = useRef<GodDecisionEnvelope | null>(null);

  // ── Reclassify overlay state (Ctrl+R) — Card C.3 ──
  const [showReclassify, setShowReclassify] = useState(false);

  // ── Phase transition banner state — Card C.3 ──
  const [showPhaseTransition, setShowPhaseTransition] = useState(false);
  const [pendingPhaseTransition, setPendingPhaseTransition] = useState<{
    nextPhaseId: string;
    previousPhaseSummary: string;
  } | null>(null);
  const [currentPhaseId, setCurrentPhaseId] = useState<string | null>(restoredRuntime?.currentPhaseId ?? null);

  // ── God latency tracking (StatusBar display) — Card D.2 ──
  const [godLatency, setGodLatency] = useState<number | undefined>(undefined);

  // ── UI state ──
  const [messages, setMessages] = useState<Message[]>(() => restoredRuntime?.messages ?? []);
  const [tokenCount, setTokenCount] = useState(() => restoredRuntime?.tokenCount ?? 0);
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  // Tracks whether interrupt intent classification is in progress (for indicator)
  const [isClassifyingIntent, setIsClassifyingIntent] = useState(false);

  // ── Unique message ID generator (session-scoped prefix + monotonic counter) ──
  const msgIdPrefix = useRef(`msg-${Date.now().toString(36)}`);
  const msgIdCounter = useRef(0);
  const nextMsgId = () => `${msgIdPrefix.current}-${++msgIdCounter.current}`;
  const getSessionDir = useCallback(
    () => path.join(config.projectDir, '.duo', 'sessions', sessionIdRef.current ?? 'unknown'),
    [config.projectDir],
  );

  // ── Helper: add a message ──
  const addMessage = useCallback(
    (msg: Omit<Message, 'id'>) => {
      const id = nextMsgId();
      setMessages((prev) => [...prev, { ...msg, id }]);
      return id;
    },
    [],
  );

  // ── Helper: update a message by ID ──
  const updateMessage = useCallback(
    (id: string, update: Partial<Message>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...update } : m)),
      );
    },
    [],
  );

  // ── Helper: add timeline event ──
  const addTimelineEvent = useCallback(
    (type: TimelineEvent['type'], description: string) => {
      setTimelineEvents((prev) => [
        ...prev,
        { timestamp: Date.now(), type, description },
      ]);
    },
    [],
  );

  // ── Helper: estimate tokens from text ──
  const estimateTokens = (text: string) => Math.ceil(text.length / 4);

  // ── Helper: get adapter display name (with optional model suffix) ──
  const getDisplayName = (adapterName: string) =>
    detected.find((d) => d.name === adapterName)?.displayName ?? adapterName;

  const formatRoleLabel = (adapterName: string, model?: string) => {
    const name = getDisplayName(adapterName);
    return model ? `${name} (${model})` : name;
  };

  // ── Create session on mount ──
  useEffect(() => {
    if (resumeSession && restoredRuntime) {
      addMessage({
        role: 'system',
        content: `Session resumed. Coder: ${formatRoleLabel(config.coder, config.coderModel)}, Reviewer: ${formatRoleLabel(config.reviewer, config.reviewerModel)}`,
        timestamp: Date.now(),
      });

      addTimelineEvent('task_start', `Session resumed: ${config.coder} vs ${config.reviewer}`);

      // Restore adapter CLI session IDs so they can use --resume on first execute
      if (restoredRuntime.coderSessionId) {
        const ca = coderAdapterRef.current;
        if (isSessionCapable(ca)) {
          ca.restoreSessionId(restoredRuntime.coderSessionId);
        }
      }
      if (restoredRuntime.reviewerSessionId) {
        const ra = reviewerAdapterRef.current;
        if (isSessionCapable(ra)) {
          ra.restoreSessionId(restoredRuntime.reviewerSessionId);
        }
      }
      // Restore God session ID for session-capable adapters (kill-and-resume pattern)
      if (restoredRuntime.godSessionId) {
        const ga = godAdapterRef.current;
        if (isSessionCapable(ga)) {
          ga.restoreSessionId(restoredRuntime.godSessionId);
        }
      }

      // Initialize God audit logger on resume so seq continues from last entry
      if (!godAuditLoggerRef.current && sessionIdRef.current) {
        const sessionDir = getSessionDir();
        godAuditLoggerRef.current = new GodAuditLogger(sessionDir);
        auditSeqRef.current = godAuditLoggerRef.current.getSequence();
      }

      send({ type: 'RESUME_SESSION', sessionId: resumeSession.metadata.id });
      send({ type: restoredRuntime.restoreEvent });
      initializedRef.current = true;
      return;
    }

    try {
      const { id } = sessionManagerRef.current.createSession(config);
      sessionIdRef.current = id;
    } catch {
      // Non-fatal: session persistence is best-effort
    }

    // Add initial system message
    addMessage({
      role: 'system',
      content: `Session started. Coder: ${formatRoleLabel(config.coder, config.coderModel)}, Reviewer: ${formatRoleLabel(config.reviewer, config.reviewerModel)}`,
      timestamp: Date.now(),
    });

    addTimelineEvent('task_start', `Session started: ${config.coder} vs ${config.reviewer}`);

    // Start the workflow
    send({ type: 'START_TASK', prompt: config.task });
    initializedRef.current = true;
  }, []);

  // ── TASK_INIT state: run God intent parsing ──
  // Uses withRetry for retry + backoff + pause
  useEffect(() => {
    if (stateValue !== 'TASK_INIT') return;

    let cancelled = false;

    // Initialize God audit logger if not yet created
    if (!godAuditLoggerRef.current && sessionIdRef.current) {
      const sessionDir = getSessionDir();
      godAuditLoggerRef.current = new GodAuditLogger(sessionDir);
    }

    // God paused → skip immediately
    if (!watchdogRef.current.isGodAvailable()) {
      addMessage({
        role: 'system',
        content: 'God orchestrator disabled. Skipping task analysis.',
        timestamp: Date.now(),
      });
      send({ type: 'TASK_INIT_SKIP' });
      return;
    }

    addMessage({
      role: 'system',
      content: `Analyzing task with God orchestrator (${getDisplayName(config.god)})...`,
      timestamp: Date.now(),
    });
    addTimelineEvent('task_start', `God TASK_INIT started: ${getDisplayName(config.god)}`);

    (async () => {
      const startTime = Date.now();

      const retryResult = await withRetry(
        async () => {
          const systemPrompt = buildGodSystemPrompt({
            task: config.task,
            coderName: getDisplayName(config.coder),
            reviewerName: getDisplayName(config.reviewer),
          });

          const r = await initializeTask(
            godAdapterRef.current,
            config.task,
            systemPrompt,
            config.projectDir,
            sessionIdRef.current ? getSessionDir() : undefined,
            config.godModel,
          );

          // Treat null result as schema_validation failure to trigger retry
          if (!r) throw new Error('TASK_INIT returned null (extraction/validation failed)');
          return r;
        },
        watchdogRef.current,
      );

      // TASK_INIT uses buildGodSystemPrompt (5 decision points format).
      // Unified decisions use SYSTEM_PROMPT (GodDecisionEnvelope format).
      // Clear the session so the first unified decision starts fresh
      // with its own system prompt instead of resuming TASK_INIT's session.
      godAdapterRef.current.clearSession?.();

      if (cancelled) return;

      if (!isPaused(retryResult)) {
        const result = retryResult.result;
        setTaskAnalysis(result.analysis);

        // Log to God audit + update StatusBar latency (Card D.2)
        const latency = Date.now() - startTime;
        setGodLatency(latency);
        if (godAuditLoggerRef.current) {
          godAuditLoggerRef.current.append({
            timestamp: new Date().toISOString(),
            round: 0,
            decisionType: 'TASK_INIT',
            inputSummary: config.task,
            outputSummary: `taskType=${result.analysis.taskType}, suggestedMaxRounds=${result.analysis.suggestedMaxRounds}`,
            latencyMs: latency,
            decision: result.analysis,
          }, result.analysis);
        }

        addTimelineEvent('task_start', `God TASK_INIT: ${result.analysis.taskType}, ${result.analysis.suggestedMaxRounds} rounds`);
        setShowTaskAnalysisCard(true);
      } else {
        // Paused — log failure to God audit
        if (godAuditLoggerRef.current) {
          godAuditLoggerRef.current.append({
            timestamp: new Date().toISOString(),
            round: 0,
            decisionType: 'TASK_INIT_FAILURE',
            inputSummary: config.task,
            outputSummary: `Paused: watchdog failures=${watchdogRef.current.getConsecutiveFailures()}`,
            latencyMs: Date.now() - startTime,
            decision: { godPaused: watchdogRef.current.isPaused() },
          });
        }

        addMessage({
          role: 'system',
          content: `God TASK_INIT failed after ${retryResult.retryCount} retries. System paused.`,
          timestamp: Date.now(),
        });
        addTimelineEvent('error', 'God TASK_INIT failed, system paused');
        send({ type: 'TASK_INIT_SKIP' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [stateValue]);

  // ── Save state on transitions ──
  useEffect(() => {
    if (!sessionIdRef.current || !initializedRef.current || stateValue === 'IDLE') return;
    try {
      const coderAdapter = coderAdapterRef.current;
      const reviewerAdapter = reviewerAdapterRef.current;
      sessionManagerRef.current.saveState(sessionIdRef.current, {
        round: ctx.round,
        status: stateValue.toLowerCase(),
        currentRole: ctx.activeProcess ?? 'coder',
        ...(isSessionCapable(coderAdapter) && coderAdapter.getLastSessionId()
          ? { coderSessionId: coderAdapter.getLastSessionId()! }
          : {}),
        ...(isSessionCapable(reviewerAdapter) && reviewerAdapter.getLastSessionId()
          ? { reviewerSessionId: reviewerAdapter.getLastSessionId()! }
          : {}),
        ...(isSessionCapable(godAdapterRef.current) && godAdapterRef.current.getLastSessionId()
          ? { godSessionId: godAdapterRef.current.getLastSessionId()! }
          : {}),
        ...(taskAnalysisRef.current ? { godTaskAnalysis: taskAnalysisRef.current } : {}),
        godConvergenceLog: convergenceLogRef.current,
        currentPhaseId,
        // Card E.2: persist clarification context for duo resume
        ...(stateValue === 'CLARIFYING' ? {
          clarification: {
            frozenActiveProcess: ctx.frozenActiveProcess,
            clarificationRound: ctx.clarificationRound,
          },
        } : {}),
      });
    } catch {
      // Best-effort persistence
    }
  }, [stateValue, ctx.round]);

  // ── CODING state: run coder adapter ──
  useEffect(() => {
    if (stateValue !== 'CODING') return;

    let cancelled = false;
    const adapter = coderAdapterRef.current;
    const osm = new OutputStreamManager();
    outputManagerRef.current = osm;

    const msgId = nextMsgId();
    setMessages((prev) => [
      ...prev,
      {
        id: msgId,
        role: config.coder as RoleName,
        roleLabel: 'Coder',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
      },
    ]);

    addTimelineEvent('coding', `Coder started: Round ${ctx.round + 1}, ${getDisplayName(config.coder)}`);

    (async () => {
      try {
        const interruptInstruction = pendingInstructionRef.current ?? undefined;
        pendingInstructionRef.current = null;
        const shouldSkipHistory = isSessionCapable(adapter) && adapter.hasActiveSession();

        // Prompt generation — direct call (pure template, no retry needed)
        if (!taskAnalysis) throw new Error('No taskAnalysis available');
        const prompt = generateCoderPrompt({
          taskType: taskAnalysis.taskType as PromptContext['taskType'],
          round: ctx.round,
          maxRounds: ctx.maxRounds,
          taskGoal: config.task,
          lastReviewerOutput: ctx.lastReviewerOutput ?? undefined,
          unresolvedIssues: lastUnresolvedIssuesRef.current,
          convergenceLog: convergenceLogRef.current,
          instruction: interruptInstruction,
          phaseId: currentPhaseId ?? undefined,
          phaseType: currentPhaseId
            ? taskAnalysis.phases?.find(p => p.id === currentPhaseId)?.type as PromptContext['phaseType']
            : undefined,
          isPostReviewerRouting: lastWorkerRoleRef.current === 'reviewer'
            || reviewerFeedbackPendingRef.current,
        }, {
          sessionDir: sessionIdRef.current
            ? path.join(config.projectDir, '.duo', 'sessions', sessionIdRef.current)
            : path.join(config.projectDir, '.duo', 'sessions'),
          seq: ++auditSeqRef.current,
        });
        const promptSource = 'god_dynamic';

        if (sessionIdRef.current) {
          try {
            appendPromptLog(getSessionDir(), {
              round: ctx.round,
              agent: 'coder',
              adapter: config.coder,
              kind: 'coder_round',
              prompt,
              systemPrompt: null,
              meta: {
                promptSource,
                phaseId: currentPhaseId,
                roleHint: config.coder === 'codex' ? 'coder' : undefined,
                hasInterruptInstruction: Boolean(interruptInstruction),
              },
            });
          } catch { /* best-effort */ }
        }

        const execOpts = {
          cwd: config.projectDir,
          permissionMode: 'skip' as const,
          model: config.coderModel,
        };

        // Codex adapter needs role hint
        let source: AsyncIterable<OutputChunk>;
        if (config.coder === 'codex') {
          const { CodexAdapter } = await import('../../adapters/codex/adapter.js');
          source = (adapter as InstanceType<typeof CodexAdapter>).execute(
            prompt,
            execOpts,
            { role: 'coder' },
          );
        } else {
          source = adapter.execute(prompt, execOpts);
        }

        osm.start(source);
        const consumer = osm.consume();
        let aggregation = createStreamAggregation();

        for await (const chunk of consumer) {
          if (cancelled) break;
          aggregation = applyOutputChunk(aggregation, chunk);
          updateMessage(msgId, { content: aggregation.displayText });
        }

        if (!cancelled) {
          const outcome = finalizeStreamAggregation(aggregation);

          if (outcome.kind === 'no_output') {
            // Process produced no output — likely a startup error
            updateMessage(msgId, { content: '(no output)', isStreaming: false });
            addMessage({
              role: 'system',
              content: `Coder (${getDisplayName(config.coder)}) produced no output. Check that the CLI tool is installed and configured correctly.`,
              timestamp: Date.now(),
            });
            addTimelineEvent('error', `Coder produced no output`);
            send({ type: 'PROCESS_ERROR', error: `No output received from ${config.coder}` });
          } else if (outcome.kind === 'error') {
            updateMessage(msgId, {
              content: outcome.displayText,
              isStreaming: false,
            });
            addTimelineEvent('error', `Coder failed: ${outcome.errorMessage}`);
            send({ type: 'PROCESS_ERROR', error: outcome.errorMessage });
          } else {
            const tokens = estimateTokens(outcome.fullText);
            setTokenCount((prev) => prev + tokens);
            updateMessage(msgId, {
              content: outcome.displayText,
              isStreaming: false,
              metadata: { tokenCount: tokens },
            });

            // Save history
            if (sessionIdRef.current) {
              try {
                sessionManagerRef.current.addHistoryEntry(sessionIdRef.current, {
                  round: ctx.round,
                  role: 'coder',
                  content: outcome.fullText,
                  timestamp: Date.now(),
                });
              } catch { /* best-effort */ }
            }

            // Card B.2: classify output through observation pipeline
            // Non-work outputs (quota_exhausted, auth_failed, etc.) must NOT trigger CODE_COMPLETE
            const { isWork, observation } = processWorkerOutput(
              outcome.fullText,
              'coder',
              { round: ctx.round, adapter: config.coder },
            );

            if (isWork) {
              lastWorkerRoleRef.current = 'coder';
              reviewerFeedbackPendingRef.current = false;
              addTimelineEvent('coding', `Coder completed: ${tokens} tokens`);
              send({ type: 'CODE_COMPLETE', output: outcome.fullText });
            } else {
              // Card D.1: Non-work output → route as incident through OBSERVING pipeline
              addTimelineEvent('error', `Coder non-work output: ${observation.type}`);
              addMessage({
                role: 'system',
                content: `Coder output classified as ${observation.type}: ${observation.summary}`,
                timestamp: Date.now(),
              });
              send({ type: 'INCIDENT_DETECTED', observation });
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          // BUG-9 fix: capture observation return value and route via INCIDENT_DETECTED
          const observation = err instanceof ProcessTimeoutError
            ? createTimeoutObservation(ctx.round, { adapter: config.coder })
            : createProcessErrorObservation(errorMsg, ctx.round, { adapter: config.coder });
          addMessage({
            role: 'system',
            content: `Coder error: ${errorMsg}`,
            timestamp: Date.now(),
          });
          send({ type: 'INCIDENT_DETECTED', observation });
        }
      }
    })();

    return () => {
      cancelled = true;
      osm.interrupt();
    };
  }, [stateValue === 'CODING' ? `CODING-${ctx.round}` : stateValue, config.task]);

  // ── OBSERVING: classify output, collect observations, send OBSERVATIONS_READY ──
  // Card D.1: replaces ROUTING_POST_CODE + ROUTING_POST_REVIEW + EVALUATING
  useEffect(() => {
    if (stateValue !== 'OBSERVING') return;

    // If observations already populated (from INCIDENT_DETECTED), forward them
    if (ctx.currentObservations.length > 0) {
      addTimelineEvent('coding', `Observation forwarded: ${ctx.currentObservations.map(o => o.type).join(', ')}`);
      send({ type: 'OBSERVATIONS_READY', observations: ctx.currentObservations });
      return;
    }

    // Determine which output to classify based on last completed worker role
    const source = lastWorkerRoleRef.current;
    const output = source === 'reviewer' ? ctx.lastReviewerOutput : ctx.lastCoderOutput;

    if (!output) {
      send({ type: 'PROCESS_ERROR', error: 'No output available for observation' });
      return;
    }

    // Classify output into a typed Observation (pure sync, < 5ms)
    const observation = classifyOutput(
      output,
      source === 'reviewer' ? 'reviewer' : 'coder',
      {
        round: ctx.round,
        phaseId: currentPhaseId ?? undefined,
        adapter: source === 'reviewer' ? config.reviewer : config.coder,
      },
    );

    // Record round summary after reviewer output (preserves old EVALUATING behavior)
    if (source === 'reviewer') {
      roundsRef.current.push({
        index: ctx.round + 1,
        coderOutput: ctx.lastCoderOutput ?? '',
        reviewerOutput: output,
        summary: contextManagerRef.current.generateSummary(output),
        timestamp: Date.now(),
      });

      const summaryMsg = createRoundSummaryMessage(
        ctx.round + 1,
        ctx.round + 2,
        contextManagerRef.current.generateSummary(output).slice(0, 100),
      );
      setMessages((prev) => [...prev, summaryMsg]);

      // Track reviewer outputs for loop detection
      // (already pushed in REVIEWING hook, but convergence log needs update)
    }

    addTimelineEvent('coding', `Observation: ${observation.type} from ${source}`);
    send({ type: 'OBSERVATIONS_READY', observations: [observation] });
  }, [stateValue]);

  // ── REVIEWING state: run reviewer adapter ──
  useEffect(() => {
    if (stateValue !== 'REVIEWING') return;

    let cancelled = false;
    const adapter = reviewerAdapterRef.current;
    const osm = new OutputStreamManager();
    outputManagerRef.current = osm;

    const msgId = nextMsgId();
    setMessages((prev) => [
      ...prev,
      {
        id: msgId,
        role: config.reviewer as RoleName,
        roleLabel: 'Reviewer',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
      },
    ]);

    addTimelineEvent('reviewing', `Reviewer started: Round ${ctx.round + 1}, ${getDisplayName(config.reviewer)}`);

    (async () => {
      try {
        // BUG-11 fix: prefer God's reviewer instruction over generic pending instruction
        const interruptInstruction = pendingReviewerInstructionRef.current ?? pendingInstructionRef.current ?? undefined;
        pendingReviewerInstructionRef.current = null;
        pendingInstructionRef.current = null;
        const shouldSkipHistory = isSessionCapable(adapter) && adapter.hasActiveSession();
        // Get the last reviewer output for feedback checklist (round 2+)
        const lastReviewerOut = reviewerOutputsRef.current.length > 0
          ? reviewerOutputsRef.current[reviewerOutputsRef.current.length - 1]
          : undefined;

        // Prompt generation — direct call (pure template, no retry needed)
        if (!taskAnalysis) throw new Error('No taskAnalysis available');
        const prompt = generateReviewerPrompt({
          taskType: taskAnalysis.taskType,
          round: ctx.round,
          maxRounds: ctx.maxRounds,
          taskGoal: config.task,
          lastCoderOutput: ctx.lastCoderOutput ?? undefined,
          instruction: interruptInstruction,
          phaseId: currentPhaseId ?? undefined,
          phaseType: currentPhaseId
            ? taskAnalysis.phases?.find(p => p.id === currentPhaseId)?.type as PromptContext['phaseType']
            : undefined,
        });
        const promptSource = 'god_dynamic';

        if (sessionIdRef.current) {
          try {
            appendPromptLog(getSessionDir(), {
              round: ctx.round,
              agent: 'reviewer',
              adapter: config.reviewer,
              kind: 'reviewer_round',
              prompt,
              systemPrompt: null,
              meta: {
                promptSource,
                phaseId: currentPhaseId,
                roleHint: config.reviewer === 'codex' ? 'reviewer' : undefined,
                hasInterruptInstruction: Boolean(interruptInstruction),
              },
            });
          } catch { /* best-effort */ }
        }

        const execOpts = {
          cwd: config.projectDir,
          permissionMode: 'skip' as const,
          model: config.reviewerModel,
        };

        let source: AsyncIterable<OutputChunk>;
        if (config.reviewer === 'codex') {
          const { CodexAdapter } = await import('../../adapters/codex/adapter.js');
          source = (adapter as InstanceType<typeof CodexAdapter>).execute(
            prompt,
            execOpts,
            { role: 'reviewer' },
          );
        } else {
          source = adapter.execute(prompt, execOpts);
        }

        osm.start(source);
        const consumer = osm.consume();
        let aggregation = createStreamAggregation();

        for await (const chunk of consumer) {
          if (cancelled) break;
          aggregation = applyOutputChunk(aggregation, chunk);
          updateMessage(msgId, { content: aggregation.displayText });
        }

        if (!cancelled) {
          const outcome = finalizeStreamAggregation(aggregation);

          if (outcome.kind === 'no_output') {
            updateMessage(msgId, { content: '(no output)', isStreaming: false });
            addMessage({
              role: 'system',
              content: `Reviewer (${getDisplayName(config.reviewer)}) produced no output. Check that the CLI tool is installed and configured correctly.`,
              timestamp: Date.now(),
            });
            addTimelineEvent('error', `Reviewer produced no output`);
            send({ type: 'PROCESS_ERROR', error: `No output received from ${config.reviewer}` });
          } else if (outcome.kind === 'error') {
            updateMessage(msgId, {
              content: outcome.displayText,
              isStreaming: false,
            });
            addTimelineEvent('error', `Reviewer failed: ${outcome.errorMessage}`);
            send({ type: 'PROCESS_ERROR', error: outcome.errorMessage });
          } else {
            const tokens = estimateTokens(outcome.fullText);
            setTokenCount((prev) => prev + tokens);
            updateMessage(msgId, {
              content: outcome.displayText,
              isStreaming: false,
              metadata: { tokenCount: tokens },
            });

            // Save history
            if (sessionIdRef.current) {
              try {
                sessionManagerRef.current.addHistoryEntry(sessionIdRef.current, {
                  round: ctx.round,
                  role: 'reviewer',
                  content: outcome.fullText,
                  timestamp: Date.now(),
                });
              } catch { /* best-effort */ }
            }

            // Track reviewer outputs for loop detection
            reviewerOutputsRef.current.push(outcome.fullText);

            // Card B.2: classify output through observation pipeline
            // Non-work outputs (quota_exhausted, auth_failed, etc.) must NOT trigger REVIEW_COMPLETE
            const { isWork, observation } = processWorkerOutput(
              outcome.fullText,
              'reviewer',
              { round: ctx.round, adapter: config.reviewer },
            );

            if (isWork) {
              lastWorkerRoleRef.current = 'reviewer';
              reviewerFeedbackPendingRef.current = true;
              addTimelineEvent('reviewing', `Reviewer completed: ${tokens} tokens`);
              send({ type: 'REVIEW_COMPLETE', output: outcome.fullText });
            } else {
              // Card D.1: Non-work output → route as incident through OBSERVING pipeline
              addTimelineEvent('error', `Reviewer non-work output: ${observation.type}`);
              addMessage({
                role: 'system',
                content: `Reviewer output classified as ${observation.type}: ${observation.summary}`,
                timestamp: Date.now(),
              });
              send({ type: 'INCIDENT_DETECTED', observation });
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          // BUG-9 fix: capture observation return value and route via INCIDENT_DETECTED
          const observation = err instanceof ProcessTimeoutError
            ? createTimeoutObservation(ctx.round, { adapter: config.reviewer })
            : createProcessErrorObservation(errorMsg, ctx.round, { adapter: config.reviewer });
          addMessage({
            role: 'system',
            content: `Reviewer error: ${errorMsg}`,
            timestamp: Date.now(),
          });
          send({ type: 'INCIDENT_DETECTED', observation });
        }
      }
    })();

    return () => {
      cancelled = true;
      osm.interrupt();
    };
  }, [stateValue === 'REVIEWING' ? `REVIEWING-${ctx.round}` : stateValue, config.task]);

  // ── DONE state ──
  useEffect(() => {
    if (stateValue !== 'DONE') return;

    addMessage({
      role: 'system',
      content: 'Session completed. Choose what to do next: continue this task, create a new task, or exit Duo.',
      timestamp: Date.now(),
    });
    addTimelineEvent('converged', 'Session completed');
  }, [stateValue]);

  // ── ERROR state ──
  useEffect(() => {
    if (stateValue !== 'ERROR') return;

    addMessage({
      role: 'system',
      content: `Error: ${ctx.lastError ?? 'Unknown error'}. Type a message to recover.`,
      timestamp: Date.now(),
    });
    addTimelineEvent('error', `Error: ${ctx.lastError ?? 'Unknown'}`);

    // Auto-recover to GOD_DECIDING / MANUAL_FALLBACK handling
    send({ type: 'RECOVERY' });
  }, [stateValue]);

  // ── GOD_DECIDING: unified God decision → DECISION_READY ──
  // Card D.1: replaces old auto-decision with GodDecisionService.makeDecision()
  useEffect(() => {
    if (stateValue !== 'GOD_DECIDING') return;

    if (showPhaseTransition) return;

    setGodDecision(null);
    setShowGodBanner(false);

    const manualWaitingMsg = 'Waiting for your decision. Type [c] to continue, [a] to accept, or enter new instructions.';

    if (!watchdogRef.current.isGodAvailable()) {
      send({ type: 'MANUAL_FALLBACK_REQUIRED' } as any);
      addMessage({
        role: 'system',
        content: `God unavailable. ${manualWaitingMsg}`,
        timestamp: Date.now(),
      });
      return;
    }

    let cancelled = false;

    // Bug 4 fix: GOD_DECIDING timeout — fallback to MANUAL_FALLBACK if God hangs
    const GOD_DECIDING_TIMEOUT_MS = 610_000; // ~10 minutes, must exceed adapter GOD_TIMEOUT_MS (600s)
    const timeoutId = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      addMessage({
        role: 'system',
        content: `God decision timed out after ${GOD_DECIDING_TIMEOUT_MS / 1000}s. ${manualWaitingMsg}`,
        timestamp: Date.now(),
      });
      // Record timeout in Watchdog state
      watchdogRef.current.shouldRetry();
      send({ type: 'MANUAL_FALLBACK_REQUIRED' } as any);
    }, GOD_DECIDING_TIMEOUT_MS);

    (async () => {
      try {
        const godCallStart = Date.now();
        const service = godDecisionServiceRef.current;

        // Bug 11 fix: inject phase plan so God can follow phase sequence
        const currentPhaseType = currentPhaseId && taskAnalysisRef.current?.phases
          ? taskAnalysisRef.current.phases.find(p => p.id === currentPhaseId)?.type as GodDecisionContext['currentPhaseType']
          : undefined;

        const decisionContext: GodDecisionContext = {
          taskGoal: config.task,
          currentPhaseId: currentPhaseId ?? 'default',
          currentPhaseType,
          phases: taskAnalysisRef.current?.phases ?? undefined,
          round: ctx.round,
          maxRounds: ctx.maxRounds,
          previousDecisions: ctx.lastDecision ? [ctx.lastDecision] : [],
          availableAdapters: [config.coder, config.reviewer],
          activeRole: ctx.activeProcess,
          sessionDir: getSessionDir(),
        };

        // Determine if God adapter has an active session (resume mode → slim prompt)
        const godIsResuming = isSessionCapable(godAdapterRef.current)
          && godAdapterRef.current.hasActiveSession();

        // Merge clarification history with current observations, deduplicating
        // since clarificationObservations already includes current-round observations
        const allObservations = deduplicateObservations([
          ...ctx.clarificationObservations,
          ...ctx.currentObservations,
        ]);
        const envelope = await service.makeDecision(allObservations, decisionContext, godIsResuming);

        if (cancelled) return;
        clearTimeout(timeoutId);

        setGodLatency(Date.now() - godCallStart);

        // Log decision to UI
        const actionSummary = envelope.actions.map(a => a.type).join(', ') || 'no actions';
        addMessage({
          role: 'system',
          content: `God decision: ${envelope.diagnosis.summary} [${actionSummary}]`,
          timestamp: Date.now(),
        });
        addTimelineEvent('coding', `God decision: ${actionSummary}`);

        // BUG-7/8 fix: Route ALL envelope messages via dispatchMessages (Card C.3)
        const dispatchResult = dispatchMessages(envelope.messages, {
          pendingCoderMessage: pendingInstructionRef.current,
          // BUG-17 fix: pass current ref value instead of null (consistent with pendingCoderMessage)
          pendingReviewerMessage: pendingReviewerInstructionRef.current,
          displayToUser: (message: string) => {
            addMessage({ role: 'system', content: message, timestamp: Date.now() });
          },
          auditLogger: godAuditLoggerRef.current!,
          round: ctx.round,
        });

        // Apply dispatched pending messages
        if (dispatchResult.pendingCoderMessage) {
          pendingInstructionRef.current = dispatchResult.pendingCoderMessage;
        }
        // BUG-11 fix: save reviewer pending message from dispatch
        if (dispatchResult.pendingReviewerMessage) {
          pendingReviewerInstructionRef.current = dispatchResult.pendingReviewerMessage;
        }

        // BUG-7/8 fix: Run NL invariant checks (Card D.3, FR-016)
        const nlViolations = checkNLInvariantViolations(
          envelope.messages,
          envelope.actions,
          { round: ctx.round, phaseId: envelope.diagnosis.currentPhaseId },
        );
        for (const violation of nlViolations) {
          addMessage({
            role: 'system',
            content: `NL invariant violation: ${violation.summary}`,
            timestamp: Date.now(),
          });
        }

        // BUG-7/8 fix: Log complete envelope decision audit (Card F.2)
        if (godAuditLoggerRef.current) {
          logEnvelopeDecision(godAuditLoggerRef.current, {
            round: ctx.round,
            observations: ctx.currentObservations,
            envelope,
            executionResults: [],
          });
        }

        // GodDecisionBanner is configured for instant execution (ESCAPE_WINDOW_MS=0),
        // so we send DECISION_READY directly without routing through the visual banner.
        // To re-enable the escape window, set ESCAPE_WINDOW_MS > 0 in god-decision-banner.ts
        // and route through setShowGodBanner(true) + pendingEnvelopeRef here.
        send({ type: 'DECISION_READY', envelope });
      } catch (err) {
        clearTimeout(timeoutId);
        if (cancelled) return;

        addMessage({
          role: 'system',
          content: `God decision failed: ${err instanceof Error ? err.message : String(err)}. ${manualWaitingMsg}`,
          timestamp: Date.now(),
        });
        send({ type: 'MANUAL_FALLBACK_REQUIRED' } as any);
      }
    })();

    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, [stateValue, showPhaseTransition, reclassifyTrigger]);

  // ── EXECUTING: run GodActions via Hand executor, send EXECUTION_COMPLETE ──
  // Card D.1: Hand executor runs actions sequentially, results flow back as observations
  useEffect(() => {
    if (stateValue !== 'EXECUTING') return;

    const envelope = ctx.lastDecision;
    if (!envelope) {
      send({ type: 'PROCESS_ERROR', error: 'No decision envelope in EXECUTING state' });
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const handContext: HandExecutionContext = {
          currentPhaseId: currentPhaseId ?? 'default',
          pendingCoderMessage: pendingInstructionRef.current,
          pendingReviewerMessage: null,
          adapters: new Map<string, { kill(): Promise<void> }>([
            ['coder', coderAdapterRef.current],
            ['reviewer', reviewerAdapterRef.current],
          ]),
          auditLogger: godAuditLoggerRef.current,
          activeRole: ctx.activeProcess,
          taskCompleted: false,
          waitState: { active: false, reason: null, estimatedSeconds: null },
          clarificationState: { active: false, question: null },
          interruptResumeStrategy: null,
          adapterConfig: new Map([
            ['coder', config.coder],
            ['reviewer', config.reviewer],
          ]),
          round: ctx.round,
          sessionDir: getSessionDir(),
          cwd: config.projectDir,
          // BUG-15 fix: pass envelope messages so accept_task D.3 validation runs
          envelopeMessages: envelope.messages,
        };

        const results = await executeActions(envelope.actions, handContext);

        if (cancelled) return;

        // Change 2: populate unresolvedIssues from reviewer output when post-reviewer routing
        if (lastWorkerRoleRef.current === 'reviewer' && ctx.lastReviewerOutput) {
          lastUnresolvedIssuesRef.current = extractBlockingIssues(ctx.lastReviewerOutput);
        }

        // Apply side effects from hand executor back to orchestration state
        if (handContext.pendingCoderMessage && handContext.pendingCoderMessage !== pendingInstructionRef.current) {
          pendingInstructionRef.current = handContext.pendingCoderMessage;
        }
        // BUG-11 fix: save reviewer pending message from hand executor
        if (handContext.pendingReviewerMessage && handContext.pendingReviewerMessage !== pendingReviewerInstructionRef.current) {
          pendingReviewerInstructionRef.current = handContext.pendingReviewerMessage;
        }
        if (handContext.currentPhaseId !== (currentPhaseId ?? 'default')) {
          addMessage({
            role: 'system',
            content: `→ Phase transition: ${currentPhaseId ?? 'default'} → ${handContext.currentPhaseId}`,
            timestamp: Date.now(),
          });
          setCurrentPhaseId(handContext.currentPhaseId);
          // Bug 3 fix: clear unresolvedIssues on phase transition
          lastUnresolvedIssuesRef.current = [];
          reviewerFeedbackPendingRef.current = false;
        }

        // Bug 3 fix: clear unresolvedIssues on accept_task or convergence
        if (handContext.taskCompleted || envelope.actions.some(a => a.type === 'accept_task')) {
          lastUnresolvedIssuesRef.current = [];
          reviewerFeedbackPendingRef.current = false;
          if (envelope.actions.some(a => a.type === 'accept_task')) {
            addMessage({
              role: 'system',
              content: '✓ Task accepted by God',
              timestamp: Date.now(),
            });
          }
        }

        // Card E.2: Display God's clarification question with styled formatting
        if (handContext.clarificationState.active && handContext.clarificationState.question) {
          const clarificationLines = formatGodMessage(
            handContext.clarificationState.question,
            'clarification',
          );
          const roundLabel = ctx.clarificationRound > 0
            ? ` (round ${ctx.clarificationRound + 1})`
            : '';
          addMessage({
            role: 'system',
            content: clarificationLines.join('\n') + roundLabel,
            timestamp: Date.now(),
          });
        }

        // BUG-12 fix: detect conflicting routing actions in envelope
        const routingConflicts = detectRoutingConflicts(envelope);
        if (routingConflicts.length > 0) {
          const conflictObs: import('../../types/observation.js').Observation = {
            source: 'runtime',
            type: 'runtime_invariant_violation',
            summary: `Multiple routing actions in single envelope: [${routingConflicts.join(', ')}]. Only first will be used for routing.`,
            severity: 'warning',
            timestamp: new Date().toISOString(),
            round: ctx.round,
            phaseId: currentPhaseId ?? 'default',
          };
          results.push(conflictObs);
          addMessage({
            role: 'system',
            content: `Warning: ${conflictObs.summary}`,
            timestamp: Date.now(),
          });
        }

        const actionSummary = envelope.actions.map(a => a.type).join(', ');
        addTimelineEvent('coding', `Executed: ${actionSummary}`);

        // Bug 6 fix: apply actual delay for wait action to prevent hot loop
        if (handContext.waitState.active) {
          const waitSeconds = Math.min(
            Math.max(handContext.waitState.estimatedSeconds ?? 10, 5),
            60,
          ); // clamp to 5-60 seconds
          addMessage({
            role: 'system',
            content: `God: waiting ${waitSeconds}s — ${handContext.waitState.reason ?? 'pending'}`,
            timestamp: Date.now(),
          });
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, waitSeconds * 1000);
            // Allow cancellation during wait
            const checkCancelled = setInterval(() => {
              if (cancelled) { clearTimeout(timer); clearInterval(checkCancelled); resolve(); }
            }, 500);
            // Clean up interval when timer completes
            setTimeout(() => clearInterval(checkCancelled), waitSeconds * 1000 + 100);
          });
          if (cancelled) return;
        }

        send({ type: 'EXECUTION_COMPLETE', results });
      } catch (err) {
        if (cancelled) return;
        send({ type: 'PROCESS_ERROR', error: `Execution error: ${err instanceof Error ? err.message : String(err)}` });
      }
    })();

    return () => { cancelled = true; };
  }, [stateValue]);

  // ── Handle user input ──
  const handleInputSubmit = useCallback(
    (text: string) => {
      // Add user message
      addMessage({
        role: 'user',
        content: text,
        timestamp: Date.now(),
      });

      if (stateValue === 'CODING' || stateValue === 'REVIEWING') {
        // Text interrupt: kill current process, then resume
        const adapter =
          stateValue === 'CODING'
            ? coderAdapterRef.current
            : reviewerAdapterRef.current;
        const resumeAs = stateValue === 'CODING' ? 'coder' : 'reviewer';
        lastInterruptedRoleRef.current = resumeAs;
        pendingInstructionRef.current = text;

        outputManagerRef.current.interrupt();
        adapter.kill().catch(() => {});

        const bufferedText = outputManagerRef.current.getBufferedText();
        addMessage({
          role: 'system',
          content: `Interrupted (${bufferedText.length} chars captured). Processing your instruction...`,
          timestamp: Date.now(),
        });

        send({ type: 'USER_INTERRUPT' });
        // xstate v5 queues events — USER_INPUT is processed after INTERRUPTED transition
        send({ type: 'USER_INPUT', input: text, resumeAs });
        return;
      }

      if (stateValue === 'MANUAL_FALLBACK') {
        const decision = resolveUserDecision(
          stateValue,
          text,
          lastInterruptedRoleRef.current,
        );
        if (decision?.type === 'confirm') {
          if (decision.pendingInstruction) {
            pendingInstructionRef.current = decision.pendingInstruction;
          }
          send({ type: 'USER_CONFIRM', action: decision.action });
        }
        return;
      }

      if (stateValue === 'INTERRUPTED') {
        const interruptContext = {
          userInput: text,
          taskGoal: config.task,
          round: ctx.round,
          currentPhaseId: currentPhaseId ?? undefined,
          lastCoderOutput: ctx.lastCoderOutput?.slice(0, 1000) ?? undefined,
          lastReviewerOutput: ctx.lastReviewerOutput?.slice(0, 1000) ?? undefined,
          sessionDir: path.join(config.projectDir, '.duo', 'sessions', sessionIdRef.current ?? 'unknown'),
          seq: ++auditSeqRef.current,
          projectDir: config.projectDir,
        };

        if (watchdogRef.current.isGodAvailable()) {
          setIsClassifyingIntent(true);
          void (async () => {
            try {
              const classification = await classifyInterruptIntent(
                godAdapterRef.current,
                interruptContext,
                config.godModel,
              );

              if (classification.needsClarification) {
                addMessage({
                  role: 'system',
                  content: `God asks: ${classification.instruction}`,
                  timestamp: Date.now(),
                });
                return;
              }

              pendingInstructionRef.current = classification.instruction;

              if (classification.intent === 'restart') {
                lastUnresolvedIssuesRef.current = [];
                setPendingPhaseTransition(null);
                setShowPhaseTransition(false);
                addMessage({
                  role: 'system',
                  content: `God: restarting current attempt - ${classification.instruction}`,
                  timestamp: Date.now(),
                });
                send({ type: 'OBSERVATIONS_READY', observations: [createObservation('clarification_answer', 'human', classification.instruction, { round: ctx.round, severity: 'info', rawRef: classification.instruction })] });
                return;
              }

              addMessage({
                role: 'system',
                content: `God: ${classification.intent} - ${classification.instruction}`,
                timestamp: Date.now(),
              });
              send({ type: 'OBSERVATIONS_READY', observations: [createObservation('clarification_answer', 'human', classification.instruction, { round: ctx.round, severity: 'info', rawRef: classification.instruction })] });
            } catch {
              pendingInstructionRef.current = text;
              send({ type: 'OBSERVATIONS_READY', observations: [createObservation('clarification_answer', 'human', text, { round: ctx.round, severity: 'info', rawRef: text })] });
            } finally {
              setIsClassifyingIntent(false);
            }
          })();
        } else {
          pendingInstructionRef.current = text;
          send({ type: 'OBSERVATIONS_READY', observations: [createObservation('clarification_answer', 'human', text, { round: ctx.round, severity: 'info', rawRef: text })] });
        }
        return;
      }

      // Card E.2: CLARIFYING — user answers God's clarification question
      if (stateValue === 'CLARIFYING') {
        const obs = createObservation('clarification_answer', 'human', text, {
          round: ctx.round,
          severity: 'info',
          rawRef: text,
        });
        send({ type: 'OBSERVATIONS_READY', observations: [obs] });
        return;
      }
    },
    [stateValue, send, addMessage],
  );

  // ── Handle Ctrl+C interrupt ──
  const handleInterrupt = useCallback(() => {
    // Single Ctrl+C: interrupt current process
    if (stateValue === 'CODING' || stateValue === 'REVIEWING') {
      const adapter =
        stateValue === 'CODING'
          ? coderAdapterRef.current
          : reviewerAdapterRef.current;
      lastInterruptedRoleRef.current = stateValue === 'CODING' ? 'coder' : 'reviewer';

      outputManagerRef.current.interrupt();
      adapter.kill().catch(() => {});

      const bufferedText = outputManagerRef.current.getBufferedText();
      addMessage({
        role: 'system',
        content: `Interrupted (${bufferedText.length} chars captured). Enter new instructions or press Ctrl+C again to exit.`,
        timestamp: Date.now(),
      });
      addTimelineEvent('interrupted', `User interrupt: ${bufferedText.length} chars`);
      send({ type: 'USER_INTERRUPT' });
    }
  }, [stateValue, ctx, send, exit, addMessage, addTimelineEvent]);

  const saveStateForExit = useCallback(() => {
    if (!sessionIdRef.current) return;

    try {
      const ca = coderAdapterRef.current;
      const ra = reviewerAdapterRef.current;
      sessionManagerRef.current.saveState(sessionIdRef.current, {
        round: ctx.round,
        status: stateValue === 'DONE' ? 'done' : 'interrupted',
        currentRole: ctx.activeProcess ?? 'coder',
        ...(isSessionCapable(ca) && ca.getLastSessionId()
          ? { coderSessionId: ca.getLastSessionId()! }
          : {}),
        ...(isSessionCapable(ra) && ra.getLastSessionId()
          ? { reviewerSessionId: ra.getLastSessionId()! }
          : {}),
        ...(() => {
          const ga = godAdapterRef.current;
          return isSessionCapable(ga) && ga.getLastSessionId()
            ? { godSessionId: ga.getLastSessionId()! }
            : {};
        })(),
        ...(taskAnalysisRef.current ? { godTaskAnalysis: taskAnalysisRef.current } : {}),
        godConvergenceLog: convergenceLogRef.current,
        currentPhaseId,
      });
    } catch {
      // Best-effort persistence before exit.
    }
  }, [ctx.round, ctx.activeProcess, stateValue, currentPhaseId]);

  const handleSafeExit = useCallback(async () => {
    await performSafeShutdown({
      outputManager: outputManagerRef.current,
      adapters: [
        coderAdapterRef.current,
        reviewerAdapterRef.current,
        godAdapterRef.current,
      ],
      beforeExit: saveStateForExit,
      onExit: () => exit(),
    });
  }, [saveStateForExit, exit]);

  useEffect(() => {
    registerGlobalCtrlCHandlers({
      interrupt: handleInterrupt,
      safeExit: handleSafeExit,
    });

    return () => {
      registerGlobalCtrlCHandlers(null);
    };
  }, [registerGlobalCtrlCHandlers, handleInterrupt, handleSafeExit]);

  // ── TaskAnalysisCard confirm handler ──
  const handleTaskAnalysisConfirm = useCallback(
    (taskType: string) => {
      setShowTaskAnalysisCard(false);
      const maxRounds = taskAnalysis?.suggestedMaxRounds;

      // BUG-8 fix: Update taskAnalysis state with user-selected taskType
      setTaskAnalysis(prev => prev ? { ...prev, taskType: taskType as GodTaskAnalysis['taskType'] } : prev);

      // Card C.3: Set initial phase for compound tasks — use taskType param (user's choice)
      if (taskType === 'compound' && taskAnalysis?.phases && taskAnalysis.phases.length > 0) {
        setCurrentPhaseId(taskAnalysis.phases[0].id);
      }

      addMessage({
        role: 'system',
        content: `Task analysis confirmed: type=${taskType}, rounds=${maxRounds ?? 'default'}.`,
        timestamp: Date.now(),
      });
      send({ type: 'TASK_INIT_COMPLETE', maxRounds });
    },
    [taskAnalysis, send, addMessage, setTaskAnalysis],
  );

  const handleTaskAnalysisTimeout = useCallback(() => {
    addTimelineEvent('task_start', 'TaskAnalysisCard auto-confirmed (timeout)');
  }, [addTimelineEvent]);

  // ── GodDecisionBanner handlers ──
  // Currently unused: ESCAPE_WINDOW_MS=0 means decisions execute instantly
  // without routing through the visual banner. Kept for future re-enablement
  // of the escape window (set ESCAPE_WINDOW_MS > 0 in god-decision-banner.ts).
  const handleGodDecisionExecute = useCallback(() => {
    if (!godDecision) return;
    setShowGodBanner(false);

    const envelope = pendingEnvelopeRef.current;
    if (envelope) {
      pendingEnvelopeRef.current = null;
      addTimelineEvent('task_start', `God decision executed: ${godDecision.action}`);
      send({ type: 'DECISION_READY', envelope });
    }
  }, [godDecision, send, addTimelineEvent]);

  const handleGodDecisionCancel = useCallback(() => {
    setShowGodBanner(false);
    setGodDecision(null);
    pendingEnvelopeRef.current = null;
    addMessage({
      role: 'system',
      content: 'God auto-decision cancelled. Waiting for your decision. Type [c] to continue, [a] to accept, or enter new instructions.',
      timestamp: Date.now(),
    });
    addTimelineEvent('task_start', 'God auto-decision: cancelled by user');
    send({ type: 'MANUAL_FALLBACK_REQUIRED' } as any);
  }, [send, addMessage, addTimelineEvent]);

  // ── Ctrl+R reclassify handler — Card C.3 (AC-010) ──
  const handleReclassify = useCallback(() => {
    if (!canTriggerReclassify(stateValue)) return;
    if (!taskAnalysis) return;

    // If LLM is running, interrupt first
    if (stateValue === 'CODING' || stateValue === 'REVIEWING') {
      const adapter = stateValue === 'CODING'
        ? coderAdapterRef.current
        : reviewerAdapterRef.current;
      lastInterruptedRoleRef.current = stateValue === 'CODING' ? 'coder' : 'reviewer';
      outputManagerRef.current.interrupt();
      adapter.kill().catch(() => {});
      addMessage({
        role: 'system',
        content: 'LLM interrupted for task reclassification.',
        timestamp: Date.now(),
      });
      send({ type: 'USER_INTERRUPT' });
    }

    setShowReclassify(true);
  }, [stateValue, taskAnalysis, send, addMessage]);

  // ── Reclassify confirm handler — Card C.3 (AC-011, AC-012) ──
  const handleReclassifySelect = useCallback(
    (newType: string) => {
      setShowReclassify(false);

      // BUG-7 fix: Clear any stale God auto-decision from before reclassification
      setGodDecision(null);
      setShowGodBanner(false);

      if (!taskAnalysis) return;

      const oldType = taskAnalysis.taskType;

      // Update taskAnalysis with new type
      const updatedAnalysis: GodTaskAnalysis = {
        ...taskAnalysis,
        taskType: newType as GodTaskAnalysis['taskType'],
      };
      setTaskAnalysis(updatedAnalysis);

      // Write audit log (AC-012)
      const sessionDir = sessionIdRef.current
        ? path.join(config.projectDir, '.duo', 'sessions', sessionIdRef.current)
        : config.projectDir;
      writeReclassifyAudit(sessionDir, {
        seq: ++auditSeqRef.current,
        round: ctx.round,
        fromType: oldType as any,
        toType: newType as any,
      });

      addMessage({
        role: 'system',
        content: `Task reclassified: ${oldType} → ${newType}. Continuing with new type.`,
        timestamp: Date.now(),
      });
      addTimelineEvent('task_start', `Reclassify: ${oldType} → ${newType}`);

      // Trigger re-run of GOD_DECIDING auto-decision after reclassify
      setReclassifyTrigger(prev => prev + 1);

      // Resume to GOD_DECIDING so the autonomous decision can re-run
      if (stateValue === 'INTERRUPTED') {
        send({ type: 'USER_INPUT', input: `Reclassified to ${newType}`, resumeAs: 'decision' });
      }
    },
    [taskAnalysis, config, ctx.round, stateValue, send, addMessage, addTimelineEvent],
  );

  const handleReclassifyCancel = useCallback(() => {
    setShowReclassify(false);

    // BUG-4 fix: If we interrupted the LLM to show the overlay, restore to
    // the previous role so the user isn't stuck in INTERRUPTED with no prompt.
    if (stateValue === 'INTERRUPTED' && lastInterruptedRoleRef.current) {
      addMessage({
        role: 'system',
        content: 'Task reclassification cancelled. Resuming previous work.',
        timestamp: Date.now(),
      });
      send({
        type: 'USER_INPUT',
        input: 'Reclassification cancelled, resuming',
        resumeAs: lastInterruptedRoleRef.current,
      });
    } else {
      addMessage({
        role: 'system',
        content: 'Task reclassification cancelled.',
        timestamp: Date.now(),
      });
    }
  }, [stateValue, send, addMessage]);

  // ── Phase transition confirm handler — Card C.3 (AC-033) ──
  const handlePhaseTransitionConfirm = useCallback(() => {
    setShowPhaseTransition(false);
    if (!pendingPhaseTransition) return;

    setCurrentPhaseId(pendingPhaseTransition.nextPhaseId);

    addMessage({
      role: 'system',
      content: `Phase transition confirmed → ${pendingPhaseTransition.nextPhaseId}`,
      timestamp: Date.now(),
    });
    addTimelineEvent('task_start', `Phase transition → ${pendingPhaseTransition.nextPhaseId}`);

    // Send continue with phase context (workflow machine handles pendingPhaseId)
    send({ type: 'USER_CONFIRM', action: 'continue' });
    setPendingPhaseTransition(null);
  }, [pendingPhaseTransition, send, addMessage, addTimelineEvent]);

  // ── Phase transition cancel handler — Card C.3 ──
  const handlePhaseTransitionCancel = useCallback(() => {
    setShowPhaseTransition(false);
    setPendingPhaseTransition(null);

    // BUG-1 fix: Clear pendingPhaseId in XState context so subsequent
    // USER_CONFIRM 'continue' doesn't trigger the cancelled phase transition.
    send({ type: 'CLEAR_PENDING_PHASE' });

    addMessage({
      role: 'system',
      content: 'Phase transition cancelled. Staying in current phase. Type [c] to continue, [a] to accept.',
      timestamp: Date.now(),
    });
    addTimelineEvent('task_start', 'Phase transition cancelled by user');
  }, [send, addMessage, addTimelineEvent]);

  // ── Build status ──
  const status = mapStateToStatus(stateValue);
  const activeAgent = getActiveAgentLabel(stateValue, config, detected);
  const isLLMRunning = stateValue === 'CODING' || stateValue === 'REVIEWING';

  // ── Compute workflow state hint for context-aware indicators ──
  const workflowState: WorkflowStateHint = (() => {
    if (isClassifyingIntent) return { phase: 'classifying_intent' as const };
    switch (stateValue) {
      case 'TASK_INIT': return { phase: 'task_init' as const };
      case 'GOD_DECIDING':
        // Post-reviewer GOD_DECIDING = convergence evaluation (is the task done?)
        return lastWorkerRoleRef.current === 'reviewer'
          ? { phase: 'god_convergence' as const }
          : { phase: 'god_deciding' as const };
      case 'OBSERVING': return { phase: 'observing' as const };
      case 'EXECUTING': return { phase: 'executing' as const };
      case 'CODING':
      case 'REVIEWING': return { phase: 'llm_running' as const };
      case 'DONE': return { phase: 'done' as const };
      default: return { phase: 'idle' as const };
    }
  })();

  // ── Context data for overlay ──
  const contextData = {
    roundNumber: ctx.round + 1,
    coderName: getDisplayName(config.coder),
    reviewerName: getDisplayName(config.reviewer),
    taskSummary: config.task,
    tokenEstimate: tokenCount,
  };

  // SPEC-DECISION: Render ReclassifyOverlay as full replacement to avoid useInput conflicts.
  if (showReclassify && taskAnalysis) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <ReclassifyOverlay
          currentType={taskAnalysis.taskType}
          currentRound={ctx.round + 1}
          onSelect={handleReclassifySelect}
          onCancel={handleReclassifyCancel}
        />
      </Box>
    );
  }

  if (
    showPhaseTransition
    && pendingPhaseTransition
    && (stateValue === 'GOD_DECIDING' || stateValue === 'MANUAL_FALLBACK')
  ) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <PhaseTransitionBanner
          nextPhaseId={pendingPhaseTransition.nextPhaseId}
          previousPhaseSummary={pendingPhaseTransition.previousPhaseSummary}
          onConfirm={handlePhaseTransitionConfirm}
          onCancel={handlePhaseTransitionCancel}
        />
      </Box>
    );
  }

  if (showGodBanner && godDecision && stateValue === 'GOD_DECIDING') {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <GodDecisionBanner
          decision={godDecision}
          onExecute={handleGodDecisionExecute}
          onCancel={handleGodDecisionCancel}
        />
      </Box>
    );
  }

  // SPEC-DECISION: Render TaskAnalysisCard as full replacement for MainLayout
  // to avoid useInput conflicts. Card disappears once confirmed.
  if (showTaskAnalysisCard && taskAnalysis && stateValue === 'TASK_INIT') {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <TaskAnalysisCard
          analysis={taskAnalysis}
          onConfirm={handleTaskAnalysisConfirm}
          onTimeout={handleTaskAnalysisTimeout}
        />
      </Box>
    );
  }

  return (
    <MainLayout
      messages={messages}
      columns={columns}
      rows={rows}
      isLLMRunning={isLLMRunning}
      workflowState={workflowState}
      onInputSubmit={handleInputSubmit}
      onNewSession={() => {
        // Not implemented in v1: would need to reset state
      }}
      onReclassify={handleReclassify}
      statusBarProps={{
        projectPath: config.projectDir,
        round: ctx.round + 1,
        maxRounds: ctx.maxRounds,
        status,
        activeAgent,
        tokenCount,
        taskType: taskAnalysis?.taskType,
        currentPhase: currentPhaseId ?? undefined,
        godAdapter: config.god,
        reviewerAdapter: config.reviewer,
        coderModel: config.coderModel,
        reviewerModel: config.reviewerModel,
        degradationLevel: watchdogRef.current.isPaused() ? 'L4' : 'L1',
        godLatency,
      }}
      contextData={contextData}
      timelineEvents={timelineEvents}
      footer={stateValue === 'DONE' ? (
        <CompletionScreen
          currentTask={config.task}
          onContinueCurrentTask={onContinueCurrentTask}
          onCreateNewTask={onCreateNewTask}
          onExit={() => exit()}
          variant="inline"
        />
      ) : undefined}
      footerHeight={stateValue === 'DONE' ? 6 : undefined}
      suspendGlobalKeys={stateValue === 'DONE'}
    />
  );
}
