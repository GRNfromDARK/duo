import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { OutputChunk } from '../../types/adapter.js';
import type { GodAdapter, GodExecOptions } from '../../types/god-adapter.js';
import { collectGodAdapterOutput } from '../../god/god-call.js';

interface MockAdapterState {
  adapter: GodAdapter;
  getKillCount(): number;
  getLastPrompt(): string | undefined;
  getLastOptions(): GodExecOptions | undefined;
}

function createMockAdapter(
  chunks: OutputChunk[],
  name = 'codex',
  toolUsePolicy: GodAdapter['toolUsePolicy'] = 'forbid',
  minimumTimeoutMs?: number,
): MockAdapterState {
  let killCount = 0;
  let lastPrompt: string | undefined;
  let lastOptions: GodExecOptions | undefined;

  return {
    adapter: {
      name,
      displayName: 'Mock God',
      version: '1.0.0',
      toolUsePolicy,
      minimumTimeoutMs,
      isInstalled: async () => true,
      getVersion: async () => '1.0.0',
      execute(prompt: string, opts: GodExecOptions): AsyncIterable<OutputChunk> {
        lastPrompt = prompt;
        lastOptions = opts;
        return {
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) {
              yield chunk;
            }
          },
        };
      },
      kill: async () => {
        killCount++;
      },
      isRunning: () => false,
    },
    getKillCount: () => killCount,
    getLastPrompt: () => lastPrompt,
    getLastOptions: () => lastOptions,
  };
}

describe('collectGodAdapterOutput', () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-god-call-'));
    sessionDir = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clears the timeout after a successful response', async () => {
    vi.useFakeTimers();
    const { adapter, getKillCount } = createMockAdapter([
      { type: 'text', content: 'ok', timestamp: Date.now() },
    ]);

    const promise = collectGodAdapterOutput({
      adapter,
      prompt: 'user prompt',
      systemPrompt: 'system prompt',
      timeoutMs: 30_000,
    });

    await expect(promise).resolves.toBe('ok');
    await vi.runAllTimersAsync();

    expect(getKillCount()).toBe(0);
  });

  it('passes God execution options through to the adapter', async () => {
    const { adapter, getLastPrompt, getLastOptions } = createMockAdapter([
      { type: 'text', content: 'ok', timestamp: Date.now() },
    ], 'codex', 'allow-readonly');

    await expect(
      collectGodAdapterOutput({
        adapter,
        prompt: 'user prompt',
        systemPrompt: 'system prompt',
        timeoutMs: 30_000,
        projectDir: '/tmp/project',
      }),
    ).resolves.toBe('ok');

    expect(getLastPrompt()).toBe('user prompt');
    expect(getLastOptions()).toEqual({
      cwd: '/tmp/project',
      systemPrompt: 'system prompt',
      timeoutMs: 30_000,
    });
  });

  it('writes the full God prompt and system prompt to prompt-log.jsonl when session logging is enabled', async () => {
    const { adapter } = createMockAdapter([
      { type: 'text', content: 'ok', timestamp: Date.now() },
    ], 'codex', 'allow-readonly');

    await expect(
      collectGodAdapterOutput({
        adapter,
        prompt: 'full god prompt',
        systemPrompt: 'full system prompt',
        timeoutMs: 30_000,
        logging: {
          sessionDir,
          kind: 'god_post_reviewer',
          meta: { attempt: 2 },
        },
      }),
    ).resolves.toBe('ok');

    const logPath = path.join(sessionDir, 'prompt-log.jsonl');
    const [line] = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(line) as {
      agent: string;
      adapter: string;
      kind: string;
      prompt: string;
      systemPrompt: string | null;
      meta?: Record<string, unknown>;
    };

    expect(entry.agent).toBe('god');
    expect(entry.adapter).toBe('codex');
    expect(entry.kind).toBe('god_post_reviewer');
    expect(entry.prompt).toBe('full god prompt');
    expect(entry.systemPrompt).toBe('full system prompt');
    expect(entry.meta).toEqual({ attempt: 2 });
  });

  it('raises timeoutMs to the adapter minimum when required', async () => {
    const { adapter, getLastOptions } = createMockAdapter([
      { type: 'text', content: 'ok', timestamp: Date.now() },
    ], 'codex', 'allow-readonly', 90_000);

    await expect(
      collectGodAdapterOutput({
        adapter,
        prompt: 'user prompt',
        systemPrompt: 'system prompt',
        timeoutMs: 30_000,
      }),
    ).resolves.toBe('ok');

    expect(getLastOptions()).toEqual({
      cwd: process.cwd(),
      systemPrompt: 'system prompt',
      timeoutMs: 90_000,
    });
  });

  it('passes systemPrompt separately for Claude adapters', async () => {
    const { adapter, getLastPrompt, getLastOptions } = createMockAdapter([
      { type: 'text', content: 'ok', timestamp: Date.now() },
    ], 'claude-code');

    await expect(
      collectGodAdapterOutput({
        adapter,
        prompt: 'user prompt',
        systemPrompt: 'system prompt',
        timeoutMs: 30_000,
      }),
    ).resolves.toBe('ok');

    expect(getLastPrompt()).toBe('user prompt');
    expect(getLastOptions()).toEqual({
      cwd: process.cwd(),
      systemPrompt: 'system prompt',
      timeoutMs: 30_000,
    });
  });

  it('rejects God adapters that attempt tool use', async () => {
    const { adapter } = createMockAdapter([
      { type: 'tool_use', content: 'ls -la', timestamp: Date.now() },
    ]);

    await expect(
      collectGodAdapterOutput({
        adapter,
        prompt: 'user prompt',
        systemPrompt: 'system prompt',
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/attempted tool use/i);
  });

  it('allows read-only tool use for Codex God adapters and returns the final text', async () => {
    const { adapter } = createMockAdapter([
      { type: 'tool_use', content: 'find . -type f', timestamp: Date.now() },
      { type: 'tool_result', content: '42', timestamp: Date.now() },
      { type: 'text', content: '```json\n{"taskType":"explore"}\n```', timestamp: Date.now() },
    ], 'codex', 'allow-readonly');

    await expect(
      collectGodAdapterOutput({
        adapter,
        prompt: 'user prompt',
        systemPrompt: 'system prompt',
        timeoutMs: 30_000,
      }),
    ).resolves.toContain('"taskType":"explore"');
  });
});
