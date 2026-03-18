import type { GodAdapter } from '../types/god-adapter.js';
import { appendPromptLog } from '../session/prompt-log.js';

export interface GodCallLoggingOptions {
  sessionDir: string;
  kind: string;
  meta?: Record<string, unknown>;
}

export interface GodCallOptions {
  adapter: GodAdapter;
  prompt: string;
  systemPrompt: string;
  projectDir?: string;
  timeoutMs: number;
  /** Optional model override for the God adapter. */
  model?: string;
  logging?: GodCallLoggingOptions;
}

// AI-REVIEW: God adapter 调用统一入口，prompt 日志写入确保 FR-018 审计可追溯 (AC-053~056)。
export async function collectGodAdapterOutput(options: GodCallOptions): Promise<string> {
  const { adapter, prompt, systemPrompt, projectDir, timeoutMs, model, logging } = options;
  const chunks: string[] = [];
  const effectiveTimeoutMs = Math.max(timeoutMs, adapter.minimumTimeoutMs ?? timeoutMs);

  if (logging) {
    appendPromptLog(logging.sessionDir, {
      agent: 'god',
      adapter: adapter.name,
      kind: logging.kind,
      prompt,
      systemPrompt,
      ...(logging.meta ? { meta: logging.meta } : {}),
    });
  }

  try {
    for await (const chunk of adapter.execute(prompt, {
      cwd: projectDir ?? process.cwd(),
      systemPrompt,
      timeoutMs: effectiveTimeoutMs,
      model,
    })) {
      if (chunk.type === 'tool_use' || chunk.type === 'tool_result') {
        if (adapter.toolUsePolicy !== 'allow-readonly') {
          throw new Error(`God adapter ${adapter.name} attempted tool use, which is not allowed`);
        }
        continue;
      }

      if (chunk.type === 'text' || chunk.type === 'code' || chunk.type === 'error') {
        chunks.push(chunk.content);
      }
    }

    return chunks.join('');
  } finally {
    if (typeof adapter.isRunning === 'function' && adapter.isRunning()) {
      await adapter.kill().catch(() => {});
    }
  }
}
