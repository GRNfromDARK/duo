/**
 * App — Root TUI session component for Duo.
 *
 * Two phases:
 * 1. Setup: interactive wizard when args are missing (dir → coder → reviewer → task)
 * 2. Session: orchestrates xstate workflow, adapters, and MainLayout
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, useStdout, useApp, useInput, useRenderer } from '../../tui/primitives.js';
import { useMachine } from '@xstate/react';
import { workflowMachine, detectRoutingConflicts } from '../../engine/workflow-machine.js';
import type { WorkflowContext } from '../../engine/workflow-machine.js';
import { createAdapter } from '../../adapters/factory.js';
import { createGodAdapter } from '../../god/god-adapter-factory.js';
import { OutputStreamManager } from '../../adapters/output-stream-manager.js';
import { SessionManager } from '../../session/session-manager.js';
import type { LoadedSession } from '../../session/session-manager.js';
import { MainLayout } from './MainLayout.js';
import type { WorkflowStateHint } from './MainLayout.js';
import type { WorkflowStatus } from './StatusBar.js';
import { SetupWizard } from './SetupWizard.js';
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
import { GodAuditLogger, logEnvelopeDecision } from '../../god/god-audit.js';
import type { GodTaskAnalysis } from '../../types/god-schemas.js';
import { TaskAnalysisCard } from './TaskAnalysisCard.js';
import { generateCoderPrompt, generateReviewerPrompt } from '../../god/god-prompt-generator.js';
import type { PromptContext } from '../../god/god-prompt-generator.js';
import { ReclassifyOverlay } from './ReclassifyOverlay.js';
import { CompletionScreen } from './CompletionScreen.js';
import { canTriggerReclassify, writeReclassifyAudit } from '../reclassify-overlay.js';
import { buildContinuedTaskPrompt } from '../completion-flow.js';
import { resolveGlobalCtrlCAction } from '../global-ctrl-c.js';
import { copyToClipboard } from '../clipboard.js';
import type { Key } from '../../tui/primitives.js';
import { performSafeShutdown } from '../safe-shutdown.js';
import { appendPromptLog } from '../../session/prompt-log.js';
import {
  createWorkObservation,
  createHumanObservation,
  deduplicateObservations,
} from '../../god/observation-factory.js';
import { dispatchMessages } from '../../god/message-dispatcher.js';
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
    case 'OBSERVING':
    case 'EXECUTING':
      return 'routing';
    case 'PAUSED':
      return 'interrupted';
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
  if (stateValue === 'GOD_DECIDING') return 'God:Deciding';
  if (stateValue === 'OBSERVING') return 'God:Observing';
  if (stateValue === 'EXECUTING') return 'God:Executing';
  if (stateValue === 'CLARIFYING') return 'God:Clarifying';
  return null;
}

// ── Copy-on-selection decision logic (exported for testing) ──

export type CopyAction =
  | { action: 'copy'; text: string }
  | { action: 'interrupt' }
  | { action: 'noop' };

/**
 * Pure decision function: given the key event and renderer selection state,
 * decide whether to copy, interrupt, or do nothing.
 *
 * Extracted from the useInput handler so tests can verify the real logic
 * without mounting the full App component tree.
 */
