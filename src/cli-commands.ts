/**
 * CLI command handlers for Duo.
 * Source: FR-001 (AC-001, AC-002, AC-003, AC-004), FR-002 (AC-005, AC-006, AC-007, AC-008)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectInstalledCLIs } from './adapters/detect.js';
import { parseStartArgs, createSessionConfig } from './session/session-starter.js';
import { SessionManager, SessionNotFoundError, SessionCorruptedError } from './session/session-manager.js';
import type { SessionConfig } from './types/session.js';
import type { LoadedSession, SessionSummary } from './session/session-manager.js';
import { GodAuditLogger } from './god/god-audit.js';

export interface HandleStartResult {
  success: boolean;
  config: SessionConfig | null;
  needsInteractive?: boolean;
}

export interface HandleResumeListResult {
  success: boolean;
  sessions: SessionSummary[];
}

export interface HandleResumeResult {
  success: boolean;
  session: LoadedSession | null;
}

/**
 * Handle `duo start` command.
 * Detects CLI tools, validates args, shows onboarding info.
 */
export async function handleStart(
  argv: string[],
  log: (msg: string) => void,
): Promise<HandleStartResult> {
  const args = parseStartArgs(argv);

  // Detect installed CLIs
  const detected = await detectInstalledCLIs();

  // Show onboarding: detected CLI tools
  log('');
  log('Detected CLI Tools:');
  for (const cli of detected) {
    const status = cli.installed
      ? `✓ ${cli.displayName} (${cli.version})`
      : `✗ ${cli.displayName} — not installed`;
    log(`  ${status}`);
  }
  log('');

  // Quick tips
  log('Quick Tips:');
  log('  • Use --coder and --reviewer to assign roles to CLI tools');
  log('  • Use --task to describe what you want to accomplish');
  log('  • Coder writes code, Reviewer gives feedback — they iterate automatically');
  log('');

  // Check if interactive mode is needed
  if (!args.coder || !args.reviewer || !args.task) {
    log('Missing required options. Use --coder, --reviewer, and --task, or run `duo start` for interactive mode.');
    return { success: false, config: null, needsInteractive: true };
  }

  // Create and validate session config
  const result = await createSessionConfig(args, detected);

  if (!result.validation.valid) {
    for (const err of result.validation.errors) {
      log(`Error: ${err}`);
    }
    return { success: false, config: null };
  }

  for (const warn of result.validation.warnings) {
    log(`Warning: ${warn}`);
  }

  log(`Session started: Coder=${result.config!.coder}, Reviewer=${result.config!.reviewer}`);
  log(`Task: ${result.config!.task}`);
  log(`Directory: ${result.config!.projectDir}`);

  return { success: true, config: result.config };
}

/**
 * Handle `duo resume` with no session ID — list available sessions.
 */
export function handleResumeList(
  sessionsDir: string,
  log: (msg: string) => void,
): HandleResumeListResult {
  const mgr = new SessionManager(sessionsDir);
  const sessions = mgr.listSessions();

  if (sessions.length === 0) {
    log('No sessions found. Start a new session with `duo start`.');
    return { success: true, sessions: [] };
  }

  log('');
  log('Available sessions:');
  log('');
  for (const s of sessions) {
    const time = new Date(s.updatedAt).toLocaleString();
    const projectName = s.projectDir.split('/').pop() ?? s.projectDir;
    log(`  ${s.id.slice(0, 8)}  ${projectName}  "${s.task}"  [${s.status}]  ${time}`);
  }
  log('');
  log('Resume a session: duo resume <session-id>');

  return { success: true, sessions };
}

/**
 * Handle `duo resume <session-id>` — restore a specific session.
 */
export function handleResume(
  sessionId: string,
  sessionsDir: string,
  log: (msg: string) => void,
): HandleResumeResult {
  const mgr = new SessionManager(sessionsDir);

  let loaded: LoadedSession;
  try {
    loaded = mgr.loadSession(sessionId);
  } catch (e) {
    if (e instanceof SessionCorruptedError) {
      log(`Error: Session data corrupted: ${sessionId}. You may need to manually repair or delete the session.`);
    } else {
      log(`Error: Session not found: ${sessionId}`);
    }
    return { success: false, session: null };
  }

  const validation = mgr.validateSessionRestore(sessionId);
  if (!validation.valid) {
    log(`Error: ${validation.error}`);
    return { success: false, session: null };
  }

  log(`Resuming session: ${loaded.metadata.task}`);
  log(`Coder=${loaded.metadata.coder}, Reviewer=${loaded.metadata.reviewer}`);
  log(`Status: ${loaded.state.status}`);
  log(`Directory: ${loaded.metadata.projectDir}`);

  return { success: true, session: loaded };
}

/**
 * Handle `duo log <session-id>` — display God audit log entries.
 * Source: FR-020
 */
export function handleLog(
  sessionId: string,
  options: { type?: string },
  sessionsDir: string,
  log: (msg: string) => void,
): void {
  const sessionDir = path.join(sessionsDir, sessionId);

  if (!fs.existsSync(sessionDir)) {
    log(`Error: Session not found: ${sessionId}`);
    return;
  }

  const logger = new GodAuditLogger(sessionDir);
  const entries = logger.getEntries(options.type ? { type: options.type } : undefined);

  if (entries.length === 0) {
    log('No audit entries found.');
    return;
  }

  log('');
  log(`God Audit Log — Session ${sessionId}`);
  if (options.type) {
    log(`Filter: type=${options.type}`);
  }
  log('');

  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleString();
    log(`[${entry.seq}] ${time}  ${entry.decisionType}`);
    log(`    Input:  ${entry.inputSummary}`);
    log(`    Output: ${entry.outputSummary}`);
    if (entry.latencyMs !== undefined) {
      log(`    Latency: ${entry.latencyMs}ms`);
    }
    if (entry.outputRef) {
      const refPath = path.join(sessionDir, entry.outputRef);
      if (fs.existsSync(refPath)) {
        log(`    Ref: ${entry.outputRef}`);
      } else {
        log(`    Ref: ${entry.outputRef} [deleted]`);
      }
    }
    log('');
  }

  log(`Total: ${entries.length} entries`);

  // Type breakdown
  const typeCounts = new Map<string, number>();
  for (const entry of entries) {
    typeCounts.set(entry.decisionType, (typeCounts.get(entry.decisionType) ?? 0) + 1);
  }
  log('');
  log('Type breakdown:');
  for (const [type, count] of typeCounts.entries()) {
    log(`  ${type}: ${count}`);
  }

  // Latency statistics
  const latencies = entries.filter(e => e.latencyMs !== undefined).map(e => e.latencyMs!);
  if (latencies.length > 0) {
    const sum = latencies.reduce((a, b) => a + b, 0);
    const avg = Math.round(sum / latencies.length);
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);
    log('');
    log(`Latency (${latencies.length} calls): avg ${avg}ms, min ${min}ms, max ${max}ms`);
  }
}
