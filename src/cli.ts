#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import { VERSION } from './index.js';
import { handleResumeList, handleLog } from './cli-commands.js';
import { buildOpenTuiLaunchSpec, resolveBunBinary } from './tui/runtime/bun-launcher.js';

const args = process.argv.slice(2);

function isVersionCommand(argv: string[]): boolean {
  return argv.includes('--version') || argv.includes('-v');
}

function isHelpCommand(argv: string[]): boolean {
  return argv[0] === 'help' || argv.includes('--help') || argv.includes('-h');
}

function shouldHandleInNode(argv: string[]): boolean {
  const command = argv[0];

  if (isVersionCommand(argv) || isHelpCommand(argv)) {
    return true;
  }

  if (command === 'log') {
    return true;
  }

  if (command === 'resume' && !argv[1]) {
    return true;
  }

  return false;
}

function handOffToOpenTui(argv: string[]): never {
  const bunBinary = resolveBunBinary({
    cwd: process.cwd(),
    env: process.env,
  });

  if (!bunBinary) {
    console.error('Bun is required for the OpenTUI runtime. Set DUO_BUN_BINARY or install Bun.');
    process.exit(1);
  }

  const spec = buildOpenTuiLaunchSpec({
    bunBinary,
    cwd: process.cwd(),
    argv,
  });

  const result = spawnSync(spec.command, spec.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  process.exit(result.status ?? 1);
}

if (shouldHandleInNode(args)) {
  const command = args[0];

  if (isVersionCommand(args)) {
    console.log(VERSION);
    process.exit(0);
  }

  if (command === 'resume') {
    handleResumeList(path.join(process.cwd(), '.duo', 'sessions'), console.log);
    process.exit(0);
  }

  if (command === 'log') {
    const sessionId = args[1];
    if (!sessionId) {
      console.log('Usage: duo log <session-id> [--type <type>]');
      process.exit(1);
    }

    const typeIdx = args.indexOf('--type');
    const type = typeIdx !== -1 ? args[typeIdx + 1] : undefined;
    handleLog(sessionId, { type }, path.join(process.cwd(), '.duo', 'sessions'), console.log);
    process.exit(0);
  }

  console.log(`Duo v${VERSION} — Multi AI Coding Assistant Collaboration Platform`);
  console.log('');
  console.log('Usage:');
  console.log('  duo                                                   Interactive mode (same as duo start)');
  console.log('  duo start --dir <path> --coder <cli> --reviewer <cli> --task <desc>');
  console.log('  duo resume                List resumable sessions');
  console.log('  duo resume <session-id>   Resume a session');
  console.log('  duo log <session-id>      Show God audit log');
  console.log('  duo log <id> --type <t>   Filter by decision type');
  console.log('  duo --version             Show version');
  console.log('');
  console.log('Options:');
  console.log('  --coder <cli>             CLI tool for coding (e.g. claude-code, codex)');
  console.log('  --reviewer <cli>          CLI tool for reviewing');
  console.log('  --coder-model <model>     Model override for coder (e.g. sonnet, gpt-5.4)');
  console.log('  --reviewer-model <model>  Model override for reviewer');
  console.log('  --god <cli>               CLI tool for God orchestrator');
  console.log('  --god-model <model>       Model override for God (e.g. opus, gemini-2.5-pro)');
  console.log('  --task <desc>             Task description');
  console.log('');
  console.log('Examples:');
  console.log('  duo --coder claude-code --reviewer codex --task "Add JWT auth"');
  console.log('  duo --coder claude-code --coder-model sonnet --reviewer codex --reviewer-model gpt-5.4 --task "Fix bug"');
  console.log('  duo   # Interactive setup wizard');
  process.exit(0);
}

handOffToOpenTui(args);
