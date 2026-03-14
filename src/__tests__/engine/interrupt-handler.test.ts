import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { InterruptHandler, type InterruptHandlerDeps } from '../../engine/interrupt-handler.js';
import type { Observation } from '../../types/observation.js';

/**
 * Mock ProcessManager — only needs kill(), isRunning(), getBufferedOutput()
 */
function createMockProcessManager() {
  return {
    kill: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn> & (() => Promise<void>),
    isRunning: vi.fn().mockReturnValue(true) as ReturnType<typeof vi.fn> & (() => boolean),
    getBufferedOutput: vi.fn().mockReturnValue('partial output so far') as ReturnType<typeof vi.fn> & (() => string),
  };
}

/**
 * Mock SessionManager — only needs saveState()
 */
function createMockSessionManager() {
  return {
    saveState: vi.fn(),
  };
}

/**
 * Mock workflow actor — send() and getSnapshot()
 */
function createMockActor(state: string = 'CODING') {
  return {
    send: vi.fn(),
    getSnapshot: vi.fn().mockReturnValue({
      value: state,
      context: {
        sessionId: 'test-session-123',
        round: 1,
        activeProcess: state === 'CODING' ? 'coder' : state === 'REVIEWING' ? 'reviewer' : null,
      },
    }),
  };
}

function createDeps(overrides?: Partial<InterruptHandlerDeps>): InterruptHandlerDeps {
  return {
    processManager: createMockProcessManager(),
    sessionManager: createMockSessionManager(),
    actor: createMockActor(),
    onExit: vi.fn(),
    onInterrupted: vi.fn(),
    onObservation: vi.fn(),
    ...overrides,
  };
}

