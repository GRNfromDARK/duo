/**
 * Tests for Message Dispatcher (Card C.3, Task 2)
 * Source: FR-008 (Natural-Language Message Channel)
 * Acceptance Criteria: AC-5 through AC-9
 *
 * Key constraint: Message dispatch MUST NOT trigger any state change (NFR-001 / FR-016).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { GodDecisionEnvelope, EnvelopeMessage } from '../../types/god-envelope.js';
import { GodAuditLogger } from '../../god/god-audit.js';
import {
  dispatchMessages,
  type DispatchContext,
} from '../../god/message-dispatcher.js';

// ── Test Helpers ──

function createDispatchContext(overrides: Partial<DispatchContext> = {}): DispatchContext & { tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-msg-dispatch-'));
  return {
    pendingCoderMessage: null,
    pendingReviewerMessage: null,
    displayToUser: vi.fn(),
    auditLogger: new GodAuditLogger(tmpDir),
    tmpDir,
    ...overrides,
  };
}

// ── Tests ──

describe('Message Dispatcher', () => {
  let ctx: DispatchContext & { tmpDir: string };

  beforeEach(() => {
    ctx = createDispatchContext();
  });

  afterEach(() => {
    try {
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // AC-5: God can output actions + messages simultaneously (messages dispatched correctly)
  describe('AC-5: actions + messages dispatched correctly', () => {
    it('dispatches messages from an envelope that also has actions', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'coder', content: 'Focus on edge cases' },
        { target: 'user', content: 'Working on your request' },
        { target: 'system_log', content: 'Routing decision made' },
      ];

      const result = dispatchMessages(messages, ctx);

      expect(result.pendingCoderMessage).toBe('Focus on edge cases');
      expect(ctx.displayToUser).toHaveBeenCalled();
      // system_log should be written to audit
      const entries = ctx.auditLogger.getEntries();
      expect(entries.some(e => e.outputSummary.includes('Routing decision made'))).toBe(true);
    });
  });

  // AC-6: coder/reviewer messages written to pending message
  describe('AC-6: coder/reviewer messages written to pending message', () => {
    it('writes coder message to pendingCoderMessage', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'coder', content: 'Implement the login page' },
      ];

      const result = dispatchMessages(messages, ctx);

      expect(result.pendingCoderMessage).toBe('Implement the login page');
    });

    it('writes reviewer message to pendingReviewerMessage', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'reviewer', content: 'Check security aspects' },
      ];

      const result = dispatchMessages(messages, ctx);

      expect(result.pendingReviewerMessage).toBe('Check security aspects');
    });

    it('concatenates multiple coder messages', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'coder', content: 'First instruction' },
        { target: 'coder', content: 'Second instruction' },
      ];

      const result = dispatchMessages(messages, ctx);

      expect(result.pendingCoderMessage).toContain('First instruction');
      expect(result.pendingCoderMessage).toContain('Second instruction');
    });

    it('concatenates multiple reviewer messages', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'reviewer', content: 'Check A' },
        { target: 'reviewer', content: 'Check B' },
      ];

      const result = dispatchMessages(messages, ctx);

      expect(result.pendingReviewerMessage).toContain('Check A');
      expect(result.pendingReviewerMessage).toContain('Check B');
    });
  });

  // AC-7: user messages formatted via god-message-style then displayed
  describe('AC-7: user messages formatted and displayed', () => {
    it('calls displayToUser with formatted message for user target', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'user', content: 'Task is progressing well' },
      ];

      dispatchMessages(messages, ctx);

      expect(ctx.displayToUser).toHaveBeenCalledTimes(1);
      // The formatted message should contain the original content
      const calledWith = (ctx.displayToUser as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(calledWith).toContain('Task is progressing well');
    });

    it('displays multiple user messages separately', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'user', content: 'First update' },
        { target: 'user', content: 'Second update' },
      ];

      dispatchMessages(messages, ctx);

      expect(ctx.displayToUser).toHaveBeenCalledTimes(2);
    });
  });

  // AC-8: system_log messages written to audit log
  describe('AC-8: system_log written to audit', () => {
    it('writes system_log message to god-audit.jsonl', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'system_log', content: 'Override reason: reviewer findings are outdated' },
      ];

      dispatchMessages(messages, ctx);

      const entries = ctx.auditLogger.getEntries();
      expect(entries.length).toBeGreaterThan(0);
      const lastEntry = entries[entries.length - 1];
      expect(lastEntry.decisionType).toBe('message_dispatch');
      expect(lastEntry.outputSummary).toContain('Override reason');
    });

    it('writes multiple system_log messages', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'system_log', content: 'Log entry 1' },
        { target: 'system_log', content: 'Log entry 2' },
      ];

      dispatchMessages(messages, ctx);

      const entries = ctx.auditLogger.getEntries({ type: 'message_dispatch' });
      expect(entries.length).toBe(2);
    });
  });

  // AC-9: Message dispatch does not trigger any state change
  describe('AC-9: no state change during dispatch', () => {
    it('returns new pending messages without mutating context', () => {
      const originalCoderMsg = ctx.pendingCoderMessage;
      const originalReviewerMsg = ctx.pendingReviewerMessage;

      const messages: EnvelopeMessage[] = [
        { target: 'coder', content: 'New coder instruction' },
        { target: 'reviewer', content: 'New reviewer instruction' },
      ];

      const result = dispatchMessages(messages, ctx);

      // Context should NOT be mutated (functional approach)
      expect(ctx.pendingCoderMessage).toBe(originalCoderMsg);
      expect(ctx.pendingReviewerMessage).toBe(originalReviewerMsg);

      // Result should carry the new messages
      expect(result.pendingCoderMessage).toBe('New coder instruction');
      expect(result.pendingReviewerMessage).toBe('New reviewer instruction');
    });

    it('only has side effects for displayToUser and auditLogger', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'coder', content: 'instruction' },
        { target: 'user', content: 'display this' },
        { target: 'system_log', content: 'log this' },
      ];

      const result = dispatchMessages(messages, ctx);

      // Allowed side effects: displayToUser called, auditLogger written
      expect(ctx.displayToUser).toHaveBeenCalledTimes(1);
      const entries = ctx.auditLogger.getEntries();
      expect(entries.length).toBeGreaterThan(0);

      // Disallowed: no state mutation on ctx
      expect(ctx.pendingCoderMessage).toBeNull();
      expect(ctx.pendingReviewerMessage).toBeNull();
    });
  });

  // Edge cases
  describe('edge cases', () => {
    it('handles empty messages array', () => {
      const result = dispatchMessages([], ctx);

      expect(result.pendingCoderMessage).toBeNull();
      expect(result.pendingReviewerMessage).toBeNull();
      expect(ctx.displayToUser).not.toHaveBeenCalled();
    });

    it('handles all four target types in a single call', () => {
      const messages: EnvelopeMessage[] = [
        { target: 'coder', content: 'coder msg' },
        { target: 'reviewer', content: 'reviewer msg' },
        { target: 'user', content: 'user msg' },
        { target: 'system_log', content: 'system msg' },
      ];

      const result = dispatchMessages(messages, ctx);

      expect(result.pendingCoderMessage).toBe('coder msg');
      expect(result.pendingReviewerMessage).toBe('reviewer msg');
      expect(ctx.displayToUser).toHaveBeenCalledTimes(1);
      const entries = ctx.auditLogger.getEntries();
      expect(entries.length).toBeGreaterThan(0);
    });
  });
});
