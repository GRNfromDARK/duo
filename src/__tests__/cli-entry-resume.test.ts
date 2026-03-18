import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedSession } from '../session/session-manager.js';

const renderMock = vi.fn(() => ({
  waitUntilExit: vi.fn().mockResolvedValue(undefined),
}));
const handleResumeMock = vi.fn();
const detectInstalledCLIsMock = vi.fn();
const enterAlternateScreenMock = vi.fn(() => vi.fn());
const createTerminalInputMock = vi.fn(() => ({
  stdin: process.stdin,
  cleanup: vi.fn(),
}));

vi.mock('ink', () => ({
  render: renderMock,
}));

vi.mock('../cli-commands.js', () => ({
  handleResume: handleResumeMock,
  handleResumeList: vi.fn(),
}));

vi.mock('../adapters/detect.js', () => ({
  detectInstalledCLIs: detectInstalledCLIsMock,
}));

vi.mock('../ui/alternate-screen.js', () => ({
  enterAlternateScreen: enterAlternateScreenMock,
}));

vi.mock('../ui/mouse-input.js', () => ({
  createTerminalInput: createTerminalInputMock,
}));

vi.mock('../ui/components/App.js', () => ({
  App: function AppMock() {
    return null;
  },
}));

describe('cli resume entry', () => {
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.argv = ['node', 'src/cli.ts', 'resume', 'session-123'];
    process.exit = vi.fn() as never;
    console.log = vi.fn();
    console.error = vi.fn();
    console.warn = vi.fn();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  });

  it('renders the App with the loaded session when resuming a specific session', async () => {
    const session: LoadedSession = {
      metadata: {
        id: 'session-123',
        projectDir: '/tmp/project',
        coder: 'claude-code',
        reviewer: 'codex',
        task: 'Fix login',
        createdAt: 1,
        updatedAt: 2,
      },
      state: {
        status: 'reviewing',
        currentRole: 'reviewer',
      },
      history: [],
    };

    handleResumeMock.mockReturnValue({
      success: true,
      session,
    });
    detectInstalledCLIsMock.mockResolvedValue([
      {
        name: 'claude-code',
        displayName: 'Claude Code',
        command: 'claude',
        installed: true,
        version: '1.0.0',
      },
      {
        name: 'codex',
        displayName: 'Codex',
        command: 'codex',
        installed: true,
        version: '1.0.0',
      },
    ]);

    await import('../cli.js');
    await Promise.resolve();
    await Promise.resolve();

    expect(renderMock).toHaveBeenCalledTimes(1);
    const renderCalls = renderMock.mock.calls as unknown as Array<
      [{ props: Record<string, unknown> }]
    >;
    const renderedElement = renderCalls[0]![0];
    expect(renderedElement.props.initialConfig).toEqual({
      projectDir: '/tmp/project',
      coder: 'claude-code',
      reviewer: 'codex',
      god: 'codex',
      task: 'Fix login',
    });
    expect(renderedElement.props.resumeSession).toEqual(session);
  });

  it('sanitizes unsupported persisted God adapters on resume', async () => {
    const session: LoadedSession = {
      metadata: {
        id: 'session-unsupported-god',
        projectDir: '/tmp/project',
        coder: 'claude-code',
        reviewer: 'codex',
        god: 'old-unsupported-tool',
        task: 'Fix login',
        createdAt: 1,
        updatedAt: 2,
      },
      state: {
        status: 'reviewing',
        currentRole: 'reviewer',
      },
      history: [],
    };

    console.warn = vi.fn();
    handleResumeMock.mockReturnValue({
      success: true,
      session,
    });
    detectInstalledCLIsMock.mockResolvedValue([
      {
        name: 'claude-code',
        displayName: 'Claude Code',
        command: 'claude',
        installed: true,
        version: '1.0.0',
      },
      {
        name: 'codex',
        displayName: 'Codex',
        command: 'codex',
        installed: true,
        version: '1.0.0',
      },
    ]);

    await import('../cli.js');
    await Promise.resolve();
    await Promise.resolve();

    const renderCalls = renderMock.mock.calls as unknown as Array<
      [{ props: Record<string, unknown> }]
    >;
    const renderedElement = renderCalls[0]![0];
    expect(renderedElement.props.initialConfig).toEqual({
      projectDir: '/tmp/project',
      coder: 'claude-code',
      reviewer: 'codex',
      god: 'codex',
      task: 'Fix login',
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Persisted God adapter 'old-unsupported-tool'"));
  });
});
