import { describe, expect, it } from 'vitest';
import type { LoadedSession } from '../../session/session-manager.js';
import {
  applyOutputChunk,
  buildRestoredSessionRuntime,
  createStreamAggregation,
  finalizeStreamAggregation,
  resolveUserDecision,
} from '../../ui/session-runner-state.js';

describe('session-runner-state', () => {
  describe('stream aggregation', () => {
    it('treats error chunks as failed runs instead of successful output', () => {
      let state = createStreamAggregation();
      state = applyOutputChunk(state, {
        type: 'text',
        content: 'partial output',
        timestamp: 1,
      });
      state = applyOutputChunk(state, {
        type: 'error',
        content: 'CLI crashed',
        timestamp: 2,
      });

      expect(finalizeStreamAggregation(state)).toEqual({
        kind: 'error',
        fullText: 'partial output\nError: CLI crashed',
        displayText: 'partial output\n**Error:** CLI crashed',
        errorMessage: 'CLI crashed',
      });
    });

    it('formats tool activity into structured display blocks and concise history text', () => {
      let state = createStreamAggregation();
      state = applyOutputChunk(state, {
        type: 'tool_use',
        content: '{"command":"ls","description":"List files"}',
        metadata: {
          tool: 'Bash',
          input: { command: 'ls', description: 'List files' },
        },
        timestamp: 1,
      });
      state = applyOutputChunk(state, {
        type: 'tool_result',
        content: 'file1\nfile2\nfile3',
        timestamp: 2,
      });
      state = applyOutputChunk(state, {
        type: 'text',
        content: 'Done.',
        timestamp: 3,
      });

      expect(finalizeStreamAggregation(state)).toEqual({
        kind: 'success',
        fullText: '[Bash] List files\n[Bash result] 3 lines\nDone.',
        displayText: '⏺ 2 tool updates · latest Bash: List files\nDone.',
      });
    });

    it('includes status chunks in fullText to prevent no_output for stderr-only runs', () => {
      let state = createStreamAggregation();
      state = applyOutputChunk(state, {
        type: 'status',
        content: 'Error: API key not found',
        timestamp: 1,
      });

      const result = finalizeStreamAggregation(state);
      expect(result.kind).not.toBe('no_output');
      expect(result.fullText).toContain('API key not found');
    });

    it('does not treat status chunks as fatal errors', () => {
      let state = createStreamAggregation();
      state = applyOutputChunk(state, {
        type: 'text',
        content: 'actual output',
        timestamp: 1,
      });
      state = applyOutputChunk(state, {
        type: 'status',
        content: 'Falling back from WebSockets to HTTPS transport',
        timestamp: 2,
      });

      const result = finalizeStreamAggregation(state);
      expect(result.kind).toBe('success');
      expect(result.fullText).toContain('actual output');
      expect(result.fullText).toContain('WebSockets');
    });

    it('keeps tool errors inside the message instead of escalating to process error', () => {
      let state = createStreamAggregation();
      state = applyOutputChunk(state, {
        type: 'tool_use',
        content: '{"file_path":"/missing.txt"}',
        metadata: {
          tool: 'Read',
          input: { file_path: '/missing.txt' },
        },
        timestamp: 1,
      });
      state = applyOutputChunk(state, {
        type: 'tool_result',
        content: 'File does not exist. Note: your current working directory is /tmp.',
        metadata: {
          isError: true,
        },
        timestamp: 2,
      });

      expect(finalizeStreamAggregation(state)).toEqual({
        kind: 'success',
        fullText: '[Read] Read missing.txt\n[Read error] File does not exist. Note: your current working directory is /tmp.',
        displayText: '⏺ 2 tool updates · 1 warning · latest Read: Read missing.txt',
      });
    });
  });

  describe('user decision handling', () => {
    it('treats free text in WAITING_USER as continue plus pending instruction', () => {
      expect(
        resolveUserDecision('WAITING_USER', 'continue, but focus on null checks', 'coder'),
      ).toEqual({
        type: 'confirm',
        action: 'continue',
        pendingInstruction: 'continue, but focus on null checks',
      });
    });

    it('preserves reviewer role when resuming from INTERRUPTED', () => {
      expect(
        resolveUserDecision('INTERRUPTED', 're-review with a security focus', 'reviewer'),
      ).toEqual({
        type: 'resume',
        input: 're-review with a security focus',
        resumeAs: 'reviewer',
      });
    });
  });

  describe('session restore runtime', () => {
    it('reconstructs workflow input, messages, rounds, and reviewer outputs from history', () => {
      const loaded: LoadedSession = {
        metadata: {
          id: 'session-123',
          projectDir: '/tmp/project',
          coder: 'claude-code',
          reviewer: 'codex',
          task: 'Fix the login flow',
          createdAt: 1,
          updatedAt: 2,
        },
        state: {
          round: 1,
          status: 'reviewing',
          currentRole: 'reviewer',
        },
        history: [
          { round: 0, role: 'coder', content: 'coder round 1', timestamp: 10 },
          { round: 0, role: 'reviewer', content: 'review round 1', timestamp: 20 },
          { round: 1, role: 'coder', content: 'coder round 2', timestamp: 30 },
        ],
      };

      const runtime = buildRestoredSessionRuntime(loaded, {
        projectDir: loaded.metadata.projectDir,
        coder: loaded.metadata.coder,
        reviewer: loaded.metadata.reviewer,
        god: 'codex',
        task: loaded.metadata.task,
      });

      expect(runtime.restoreEvent).toBe('RESTORED_TO_REVIEWING');
      expect(runtime.workflowInput).toMatchObject({
        round: 1,
        sessionId: 'session-123',
        lastCoderOutput: 'coder round 2',
        lastReviewerOutput: 'review round 1',
      });
      expect(runtime.messages).toHaveLength(3);
      expect(runtime.rounds).toHaveLength(2);
      expect(runtime.rounds[0]).toMatchObject({
        index: 1,
        coderOutput: 'coder round 1',
        reviewerOutput: 'review round 1',
      });
      expect(runtime.rounds[1]).toMatchObject({
        index: 2,
        coderOutput: 'coder round 2',
      });
      expect(runtime.reviewerOutputs).toEqual(['review round 1']);
      expect(runtime.tokenCount).toBeGreaterThan(0);
    });

    it('passes through adapter session IDs from persisted state', () => {
      const loaded: LoadedSession = {
        metadata: {
          id: 'session-456',
          projectDir: '/tmp/project',
          coder: 'claude-code',
          reviewer: 'codex',
          task: 'Fix bug',
          createdAt: 1,
          updatedAt: 2,
        },
        state: {
          round: 2,
          status: 'coding',
          currentRole: 'coder',
          coderSessionId: 'ses_abc',
          reviewerSessionId: 'th_xyz',
        },
        history: [
          { round: 0, role: 'coder', content: 'code', timestamp: 10 },
        ],
      };

      const runtime = buildRestoredSessionRuntime(loaded, {
        projectDir: loaded.metadata.projectDir,
        coder: loaded.metadata.coder,
        reviewer: loaded.metadata.reviewer,
        god: 'codex',
        task: loaded.metadata.task,
      });

      expect(runtime.coderSessionId).toBe('ses_abc');
      expect(runtime.reviewerSessionId).toBe('th_xyz');
    });

    it('leaves adapter session IDs undefined when not persisted', () => {
      const loaded: LoadedSession = {
        metadata: {
          id: 'session-789',
          projectDir: '/tmp/project',
          coder: 'claude-code',
          reviewer: 'claude-code',
          task: 'Task',
          createdAt: 1,
          updatedAt: 2,
        },
        state: {
          round: 0,
          status: 'coding',
          currentRole: 'coder',
        },
        history: [],
      };

      const runtime = buildRestoredSessionRuntime(loaded, {
        projectDir: loaded.metadata.projectDir,
        coder: loaded.metadata.coder,
        reviewer: loaded.metadata.reviewer,
        god: 'claude-code',
        task: loaded.metadata.task,
      });

      expect(runtime.coderSessionId).toBeUndefined();
      expect(runtime.reviewerSessionId).toBeUndefined();
    });

    it('passes through God task analysis, convergence log, and degradation state from persisted state', () => {
      const godTaskAnalysis = {
        taskType: 'code' as const,
        reasoning: 'User wants to fix a bug',
        confidence: 0.9,
        suggestedMaxRounds: 5,
        terminationCriteria: ['Tests pass'],
      };
      const godConvergenceLog = [
        {
          round: 0,
          timestamp: '2026-03-12T00:00:00Z',
          classification: 'improving',
          shouldTerminate: false,
          blockingIssueCount: 2,
          criteriaProgress: [],
          summary: 'round 0',
        },
      ];
      const loaded: LoadedSession = {
        metadata: {
          id: 'session-god-1',
          projectDir: '/tmp/project',
          coder: 'claude-code',
          reviewer: 'gemini',
          god: 'codex',
          task: 'Fix bug',
          createdAt: 1,
          updatedAt: 2,
        },
        state: {
          round: 1,
          status: 'coding',
          currentRole: 'coder',
          godSessionId: 'god_ses_123',
          godAdapter: 'codex',
          godTaskAnalysis,
          godConvergenceLog,
        },
        history: [
          { round: 0, role: 'coder', content: 'code', timestamp: 10 },
        ],
      };

      const runtime = buildRestoredSessionRuntime(loaded, {
        projectDir: loaded.metadata.projectDir,
        coder: loaded.metadata.coder,
        reviewer: loaded.metadata.reviewer,
        god: 'codex',
        task: loaded.metadata.task,
      });

      expect(runtime.godSessionId).toBe('god_ses_123');
      expect(runtime.godTaskAnalysis).toEqual(godTaskAnalysis);
      expect(runtime.godConvergenceLog).toEqual(godConvergenceLog);
    });

    it('passes through currentPhaseId from persisted state (BUG-6 regression)', () => {
      const loaded: LoadedSession = {
        metadata: {
          id: 'session-phase-1',
          projectDir: '/tmp/project',
          coder: 'claude-code',
          reviewer: 'gemini',
          god: 'codex',
          task: 'Fix bug',
          createdAt: 1,
          updatedAt: 2,
        },
        state: {
          round: 2,
          status: 'waiting_user',
          currentRole: 'coder',
          currentPhaseId: 'phase-implementation',
        },
        history: [
          { round: 0, role: 'coder', content: 'code', timestamp: 10 },
        ],
      };

      const runtime = buildRestoredSessionRuntime(loaded, {
        projectDir: loaded.metadata.projectDir,
        coder: loaded.metadata.coder,
        reviewer: loaded.metadata.reviewer,
        god: 'codex',
        task: loaded.metadata.task,
      });

      expect(runtime.currentPhaseId).toBe('phase-implementation');
    });

    it('defaults currentPhaseId to null when not persisted (BUG-6 regression)', () => {
      const loaded: LoadedSession = {
        metadata: {
          id: 'session-no-phase',
          projectDir: '/tmp/project',
          coder: 'claude-code',
          reviewer: 'claude-code',
          task: 'Task',
          createdAt: 1,
          updatedAt: 2,
        },
        state: {
          round: 0,
          status: 'coding',
          currentRole: 'coder',
        },
        history: [],
      };

      const runtime = buildRestoredSessionRuntime(loaded, {
        projectDir: loaded.metadata.projectDir,
        coder: loaded.metadata.coder,
        reviewer: loaded.metadata.reviewer,
        god: 'claude-code',
        task: loaded.metadata.task,
      });

      expect(runtime.currentPhaseId).toBeNull();
    });

    it('maps clarifying status to RESTORED_TO_CLARIFYING instead of INTERRUPTED', () => {
      const loaded: LoadedSession = {
        metadata: {
          id: 'session-clarifying',
          projectDir: '/tmp/project',
          coder: 'claude-code',
          reviewer: 'codex',
          task: 'Fix the login flow',
          createdAt: 1,
          updatedAt: 2,
        },
        state: {
          round: 2,
          status: 'clarifying',
          currentRole: 'coder',
        },
        history: [
          { round: 0, role: 'coder', content: 'code', timestamp: 10 },
        ],
      };

      const runtime = buildRestoredSessionRuntime(loaded, {
        projectDir: loaded.metadata.projectDir,
        coder: loaded.metadata.coder,
        reviewer: loaded.metadata.reviewer,
        god: 'codex',
        task: loaded.metadata.task,
      });

      expect(runtime.restoreEvent).toBe('RESTORED_TO_CLARIFYING');
    });

    it('leaves God fields undefined when not persisted', () => {
      const loaded: LoadedSession = {
        metadata: {
          id: 'session-no-god',
          projectDir: '/tmp/project',
          coder: 'claude-code',
          reviewer: 'claude-code',
          task: 'Task',
          createdAt: 1,
          updatedAt: 2,
        },
        state: {
          round: 0,
          status: 'coding',
          currentRole: 'coder',
        },
        history: [],
      };

      const runtime = buildRestoredSessionRuntime(loaded, {
        projectDir: loaded.metadata.projectDir,
        coder: loaded.metadata.coder,
        reviewer: loaded.metadata.reviewer,
        god: 'claude-code',
        task: loaded.metadata.task,
      });

      expect(runtime.godSessionId).toBeUndefined();
      expect(runtime.godTaskAnalysis).toBeUndefined();
      expect(runtime.godConvergenceLog).toBeUndefined();
    });
  });
});
