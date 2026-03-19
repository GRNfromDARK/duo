/**
 * Regression test: stale session ID must be cleared when the async generator
 * is interrupted (consumer calls .return() via break/throw).
 *
 * Bug: cleanup code was placed AFTER the try/finally block in God adapters,
 * so it never ran when the generator was interrupted by .return().
 * Fix: moved cleanup inside the finally block, matching the worker adapter pattern.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../../../adapters/process-manager.js', () => {
  const EventEmitter = require('node:events').EventEmitter;

  class MockProcessManager extends EventEmitter {
    spawn = vi.fn();
    kill = vi.fn().mockResolvedValue(undefined);
    isRunning = vi.fn().mockReturnValue(false);
    dispose = vi.fn();
  }

  return { ProcessManager: MockProcessManager, ProcessTimeoutError: class extends Error {} };
});

import { ClaudeCodeGodAdapter } from '../../../god/adapters/claude-code-god-adapter.js';
import { GeminiGodAdapter } from '../../../god/adapters/gemini-god-adapter.js';
import { ProcessManager } from '../../../adapters/process-manager.js';

// ── Helpers ──

const baseOpts = {
  cwd: '/tmp/project',
  systemPrompt: 'You are God.',
  timeoutMs: 30_000,
};

/**
 * Build a stream-json assistant event that StreamJsonParser will map to
 * an OutputChunk.  The parser's mapAssistantEvent() requires
 * message.content to be an **array** of content items (see
 * getMessageContentItems → Array.isArray check).
 */
function assistantTextEvent(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
}

/**
 * Set up the mock ProcessManager to emit valid stream-json data through stdout,
 * then signal process-complete so the ReadableStream closes.
 */
function setupMockSpawn(pm: ProcessManager, stdoutLines: string[]) {
  const { Readable } = require('node:stream');

  const stdout = new Readable({
    read() {
      for (const line of stdoutLines) {
        this.push(line + '\n');
      }
      this.push(null);
    },
  });
  const stderr = new Readable({ read() { this.push(null); } });

  const mockChild = { stdout, stderr, pid: 99999, on: vi.fn(), once: vi.fn() };

  (pm.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
    // After stdout ends, signal process-complete so the stream closes
    stdout.on('end', () => {
      setTimeout(() => (pm as any).emit('process-complete', { exitCode: 0, signal: null, timedOut: false }), 5);
    });
    return mockChild;
  });
}

// ── Tests: ClaudeCodeGodAdapter ──

describe('ClaudeCodeGodAdapter session cleanup on generator interrupt', () => {
  let adapter: ClaudeCodeGodAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new ClaudeCodeGodAdapter();
  });

  it('clears stale session ID when consumer breaks out of iteration (generator .return())', async () => {
    const pm = (adapter as any).processManager as ProcessManager;

    // Two real text chunks so we can break after the first
    setupMockSpawn(pm, [
      assistantTextEvent('chunk1'),
      assistantTextEvent('chunk2'),
    ]);

    adapter.restoreSessionId('ses_stale_123');
    expect(adapter.hasActiveSession()).toBe(true);

    // Iterate and break after first chunk — triggers generator .return()
    let receivedCount = 0;
    for await (const chunk of adapter.execute('test prompt', baseOpts)) {
      receivedCount++;
      expect(chunk.type).toBe('text');
      expect(chunk.content).toBe('chunk1');
      break; // <-- this calls .return() on the async generator
    }

    // Prove at least one chunk was yielded before break
    expect(receivedCount).toBe(1);
    // The stale session ID must be cleared (was resuming, no new session_id captured)
    expect(adapter.getLastSessionId()).toBeNull();
    expect(adapter.hasActiveSession()).toBe(false);
  });

  it('clears stale session ID when iteration completes normally without new session_id', async () => {
    const pm = (adapter as any).processManager as ProcessManager;

    setupMockSpawn(pm, [
      assistantTextEvent('done'),
    ]);

    adapter.restoreSessionId('ses_stale_456');

    const chunks = [];
    for await (const chunk of adapter.execute('test prompt', baseOpts)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(adapter.getLastSessionId()).toBeNull();
  });

  it('preserves new session ID when stream provides one', async () => {
    const pm = (adapter as any).processManager as ProcessManager;

    setupMockSpawn(pm, [
      JSON.stringify({ type: 'system', session_id: 'ses_new_789' }),
      assistantTextEvent('ok'),
    ]);

    adapter.restoreSessionId('ses_old');

    const chunks = [];
    for await (const chunk of adapter.execute('test prompt', baseOpts)) {
      chunks.push(chunk);
    }

    // system event → status chunk, assistant event → text chunk
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(adapter.getLastSessionId()).toBe('ses_new_789');
  });
});

// ── Tests: GeminiGodAdapter ──

describe('GeminiGodAdapter session cleanup on generator interrupt', () => {
  let adapter: GeminiGodAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new GeminiGodAdapter();
  });

  it('clears stale session ID when consumer breaks out of iteration (generator .return())', async () => {
    const pm = (adapter as any).processManager as ProcessManager;

    setupMockSpawn(pm, [
      assistantTextEvent('chunk1'),
      assistantTextEvent('chunk2'),
    ]);

    adapter.restoreSessionId('ses_gemini_stale');
    expect(adapter.hasActiveSession()).toBe(true);

    let receivedCount = 0;
    for await (const chunk of adapter.execute('test prompt', baseOpts)) {
      receivedCount++;
      expect(chunk.type).toBe('text');
      expect(chunk.content).toBe('chunk1');
      break;
    }

    expect(receivedCount).toBe(1);
    expect(adapter.getLastSessionId()).toBeNull();
    expect(adapter.hasActiveSession()).toBe(false);
  });

  it('clears stale session ID when iteration completes normally without new session_id', async () => {
    const pm = (adapter as any).processManager as ProcessManager;

    setupMockSpawn(pm, [
      assistantTextEvent('done'),
    ]);

    adapter.restoreSessionId('ses_gemini_old');

    const chunks = [];
    for await (const chunk of adapter.execute('test prompt', baseOpts)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(adapter.getLastSessionId()).toBeNull();
  });
});