describe('InterruptHandler', () => {
  let handler: InterruptHandler;

  afterEach(() => {
    handler?.dispose();
  });

  // ──────────────────────────────────────────────
  // AC-1: Ctrl+C kills LLM process within ≤1 second
  // ──────────────────────────────────────────────
  describe('AC-1: Ctrl+C kills LLM process', () => {
    it('should call processManager.kill() on handleSigint', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleSigint();

      expect(deps.processManager.kill).toHaveBeenCalledOnce();
    });

    // Card E.1: adapted — InterruptHandler no longer sends USER_INTERRUPT to actor
    it('should emit human_interrupt observation (not send to actor)', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleSigint();

      expect(deps.onObservation).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'human_interrupt', source: 'human' }),
      );
      expect(deps.actor.send).not.toHaveBeenCalled();
    });

    it('should call onInterrupted callback with buffered output', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleSigint();

      expect(deps.onInterrupted).toHaveBeenCalledWith(
        expect.objectContaining({
          bufferedOutput: 'partial output so far',
          interrupted: true,
        }),
      );
    });

    it('should not kill process if not running', async () => {
      const pm = createMockProcessManager();
      pm.isRunning.mockReturnValue(false);
      const deps = createDeps({ processManager: pm });
      handler = new InterruptHandler(deps);

      await handler.handleSigint();

      expect(pm.kill).not.toHaveBeenCalled();
    });

    // Card E.1: adapted — no observation emitted if not in active state
    it('should not emit observation if actor is not in active state', async () => {
      const actor = createMockActor('IDLE');
      const deps = createDeps({ actor });
      handler = new InterruptHandler(deps);

      await handler.handleSigint();

      expect(deps.onObservation).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // AC-2: Buffered output preserved and marked interrupted
  // ──────────────────────────────────────────────
  describe('AC-2: output preserved with interrupted marker', () => {
    it('should capture buffered output before kill', async () => {
      const pm = createMockProcessManager();
      pm.getBufferedOutput.mockReturnValue('line 1\nline 2\npartial line 3');
      const deps = createDeps({ processManager: pm });
      handler = new InterruptHandler(deps);

      await handler.handleSigint();

      expect(deps.onInterrupted).toHaveBeenCalledWith(
        expect.objectContaining({
          bufferedOutput: 'line 1\nline 2\npartial line 3',
          interrupted: true,
        }),
      );
    });

    it('should include interrupted flag in callback', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleSigint();

      const call = (deps.onInterrupted as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.interrupted).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // AC-3: User input after interrupt becomes new context
  // ──────────────────────────────────────────────
  // Card E.1: adapted — handleUserInput now emits clarification_answer observation
  describe('AC-3: user input after interrupt as observation', () => {
    it('should emit clarification_answer observation with user instruction', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      // First, interrupt
      await handler.handleSigint();

      // Then user types input — emits observation, not USER_INPUT event
      handler.handleUserInput('fix the bug instead', 'coder');

      expect(deps.onObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'clarification_answer',
          source: 'human',
          summary: 'fix the bug instead',
        }),
      );
      expect(deps.actor.send).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // AC-4: Text interrupt — typing during LLM run = interrupt with instruction
  // ──────────────────────────────────────────────
  describe('AC-4: text interrupt', () => {
    // Card E.1: adapted — text interrupt emits observation, not USER_INTERRUPT
    it('should kill process and emit human_message observation', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleTextInterrupt('use a different approach', 'coder');

      // Should kill process
      expect(deps.processManager.kill).toHaveBeenCalledOnce();
      // Should emit observation, NOT send USER_INTERRUPT
      expect(deps.onObservation).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'human_message', source: 'human' }),
      );
      expect(deps.actor.send).not.toHaveBeenCalled();
      // Should notify about interruption
      expect(deps.onInterrupted).toHaveBeenCalled();
    });

    it('should include user text in the interrupted callback', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleTextInterrupt('use a different approach', 'coder');

      expect(deps.onInterrupted).toHaveBeenCalledWith(
        expect.objectContaining({
          userInstruction: 'use a different approach',
        }),
      );
    });

    it('should not interrupt if process is not running', async () => {
      const pm = createMockProcessManager();
      pm.isRunning.mockReturnValue(false);
      const deps = createDeps({ processManager: pm });
      handler = new InterruptHandler(deps);

      await handler.handleTextInterrupt('hello', 'coder');

      expect(pm.kill).not.toHaveBeenCalled();
      expect(deps.onObservation).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // AC-5: Double Ctrl+C (<500ms) exits and saves session
  // ──────────────────────────────────────────────
  describe('AC-5: double Ctrl+C exit with session save', () => {
    it('should exit on second Ctrl+C within 500ms', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleSigint();
      await handler.handleSigint(); // within 500ms

      expect(deps.sessionManager.saveState).toHaveBeenCalledWith(
        'test-session-123',
        expect.objectContaining({ status: 'interrupted' }),
      );
      expect(deps.onExit).toHaveBeenCalled();
    });

    it('should NOT exit on second Ctrl+C after 500ms', async () => {
      vi.useFakeTimers();
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleSigint();
      vi.advanceTimersByTime(600); // > 500ms
      await handler.handleSigint();

      expect(deps.onExit).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should save session state before exit', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleSigint();
      await handler.handleSigint();

      // saveState called before onExit
      const saveOrder = (deps.sessionManager.saveState as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const exitOrder = (deps.onExit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(saveOrder).toBeLessThan(exitOrder);
    });

    it('should still exit even if session save fails', async () => {
      const sm = createMockSessionManager();
      sm.saveState.mockImplementation(() => { throw new Error('disk full'); });
      const deps = createDeps({ sessionManager: sm });
      handler = new InterruptHandler(deps);

      await handler.handleSigint();
      await handler.handleSigint();

      expect(deps.onExit).toHaveBeenCalled();
    });

    it('should skip session save if no sessionId', async () => {
      const actor = createMockActor('CODING');
      actor.getSnapshot.mockReturnValue({
        value: 'CODING',
        context: { sessionId: null, round: 0, activeProcess: 'coder' },
      });
      const deps = createDeps({ actor });
      handler = new InterruptHandler(deps);

      await handler.handleSigint();
      await handler.handleSigint();

      expect(deps.sessionManager.saveState).not.toHaveBeenCalled();
      expect(deps.onExit).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // Card B.2 AC-3: Ctrl+C produces human_interrupt observation
  // ──────────────────────────────────────────────
  describe('B.2 AC-3: Ctrl+C produces human_interrupt observation', () => {
    it('should call onObservation with human_interrupt on handleSigint', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleSigint();

      expect(deps.onObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'human_interrupt',
          source: 'human',
          severity: 'warning',
        }),
      );
    });

    it('should include round from actor snapshot in observation', async () => {
      const actor = createMockActor('CODING');
      actor.getSnapshot.mockReturnValue({
        value: 'CODING',
        context: { sessionId: 'test', round: 5, activeProcess: 'coder' },
      });
      const deps = createDeps({ actor });
      handler = new InterruptHandler(deps);

      await handler.handleSigint();

      expect(deps.onObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'human_interrupt',
          round: 5,
        }),
      );
    });

    it('should NOT call onObservation if not in active state', async () => {
      const actor = createMockActor('IDLE');
      const deps = createDeps({ actor });
      handler = new InterruptHandler(deps);

      await handler.handleSigint();

      expect(deps.onObservation).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // Card B.2: Text interrupt produces human_message observation
  // ──────────────────────────────────────────────
  describe('B.2: text interrupt produces human_message observation', () => {
    it('should call onObservation with human_message on handleTextInterrupt', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleTextInterrupt('fix the bug', 'coder');

      expect(deps.onObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'human_message',
          source: 'human',
          severity: 'info',
          summary: 'fix the bug',
        }),
      );
    });

    it('should carry rawRef with the user text', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleTextInterrupt('use different approach', 'coder');

      const obs = (deps.onObservation as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Observation;
      expect(obs.rawRef).toBe('use different approach');
    });
  });

  // ──────────────────────────────────────────────
  // Edge cases
  // ──────────────────────────────────────────────
  describe('edge cases', () => {
    it('should handle kill() throwing gracefully', async () => {
      const pm = createMockProcessManager();
      pm.kill.mockRejectedValue(new Error('already dead'));
      const deps = createDeps({ processManager: pm });
      handler = new InterruptHandler(deps);

      // Should not throw
      await expect(handler.handleSigint()).resolves.not.toThrow();
      // Should still emit observation (not send to actor)
      expect(deps.onObservation).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'human_interrupt' }),
      );
    });

    it('dispose should clean up', () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);
      handler.dispose();
      // No error on second dispose
      handler.dispose();
    });
  });

  // ──────────────────────────────────────────────
  // Card E.1: Interrupt → Observation normalization
  // ──────────────────────────────────────────────
  describe('E.1 AC-5: no direct state machine operation on interrupt', () => {
    it('handleSigint should NOT send any event to the state machine', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleSigint();

      // E.1: InterruptHandler must not call actor.send — observations route through pipeline
      expect(deps.actor.send).not.toHaveBeenCalled();
    });

    it('handleTextInterrupt should NOT send any event to the state machine', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleTextInterrupt('fix the bug', 'coder');

      // E.1: InterruptHandler must not call actor.send
      expect(deps.actor.send).not.toHaveBeenCalled();
    });

    it('handleSigint should still call onObservation with human_interrupt', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleSigint();

      expect(deps.onObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'human_interrupt',
          source: 'human',
          severity: 'warning',
        }),
      );
    });

    it('handleTextInterrupt should still call onObservation with human_message', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleTextInterrupt('use different approach', 'coder');

      expect(deps.onObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'human_message',
          source: 'human',
          severity: 'info',
          summary: 'use different approach',
        }),
      );
    });
  });

  describe('E.1 AC-3: handleUserInput emits clarification_answer observation', () => {
    it('should emit clarification_answer observation via onObservation', () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      handler.handleUserInput('fix the bug instead', 'coder');

      expect(deps.onObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'clarification_answer',
          source: 'human',
          summary: 'fix the bug instead',
          severity: 'info',
        }),
      );
    });

    it('should include rawRef with user text', () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      handler.handleUserInput('change the approach', 'coder');

      const obs = (deps.onObservation as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Observation;
      expect(obs.rawRef).toBe('change the approach');
    });

    it('should NOT send USER_INPUT event to the state machine', () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      handler.handleUserInput('test input', 'coder');

      expect(deps.actor.send).not.toHaveBeenCalled();
    });

    it('should not emit if disposed', () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);
      handler.dispose();

      handler.handleUserInput('test', 'coder');

      expect(deps.onObservation).not.toHaveBeenCalled();
    });
  });

  describe('E.1 AC-4: double Ctrl+C still bypasses God', () => {
    it('should exit on double Ctrl+C without going through observation pipeline', async () => {
      const deps = createDeps();
      handler = new InterruptHandler(deps);

      await handler.handleSigint();
      await handler.handleSigint(); // within 500ms

      expect(deps.onExit).toHaveBeenCalled();
    });
  });
});
