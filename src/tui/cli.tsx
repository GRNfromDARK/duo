import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import React from 'react';
import * as path from 'node:path';

import { detectInstalledCLIs } from '../adapters/detect.js';
import { handleResume } from '../cli-commands.js';
import { sanitizeGodAdapterForResume } from '../god/god-adapter-config.js';
import { parseStartArgs, createSessionConfig } from '../session/session-starter.js';
import type { LoadedSession } from '../session/session-manager.js';
import type { SessionConfig } from '../types/session.js';
import { App } from '../ui/components/App.js';
import { TuiApp } from './app.js';

interface AppRenderProps {
  initialConfig?: SessionConfig;
  resumeSession?: LoadedSession;
}

async function renderNode(node: React.ReactNode, options?: {
  alternateScreen?: boolean;
  autoExitMs?: number;
}): Promise<void> {
  // Enable wcwidth-based character width calculations so that CJK double-wide
  // characters (Chinese, Japanese, Korean) are measured as 2 terminal columns.
  // This prevents the cursor from drifting left by 1 column per CJK character.
  // OPENTUI_FORCE_WCWIDTH is forwarded to the native Zig renderer during
  // createCliRenderer initialisation; it must be set before the call.
  if (!process.env.OPENTUI_FORCE_WCWIDTH) {
    process.env.OPENTUI_FORCE_WCWIDTH = 'true';
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: options?.alternateScreen ?? true,
    useConsole: false,
  });

  const root = createRoot(renderer);
  root.render(node);

  if (options?.autoExitMs) {
    await new Promise((resolve) => setTimeout(resolve, options.autoExitMs));
    root.unmount();
    renderer.destroy();
    return;
  }

  await new Promise<void>((resolve) => {
    renderer.once('destroy', () => resolve());
  });
}

async function renderApp(props: AppRenderProps, autoExitMs?: number): Promise<void> {
  const detected = await detectInstalledCLIs();

  await renderNode(
    React.createElement(App, {
      ...props,
      detected,
    }),
    { autoExitMs },
  );
}

function buildResumeConfig(session: LoadedSession, detected: Awaited<ReturnType<typeof detectInstalledCLIs>>): SessionConfig {
  const resolvedGod = sanitizeGodAdapterForResume(
    session.metadata.reviewer,
    detected,
    session.metadata.god,
  );

  for (const warning of resolvedGod.warnings) {
    console.warn(`Warning: ${warning}`);
  }

  return {
    projectDir: session.metadata.projectDir,
    coder: session.metadata.coder,
    reviewer: session.metadata.reviewer,
    god: resolvedGod.god,
    task: session.metadata.task,
    coderModel: session.metadata.coderModel,
    reviewerModel: session.metadata.reviewerModel,
    godModel: session.metadata.godModel,
  };
}

async function runSmokeTest(): Promise<void> {
  await renderNode(
    React.createElement(TuiApp, {
      title: 'Duo OpenTUI bootstrap ready',
      body: 'Duo OpenTUI bootstrap ready',
    }),
    {
      alternateScreen: false,
      autoExitMs: 30,
    },
  );
}

async function runStart(argv: string[], smokeTest: boolean): Promise<void> {
  const detected = await detectInstalledCLIs();
  const parsed = parseStartArgs(argv);
  let initialConfig: SessionConfig | undefined;

  if (parsed.coder && parsed.reviewer && parsed.task) {
    const result = await createSessionConfig(parsed, detected);

    if (!result.validation.valid) {
      for (const error of result.validation.errors) {
        console.error(`Error: ${error}`);
      }
      process.exit(1);
      return;
    }

    for (const warning of result.validation.warnings) {
      console.warn(`Warning: ${warning}`);
    }

    initialConfig = result.config ?? undefined;
  }

  await renderNode(
    React.createElement(App, {
      initialConfig,
      detected,
    }),
    smokeTest ? { autoExitMs: 30 } : undefined,
  );
}

async function runResume(sessionId: string, smokeTest: boolean): Promise<void> {
  const sessionsDir = path.join(process.cwd(), '.duo', 'sessions');
  const result = handleResume(sessionId, sessionsDir, console.log);

  if (!result.success || !result.session) {
    process.exit(1);
    return;
  }

  if (smokeTest) {
    await renderNode(
      React.createElement(TuiApp, {
        title: result.session.metadata.task,
        body: result.session.history.map((entry) => entry.content).join('\n\n'),
      }),
      {
        alternateScreen: false,
        autoExitMs: 30,
      },
    );
    return;
  }

  const detected = await detectInstalledCLIs();
  const initialConfig = buildResumeConfig(result.session, detected);

  await renderNode(
    React.createElement(App, {
      initialConfig,
      detected,
      resumeSession: result.session,
    }),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const smokeTest = args.includes('--smoke-test');
  const filteredArgs = args.filter((arg) => arg !== '--smoke-test');
  const command = filteredArgs[0];

  if (smokeTest && (!command || command === 'start')) {
    await runSmokeTest();
    return;
  }

  if (command === 'resume' && filteredArgs[1]) {
    await runResume(filteredArgs[1], smokeTest);
    return;
  }

  if (command === 'start') {
    await runStart(filteredArgs, smokeTest);
    return;
  }

  await runStart(['start', ...filteredArgs], smokeTest);
}

void main().catch((error) => {
  console.error('Failed to start Duo OpenTUI:', error);
  process.exit(1);
});
