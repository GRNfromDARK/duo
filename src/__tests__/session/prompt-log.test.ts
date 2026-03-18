import { beforeEach, afterEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PromptLogger, appendPromptLog } from '../../session/prompt-log.js';

let tmpDir: string;
let sessionDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-prompt-log-'));
  sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PromptLogger', () => {
  test('appendPromptLog writes full prompt entries without truncation', () => {
    const prompt = 'A'.repeat(4096);
    appendPromptLog(sessionDir, {
      agent: 'coder',
      adapter: 'claude-code',
      kind: 'coder_round',
      prompt,
      systemPrompt: null,
      meta: {
        promptSource: 'god_dynamic',
        phaseId: 'phase-2',
      },
    });

    const logPath = path.join(sessionDir, 'prompt-log.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);

    const [line] = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(line) as {
      seq: number;
      agent: string;
      adapter: string;
      kind: string;
      prompt: string;
      systemPrompt: string | null;
      meta?: Record<string, unknown>;
      timestamp: string;
    };

    expect(entry.seq).toBe(1);
    expect(entry.agent).toBe('coder');
    expect(entry.adapter).toBe('claude-code');
    expect(entry.kind).toBe('coder_round');
    expect(entry.prompt).toBe(prompt);
    expect(entry.systemPrompt).toBeNull();
    expect(entry.meta).toEqual({
      promptSource: 'god_dynamic',
      phaseId: 'phase-2',
    });
    expect(entry.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('PromptLogger preserves sequence across new logger instances', () => {
    const loggerA = new PromptLogger(sessionDir);
    loggerA.append({
      agent: 'god',
      adapter: 'codex',
      kind: 'god_task_init',
      prompt: 'classify task',
      systemPrompt: 'system a',
    });

    const loggerB = new PromptLogger(sessionDir);
    loggerB.append({
      agent: 'reviewer',
      adapter: 'codex',
      kind: 'reviewer_round',
      prompt: 'review code',
      systemPrompt: null,
    });

    const entries = loggerB.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].seq).toBe(1);
    expect(entries[0].systemPrompt).toBe('system a');
    expect(entries[1].seq).toBe(2);
    expect(entries[1].agent).toBe('reviewer');
    expect(entries[1].kind).toBe('reviewer_round');
  });
});
