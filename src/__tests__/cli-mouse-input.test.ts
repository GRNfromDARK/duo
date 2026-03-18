import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const waitUntilExitMock = vi.fn().mockResolvedValue(undefined);
const renderMock = vi.fn(() => ({
  waitUntilExit: waitUntilExitMock,
}));
const detectInstalledCLIsMock = vi.fn().mockResolvedValue([]);
const cleanupScreenMock = vi.fn();
const enterAlternateScreenMock = vi.fn(() => cleanupScreenMock);
const cleanupInputMock = vi.fn();
const proxyStdin = {
  isTTY: true,
  setEncoding: vi.fn(),
  setRawMode: vi.fn(),
  ref: vi.fn(),
  unref: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  read: vi.fn(),
} as unknown as NodeJS.ReadStream;
const createTerminalInputMock = vi.fn(() => ({
  stdin: proxyStdin,
  cleanup: cleanupInputMock,
}));

vi.mock('ink', () => ({
  render: renderMock,
}));

vi.mock('../adapters/detect.js', () => ({
  detectInstalledCLIs: detectInstalledCLIsMock,
}));

vi.mock('../cli-commands.js', () => ({
  handleResumeList: vi.fn(),
  handleResume: vi.fn(),
  handleLog: vi.fn(),
}));

vi.mock('../session/session-starter.js', () => ({
  parseStartArgs: vi.fn(() => ({})),
  createSessionConfig: vi.fn(),
}));

vi.mock('../god/god-adapter-config.js', () => ({
  sanitizeGodAdapterForResume: vi.fn(),
}));

vi.mock('../ui/components/App.js', () => ({
  App: function AppMock() {
    return null;
  },
}));

vi.mock('../ui/alternate-screen.js', () => ({
  enterAlternateScreen: enterAlternateScreenMock,
}));

vi.mock('../ui/mouse-input.js', () => ({
  createTerminalInput: createTerminalInputMock,
}));

describe('cli mouse input wiring', () => {
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalError = console.error;
  const originalWarn = console.warn;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.argv = ['node', 'src/cli.ts'];
    process.exit = vi.fn() as never;
    console.error = vi.fn();
    console.warn = vi.fn();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    console.error = originalError;
    console.warn = originalWarn;
  });

  it('passes the backend-specific stdin proxy to Ink and cleans it up after exit', async () => {
    await import('../cli.js');
    await Promise.resolve();
    await Promise.resolve();

    expect(createTerminalInputMock).toHaveBeenCalledWith(process.stdin);
    expect(enterAlternateScreenMock).toHaveBeenCalledWith(process.stdout);

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect((renderMock.mock.calls as unknown[][])[0]?.[1]).toMatchObject({
      exitOnCtrlC: false,
      stdin: proxyStdin,
    });

    expect(cleanupInputMock).toHaveBeenCalledTimes(1);
    expect(cleanupScreenMock).toHaveBeenCalledTimes(1);
  });
});
