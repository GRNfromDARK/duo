import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PromptLogAgent = 'coder' | 'reviewer' | 'god';

export interface PromptLogEntry {
  seq: number;
  timestamp: string;
  agent: PromptLogAgent;
  adapter: string;
  kind: string;
  prompt: string;
  systemPrompt: string | null;
  meta?: Record<string, unknown>;
}

export interface PromptLogEntryInput {
  agent: PromptLogAgent;
  adapter: string;
  kind: string;
  prompt: string;
  systemPrompt: string | null;
  meta?: Record<string, unknown>;
  timestamp?: string;
}

export const PROMPT_LOG_FILENAME = 'prompt-log.jsonl';

export function appendPromptLog(sessionDir: string, entry: PromptLogEntryInput): PromptLogEntry {
  const logger = new PromptLogger(sessionDir);
  return logger.append(entry);
}

export class PromptLogger {
  private readonly sessionDir: string;
  private seq: number;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
    this.seq = this.loadCurrentSeq();
  }

  append(entry: PromptLogEntryInput): PromptLogEntry {
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }

    this.seq += 1;
    const record: PromptLogEntry = {
      seq: this.seq,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      agent: entry.agent,
      adapter: entry.adapter,
      kind: entry.kind,
      prompt: entry.prompt,
      systemPrompt: entry.systemPrompt,
      ...(entry.meta ? { meta: entry.meta } : {}),
    };

    appendFileSync(join(this.sessionDir, PROMPT_LOG_FILENAME), JSON.stringify(record) + '\n');
    return record;
  }

  getEntries(): PromptLogEntry[] {
    const logPath = join(this.sessionDir, PROMPT_LOG_FILENAME);
    if (!existsSync(logPath)) return [];

    const content = readFileSync(logPath, 'utf-8');
    if (!content.trim()) return [];

    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as PromptLogEntry);
  }

  private loadCurrentSeq(): number {
    const logPath = join(this.sessionDir, PROMPT_LOG_FILENAME);
    if (!existsSync(logPath)) return 0;

    const content = readFileSync(logPath, 'utf-8');
    if (!content.trim()) return 0;

    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length === 0) return 0;

    try {
      const lastEntry = JSON.parse(lines[lines.length - 1]) as Partial<PromptLogEntry>;
      return typeof lastEntry.seq === 'number' ? lastEntry.seq : 0;
    } catch {
      return 0;
    }
  }
}
