import { execFile } from 'node:child_process';

import type { ExecOptions, OutputChunk } from '../../types/adapter.js';
import type { GodAdapter, GodExecOptions } from '../../types/god-adapter.js';
import { ProcessManager, ProcessTimeoutError } from '../../adapters/process-manager.js';
import { StreamJsonParser } from '../../parsers/stream-json-parser.js';
import { buildAdapterEnv } from '../../adapters/env-builder.js';

export class ClaudeCodeGodAdapter implements GodAdapter {
  readonly name = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly version = '0.0.0';
  readonly toolUsePolicy = 'forbid' as const;

  private processManager: ProcessManager;
  private parser: StreamJsonParser;

  constructor() {
    this.processManager = new ProcessManager();
    this.parser = new StreamJsonParser();
  }

  async isInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('claude', ['--version'], { timeout: 5000 }, (err) => {
        resolve(!err);
      });
    });
  }

  async getVersion(): Promise<string> {
    return new Promise((resolve) => {
      execFile('claude', ['--version'], { timeout: 5000 }, (err, stdout) => {
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
    return [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--system-prompt', opts.systemPrompt,
      '--tools', '',
      '--add-dir', opts.cwd,
    ];
  }

  async *execute(prompt: string, opts: GodExecOptions): AsyncIterable<OutputChunk> {
    const args = this.buildArgs(prompt, opts);

    const { env, replaceEnv } = buildAdapterEnv({
      requiredPrefixes: ['ANTHROPIC_', 'CLAUDE_'],
    });
    delete env.CLAUDECODE;

    const execOpts: ExecOptions & GodExecOptions = {
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt,
      timeoutMs: opts.timeoutMs,
      timeout: opts.timeoutMs,
      env,
      replaceEnv,
    };

    const child = this.processManager.spawn('claude', args, execOpts);
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

    try {
      for await (const chunk of this.parser.parse(stream)) {
        yield chunk;
      }
    } finally {
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
}
