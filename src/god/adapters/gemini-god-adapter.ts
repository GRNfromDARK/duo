import { execFile } from 'node:child_process';

import type { ExecOptions, OutputChunk } from '../../types/adapter.js';
import type { GodAdapter, GodExecOptions } from '../../types/god-adapter.js';
import { ProcessManager, ProcessTimeoutError } from '../../adapters/process-manager.js';
import { StreamJsonParser } from '../../parsers/stream-json-parser.js';
import { buildAdapterEnv } from '../../adapters/env-builder.js';

function buildGeminiGodPrompt(systemPrompt: string, prompt: string): string {
  return [
    'SYSTEM EXECUTION MODE',
    'This is a hidden orchestrator sub-call for Duo, not a normal user conversation.',
    'Do not solve the underlying task directly unless the decision point explicitly asks you to.',
    'Return only the final decision/output requested by the prompt.',
    '',
    'SYSTEM ROLE',
    systemPrompt,
    '',
    'USER TASK',
    prompt,
    '',
    'You must act only as the God orchestrator for Duo.',
  ].join('\n');
}

export class GeminiGodAdapter implements GodAdapter {
  readonly name = 'gemini';
  readonly displayName = 'Gemini CLI';
  readonly version = '0.0.0';
  readonly toolUsePolicy = 'forbid' as const;

  private processManager: ProcessManager;
  private parser: StreamJsonParser;
  private lastSessionId: string | null = null;

  constructor() {
    this.processManager = new ProcessManager();
    this.parser = new StreamJsonParser();
  }

  async isInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('gemini', ['--version'], { timeout: 5000 }, (err) => {
        resolve(!err);
      });
    });
  }

  async getVersion(): Promise<string> {
    return new Promise((resolve) => {
      execFile('gemini', ['--version'], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve('unknown');
          return;
        }
        const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
        resolve(match ? match[1] : 'unknown');
      });
    });
  }

  buildArgs(prompt: string, opts: GodExecOptions): string[] {
    const isResuming = this.lastSessionId !== null;

    const effectivePrompt = isResuming
      ? prompt
      : buildGeminiGodPrompt(opts.systemPrompt, prompt);

    const args = [
      '-p', effectivePrompt,
      '--output-format', 'stream-json',
      '--yolo',
    ];

    if (isResuming) {
      args.push('--resume', this.lastSessionId!);
    }

    if (opts.model) {
      args.push('--model', opts.model);
    }

    args.push('--include-directories', opts.cwd);
    return args;
  }

  async *execute(prompt: string, opts: GodExecOptions): AsyncIterable<OutputChunk> {
    const args = this.buildArgs(prompt, opts);

    const { env, replaceEnv } = buildAdapterEnv({
      requiredPrefixes: ['GOOGLE_', 'GEMINI_'],
    });

    const execOpts: ExecOptions & GodExecOptions = {
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt,
      timeoutMs: opts.timeoutMs,
      timeout: opts.timeoutMs,
      env,
      replaceEnv,
    };

    const child = this.processManager.spawn('gemini', args, execOpts);
    const stdout = child.stdout;
    if (!stdout) {
      return;
    }

    const pm = this.processManager;
    const stderr = child.stderr;
    let onProcessComplete: ((payload: { timedOut?: boolean }) => void) | null = null;
    const cleanupListeners = () => {
      if (onProcessComplete) pm.removeListener('process-complete', onProcessComplete);
    };

    const stream = new ReadableStream<string>({
      start(controller) {
        onProcessComplete = (payload: { timedOut?: boolean }) => {
          cleanupListeners();
          if (payload?.timedOut) {
            try { controller.error(new ProcessTimeoutError()); } catch { /* stream may already be closed */ }
          } else {
            try { controller.close(); } catch { /* stream may already be closed */ }
          }
        };
        pm.once('process-complete', onProcessComplete);

        stdout.on('data', (data: Buffer) => {
          try { controller.enqueue(data.toString()); } catch { /* stream closed */ }
        });
        stderr?.on('data', (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) {
            try { controller.enqueue(JSON.stringify({ type: 'error', content: msg }) + '\n'); } catch { /* stream closed */ }
          }
        });
        stdout.on('error', (err: Error) => {
          cleanupListeners();
          controller.error(err);
        });
        stderr?.on('error', () => { /* ignore stderr pipe errors */ });
      },
      cancel() {
        cleanupListeners();
      },
    });

    const wasResuming = this.lastSessionId !== null;
    let sessionIdUpdated = false;

    try {
      for await (const chunk of this.parser.parse(stream)) {
        // Capture session_id from status chunks
        if (chunk.type === 'status' && chunk.metadata?.session_id) {
          this.lastSessionId = chunk.metadata.session_id as string;
          sessionIdUpdated = true;
        }
        yield chunk;
      }
    } catch (err) {
      if (wasResuming) {
        this.lastSessionId = null;
      }
      throw err;
    } finally {
      // If we were resuming but no new session_id was captured, clear stale ID
      // (must be inside finally — generator .return() skips code after try/finally)
      if (wasResuming && !sessionIdUpdated) {
        this.lastSessionId = null;
      }
      if (this.processManager.isRunning()) {
        await this.processManager.kill();
      }
    }
  }

  async kill(): Promise<void> {
    await this.processManager.kill();
  }

  isRunning(): boolean {
    return this.processManager.isRunning();
  }

  hasActiveSession(): boolean {
    return this.lastSessionId !== null;
  }

  getLastSessionId(): string | null {
    return this.lastSessionId;
  }

  restoreSessionId(id: string): void {
    this.lastSessionId = id;
  }

  clearSession(): void {
    this.lastSessionId = null;
  }
}