export function resolveCopyOrInterrupt(
  input: string,
  key: Pick<Key, 'ctrl' | 'meta' | 'super'>,
  hasSelection: boolean,
  liveText: string,
  cachedText: string,
  cacheValid: boolean,
): CopyAction {
  const isCopyKey = (key.ctrl || key.meta || key.super) && input === 'c';
  if (!isCopyKey) return { action: 'noop' };

  if (hasSelection) {
    const text = liveText || (cacheValid ? cachedText : '');
    if (text) return { action: 'copy', text };
    return { action: 'noop' };
  }

  // Cmd+C (meta/super, no ctrl) without a selection: ignore — don't interrupt.
  if (!key.ctrl) return { action: 'noop' };

  // Ctrl+C without selection: interrupt.
  return { action: 'interrupt' };
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

  const renderer = useRenderer();

  // Cache selected text at drag-finish time. During rapid React re-renders
  // (e.g. streaming updates), the Selection's renderable references can become
  // stale, causing getSelectedText() to return empty even though hasSelection
  // is true. By caching the text when the renderer emits 'selection' (fired at
  // the end of every mouse-drag selection), we guarantee a valid copy payload
  // is available when the user presses Ctrl/Cmd+C moments later.
  //
  // To prevent stale cache from a previous selection leaking into a new one,
  // we also store the Selection object reference. In the copy handler we only
  // use the cached text when the current selection is the same object that
  // produced the cache. If the user clears and starts a new selection, the
  // renderer creates a new Selection instance, so the identity check fails
  // and the stale cache is ignored.
  const cachedSelectionTextRef = useRef('');
  const cachedSelectionRef = useRef<object | null>(null);
  useEffect(() => {
    const onSelectionFinish = (selection: { getSelectedText?: () => string } | null) => {
      const text = selection?.getSelectedText?.() ?? '';
      cachedSelectionTextRef.current = text;
      cachedSelectionRef.current = selection;
      // Auto-copy on selection: immediately copy to clipboard when user
      // finishes a mouse-drag selection, so no extra keypress is needed.
      if (text) {
        const result = copyToClipboard(renderer, text);
        if (result.hint) {
          // eslint-disable-next-line no-console
          console.error(result.hint);
        }
      }
    };
    renderer.on('selection', onSelectionFinish);
    return () => { renderer.off('selection', onSelectionFinish); };
  }, [renderer]);

  useInput((input, key) => {
    const currentSel = renderer.hasSelection ? renderer.getSelection() : null;
    const liveText = currentSel?.getSelectedText() ?? '';
    const cacheValid = currentSel != null && currentSel === cachedSelectionRef.current;

    const copyResult = resolveCopyOrInterrupt(
      input, key,
      renderer.hasSelection,
      liveText,
      cachedSelectionTextRef.current,
      cacheValid,
    );

    if (copyResult.action === 'copy') {
      const clipResult = copyToClipboard(renderer, copyResult.text);
      if (clipResult.hint) {
        // eslint-disable-next-line no-console
        console.error(clipResult.hint);
      }
      return;
    }

    if (copyResult.action === 'noop') return;

    // copyResult.action === 'interrupt'
    // Ctrl+C without selection: existing interrupt / safe-exit logic.
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
        columns={columns}
        rows={rows}
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
  const restoredRuntime = resumeSession
    ? buildRestoredSessionRuntime(resumeSession, config)
    : null;

  // ── xstate actor ──
  const [snapshot, send] = useMachine(workflowMachine, {
    input: {
      ...(restoredRuntime?.workflowInput ?? {}),
    },
  });

  const stateValue = snapshot.value as string;
  const ctx = snapshot.context as WorkflowContext;

  // ── Core services (stable refs) ──
  const coderAdapterRef = useRef<CLIAdapter>(createAdapter(config.coder));
  const reviewerAdapterRef = useRef<CLIAdapter>(createAdapter(config.reviewer));
  const godAdapterRef = useRef<GodAdapter>(createGodAdapter(config.god));
  const sessionManagerRef = useRef(
    new SessionManager(path.join(config.projectDir, '.duo', 'sessions')),
  );
  const outputManagerRef = useRef(new OutputStreamManager());
  const godAuditLoggerRef = useRef<GodAuditLogger | null>(null);

  // ── Mutable orchestration state ──
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
  const pendingCoderDispatchTypeRef = useRef<string | null>(null);
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

  // ── Reclassify overlay state (Ctrl+R) — Card C.3 ──
  const [showReclassify, setShowReclassify] = useState(false);


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

  // ── GOD_DECIDING now starts directly from IDLE → START_TASK (no TASK_INIT phase) ──
  // Initialize God audit logger on first GOD_DECIDING entry
  useEffect(() => {
    if (stateValue !== 'GOD_DECIDING') return;
    if (!godAuditLoggerRef.current && sessionIdRef.current) {
      const sessionDir = getSessionDir();
      godAuditLoggerRef.current = new GodAuditLogger(sessionDir);
    }
  }, [stateValue]);

  // ── Save state on transitions ──
  useEffect(() => {
    if (!sessionIdRef.current || !initializedRef.current || stateValue === 'IDLE') return;
    try {
      const coderAdapter = coderAdapterRef.current;
      const reviewerAdapter = reviewerAdapterRef.current;
      sessionManagerRef.current.saveState(sessionIdRef.current, {
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
      });
    } catch {
      // Best-effort persistence
    }
  }, [stateValue]);

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

    addTimelineEvent('coding', `Coder started: ${getDisplayName(config.coder)}`);

    (async () => {
      try {
        const interruptInstruction = pendingInstructionRef.current ?? undefined;
        pendingInstructionRef.current = null;
        const shouldSkipHistory = isSessionCapable(adapter) && adapter.hasActiveSession();

        // Prompt generation — direct call (pure template, no retry needed)
        // dispatchType comes from the hand executor's pendingCoderDispatchType (default to 'code')
        const dispatchType = pendingCoderDispatchTypeRef.current ?? 'code';
        pendingCoderDispatchTypeRef.current = null; // consumed
        const prompt = generateCoderPrompt({
          dispatchType: dispatchType as PromptContext['dispatchType'],
          taskGoal: config.task,
          lastReviewerOutput: ctx.lastReviewerOutput ?? undefined,
          instruction: interruptInstruction,
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
              agent: 'coder',
              adapter: config.coder,
              kind: 'coder_iteration',
              prompt,
              systemPrompt: null,
              meta: {
                promptSource,
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
                  role: 'coder',
                  content: outcome.fullText,
                  timestamp: Date.now(),
                });
              } catch { /* best-effort */ }
            }

            // All successful outputs go to CODE_COMPLETE
            // God interprets content directly; no pre-classification needed.
            lastWorkerRoleRef.current = 'coder';
            reviewerFeedbackPendingRef.current = false;
            addTimelineEvent('coding', `Coder completed: ${tokens} tokens`);
            send({ type: 'CODE_COMPLETE', output: outcome.llmText });
          }
        }
      } catch (err) {
        if (!cancelled) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          addMessage({
            role: 'system',
            content: `Coder error: ${errorMsg}`,
            timestamp: Date.now(),
          });
          send({ type: 'PROCESS_ERROR', error: errorMsg });
        }
      }
    })();

    return () => {
      cancelled = true;
      osm.interrupt();
    };
  }, [stateValue, config.task]);

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

    // Create typed Observation (pure sync, no classification needed — God interprets directly)
    const observation = createWorkObservation(
      output,
      source === 'reviewer' ? 'reviewer' : 'coder',
    );

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

    addTimelineEvent('reviewing', `Reviewer started: ${getDisplayName(config.reviewer)}`);

    (async () => {
      try {
        // BUG-11 fix: prefer God's reviewer instruction over generic pending instruction
        const interruptInstruction = pendingReviewerInstructionRef.current ?? pendingInstructionRef.current ?? undefined;
        pendingReviewerInstructionRef.current = null;
        pendingInstructionRef.current = null;
        const shouldSkipHistory = isSessionCapable(adapter) && adapter.hasActiveSession();
        // Get the last reviewer output for feedback checklist (subsequent iterations)
        const lastReviewerOut = reviewerOutputsRef.current.length > 0
          ? reviewerOutputsRef.current[reviewerOutputsRef.current.length - 1]
          : undefined;

        // Prompt generation — direct call (pure template, no retry needed)
        const prompt = generateReviewerPrompt({
          taskGoal: config.task,
          lastCoderOutput: ctx.lastCoderOutput ?? undefined,
          instruction: interruptInstruction,
        });
        const promptSource = 'god_dynamic';

        if (sessionIdRef.current) {
          try {
            appendPromptLog(getSessionDir(), {
              agent: 'reviewer',
              adapter: config.reviewer,
              kind: 'reviewer_iteration',
              prompt,
              systemPrompt: null,
              meta: {
                promptSource,
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
                  role: 'reviewer',
                  content: outcome.fullText,
                  timestamp: Date.now(),
                });
              } catch { /* best-effort */ }
            }

            // Track reviewer outputs for loop detection (use clean LLM text for comparison)
            reviewerOutputsRef.current.push(outcome.llmText);

            // All successful outputs go to REVIEW_COMPLETE
            // God interprets content directly; no pre-classification needed.
            lastWorkerRoleRef.current = 'reviewer';
            reviewerFeedbackPendingRef.current = true;
            addTimelineEvent('reviewing', `Reviewer completed: ${tokens} tokens`);
            send({ type: 'REVIEW_COMPLETE', output: outcome.llmText });
          }
        }
      } catch (err) {
        if (!cancelled) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          addMessage({
            role: 'system',
            content: `Reviewer error: ${errorMsg}`,
            timestamp: Date.now(),
          });
          send({ type: 'PROCESS_ERROR', error: errorMsg });
        }
      }
    })();

    return () => {
      cancelled = true;
      osm.interrupt();
    };
  }, [stateValue, config.task]);

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

    // Auto-recover to GOD_DECIDING / PAUSED handling
    send({ type: 'RECOVERY' });
  }, [stateValue]);

  // ── GOD_DECIDING: unified God decision → DECISION_READY ──
  // Card D.1: replaces old auto-decision with GodDecisionService.makeDecision()
  useEffect(() => {
    if (stateValue !== 'GOD_DECIDING') return;

    const manualWaitingMsg = 'Waiting for your decision. Type [c] to continue, [a] to accept, or enter new instructions.';

    if (!watchdogRef.current.isGodAvailable()) {
      send({ type: 'PAUSE_REQUIRED' } as any);
      addMessage({
        role: 'system',
        content: `God unavailable. ${manualWaitingMsg}`,
        timestamp: Date.now(),
      });
      return;
    }

    let cancelled = false;

    // Bug 4 fix: GOD_DECIDING timeout — fallback to PAUSED if God hangs
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
      send({ type: 'PAUSE_REQUIRED' } as any);
    }, GOD_DECIDING_TIMEOUT_MS);

    (async () => {
      try {
        const godCallStart = Date.now();
        const service = godDecisionServiceRef.current;

        const decisionContext: GodDecisionContext = {
          taskGoal: config.task,
          availableAdapters: [config.coder, config.reviewer],
          activeRole: ctx.activeProcess,
          sessionDir: getSessionDir(),
        };

        const allObservations = deduplicateObservations(ctx.currentObservations);
        const envelope = await service.makeDecision(allObservations, decisionContext);

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
        });

        // Apply dispatched pending messages
        if (dispatchResult.pendingCoderMessage) {
          pendingInstructionRef.current = dispatchResult.pendingCoderMessage;
        }
        // BUG-11 fix: save reviewer pending message from dispatch
        if (dispatchResult.pendingReviewerMessage) {
          pendingReviewerInstructionRef.current = dispatchResult.pendingReviewerMessage;
        }

        // Log complete envelope decision audit
        if (godAuditLoggerRef.current) {
          logEnvelopeDecision(godAuditLoggerRef.current, {
            observations: ctx.currentObservations,
            envelope,
            executionResults: [],
          });
        }

        send({ type: 'DECISION_READY', envelope });
      } catch (err) {
        clearTimeout(timeoutId);
        if (cancelled) return;

        addMessage({
          role: 'system',
          content: `God decision failed: ${err instanceof Error ? err.message : String(err)}. ${manualWaitingMsg}`,
          timestamp: Date.now(),
        });
        send({ type: 'PAUSE_REQUIRED' } as any);
      }
    })();

    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, [stateValue, reclassifyTrigger]);

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
          pendingCoderMessage: pendingInstructionRef.current,
          pendingCoderDispatchType: null,
          pendingReviewerMessage: null,
          auditLogger: godAuditLoggerRef.current,
          taskCompleted: false,
          waitState: { active: false, reason: null, estimatedSeconds: null },
          clarificationState: { active: false, question: null },
          sessionDir: getSessionDir(),
          cwd: config.projectDir,
        };

        const results = await executeActions(envelope.actions, handContext);

        if (cancelled) return;

        // Apply side effects from hand executor back to orchestration state
        if (handContext.pendingCoderMessage && handContext.pendingCoderMessage !== pendingInstructionRef.current) {
          pendingInstructionRef.current = handContext.pendingCoderMessage;
        }
        if (handContext.pendingCoderDispatchType) {
          pendingCoderDispatchTypeRef.current = handContext.pendingCoderDispatchType;
        }
        if (handContext.pendingReviewerMessage && handContext.pendingReviewerMessage !== pendingReviewerInstructionRef.current) {
          pendingReviewerInstructionRef.current = handContext.pendingReviewerMessage;
        }

        if (handContext.taskCompleted || envelope.actions.some(a => a.type === 'accept_task')) {
          reviewerFeedbackPendingRef.current = false;
          if (envelope.actions.some(a => a.type === 'accept_task')) {
            addMessage({
              role: 'system',
              content: 'Task accepted by God',
              timestamp: Date.now(),
            });
          }
        }

        // Display God's clarification question
        if (handContext.clarificationState.active && handContext.clarificationState.question) {
          addMessage({
            role: 'system',
            content: `God asks: ${handContext.clarificationState.question}`,
            timestamp: Date.now(),
          });
        }

        // Detect conflicting routing actions in envelope
        const routingConflicts = detectRoutingConflicts(envelope);
        if (routingConflicts.length > 0) {
          const conflictObs: import('../../types/observation.js').Observation = {
            source: 'runtime',
            type: 'runtime_error',
            summary: `Multiple routing actions in single envelope: [${routingConflicts.join(', ')}]. Only first will be used for routing.`,
            severity: 'warning',
            timestamp: new Date().toISOString(),
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
        // Text interrupt: kill current process, create observation and go to GOD_DECIDING
        const adapter =
          stateValue === 'CODING'
            ? coderAdapterRef.current
            : reviewerAdapterRef.current;
        lastInterruptedRoleRef.current = stateValue === 'CODING' ? 'coder' : 'reviewer';
        pendingInstructionRef.current = text;

        outputManagerRef.current.interrupt();
        adapter.kill().catch(() => {});

        const bufferedText = outputManagerRef.current.getBufferedText();
        addMessage({
          role: 'system',
          content: `Interrupted (${bufferedText.length} chars captured). Processing your instruction...`,
          timestamp: Date.now(),
        });

        // Route to OBSERVING → GOD_DECIDING via CODE_COMPLETE/REVIEW_COMPLETE with captured output
        if (stateValue === 'CODING') {
          send({ type: 'CODE_COMPLETE', output: bufferedText || '(interrupted)' });
        } else {
          send({ type: 'REVIEW_COMPLETE', output: bufferedText || '(interrupted)' });
        }
        return;
      }

      if (stateValue === 'PAUSED') {
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

      // CLARIFYING — user answers God's clarification question
      if (stateValue === 'CLARIFYING') {
        const obs = createHumanObservation(text);
        send({ type: 'OBSERVATIONS_READY', observations: [obs] });
        return;
      }
    },
    [stateValue, send, addMessage],
  );

  // ── Handle Ctrl+C interrupt ──
  const handleInterrupt = useCallback(() => {
    // Single Ctrl+C: interrupt current process, route through observation pipeline
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

      // Route to OBSERVING → GOD_DECIDING via CODE_COMPLETE/REVIEW_COMPLETE
      if (stateValue === 'CODING') {
        send({ type: 'CODE_COMPLETE', output: bufferedText || '(interrupted)' });
      } else {
        send({ type: 'REVIEW_COMPLETE', output: bufferedText || '(interrupted)' });
      }
    }
  }, [stateValue, ctx, send, exit, addMessage, addTimelineEvent]);

  const saveStateForExit = useCallback(() => {
    if (!sessionIdRef.current) return;

    try {
      const ca = coderAdapterRef.current;
      const ra = reviewerAdapterRef.current;
      sessionManagerRef.current.saveState(sessionIdRef.current, {
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
      });
    } catch {
      // Best-effort persistence before exit.
    }
  }, [ctx.activeProcess, stateValue]);

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
      setTaskAnalysis(prev => prev ? { ...prev, taskType: taskType as GodTaskAnalysis['taskType'] } : prev);

      addMessage({
        role: 'system',
        content: `Task analysis confirmed: type=${taskType}.`,
        timestamp: Date.now(),
      });
      // No TASK_INIT_COMPLETE needed — GOD_DECIDING starts directly from START_TASK
    },
    [send, addMessage, setTaskAnalysis],
  );

  const handleTaskAnalysisTimeout = useCallback(() => {
    addTimelineEvent('task_start', 'TaskAnalysisCard auto-confirmed (timeout)');
  }, [addTimelineEvent]);

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
      // Route through normal completion path
      if (stateValue === 'CODING') {
        send({ type: 'CODE_COMPLETE', output: '(interrupted for reclassification)' });
      } else {
        send({ type: 'REVIEW_COMPLETE', output: '(interrupted for reclassification)' });
      }
    }

    setShowReclassify(true);
  }, [stateValue, taskAnalysis, send, addMessage]);

  // ── Reclassify confirm handler — Card C.3 (AC-011, AC-012) ──
  const handleReclassifySelect = useCallback(
    (newType: string) => {
      setShowReclassify(false);

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
    },
    [taskAnalysis, config, stateValue, send, addMessage, addTimelineEvent],
  );

  const handleReclassifyCancel = useCallback(() => {
    setShowReclassify(false);
    addMessage({
      role: 'system',
      content: 'Task reclassification cancelled.',
      timestamp: Date.now(),
    });
  }, [addMessage]);


  // ── Build status ──
  const status = mapStateToStatus(stateValue);
  const activeAgent = getActiveAgentLabel(stateValue, config, detected);
  const isLLMRunning = stateValue === 'CODING' || stateValue === 'REVIEWING';

  // ── Compute workflow state hint for context-aware indicators ──
  const workflowState: WorkflowStateHint = (() => {
    if (isClassifyingIntent) return { phase: 'classifying_intent' as const };
    switch (stateValue) {
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
          onSelect={handleReclassifySelect}
          onCancel={handleReclassifyCancel}
        />
      </Box>
    );
  }

  // SPEC-DECISION: Render TaskAnalysisCard as full replacement for MainLayout
  // to avoid useInput conflicts. Card disappears once confirmed.
  if (showTaskAnalysisCard && taskAnalysis) {
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
        status,
        activeAgent,
        tokenCount,
        taskType: taskAnalysis?.taskType,
        godAdapter: config.god,
        reviewerAdapter: config.reviewer,
        coderModel: config.coderModel,
        reviewerModel: config.reviewerModel,
        // degradationLevel removed — StatusBar no longer shows degradation indicators
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
