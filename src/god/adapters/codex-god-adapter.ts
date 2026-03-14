import { execFile } from 'node:child_process';

import type { ExecOptions, OutputChunk } from '../../types/adapter.js';
import type { GodAdapter, GodExecOptions } from '../../types/god-adapter.js';
import { ProcessManager, ProcessTimeoutError } from '../../adapters/process-manager.js';
import { JsonlParser } from '../../parsers/jsonl-parser.js';
import { buildAdapterEnv } from '../../adapters/env-builder.js';

function buildCodexGodPrompt(systemPrompt: string, prompt: string): string {
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

export class CodexGodAdapter implements GodAdapter {
  readonly name = 'codex';
  readonly displayName = 'Codex';
  readonly version = '0.0.0';
  readonly toolUsePolicy = 'allow-readonly' as const;
  readonly minimumTimeoutMs = 90_000;

  private processManager: ProcessManager;
  private parser: JsonlParser;

  constructor() {
    this.processManager = new ProcessManager();
    this.parser = new JsonlParser();
  }

  async isInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('codex', ['--version'], { timeout: 5000 }, (err) => {
        resolve(!err);
      });
    });
  }

  async getVersion(): Promise<string> {
    return new Promise((resolve) => {
      execFile('codex', ['--version'], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve('unknown');
          return;
        }
        const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
        resolve(match ? match[1] : 'unknown');
      });
    });
  }

  buildArgs(
    prompt: string,
    opts: GodExecOptions,
    extra?: { skipGitCheck?: boolean },
  ): string[] {
    const args = [
      'exec',
      buildCodexGodPrompt(opts.systemPrompt, prompt),
      '--json',
      '--sandbox',
      'read-only',
      '--ephemeral',
    ];

    if (extra?.skipGitCheck) {
      args.push('--skip-git-repo-check');
    }

    return args;
  }

  async *execute(prompt: string, opts: GodExecOptions): AsyncIterable<OutputChunk> {
    const isGitRepo = await this.checkGitRepo(opts.cwd);
    if (!isGitRepo) {
      yield {
        type: 'status',
        content: 'Warning: Not a git repository. Codex works best in git repositories.',
        timestamp: Date.now(),
      };
    }

    const args = this.buildArgs(prompt, opts, { skipGitCheck: !isGitRepo });
    const { env, replaceEnv } = buildAdapterEnv({
      requiredPrefixes: ['OPENAI_'],
    });

    const execOpts: ExecOptions & GodExecOptions = {
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt,
      timeoutMs: opts.timeoutMs,
      timeout: opts.timeoutMs,
      env,
      replaceEnv,
    };

    const child = this.processManager.spawn('codex', args, execOpts);
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
            try { controller.enqueue(JSON.stringify({ type: 'status', content: msg, source: 'stderr' }) + '\n'); } catch { /* stream closed */ }
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

  private checkGitRepo(cwd: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 3000 }, (err) => {
        resolve(!err);
      });
    });
  }
}
