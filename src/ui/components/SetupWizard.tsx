/**
 * SetupWizard — v2 setup wizard with progress stepper, branded header,
 * and confirmation screen before session launch.
 */

import React, { useState, useRef } from 'react';
import { Box, Text, useInput } from '../../tui/primitives.js';
import { DirectoryPicker } from './DirectoryPicker.js';
import type { DetectedCLI } from '../../adapters/detect.js';
import { getInstalledGodAdapters, isSupportedGodAdapterName } from '../../god/god-adapter-config.js';
import { getRegistryEntry, getAdapterModels, CUSTOM_MODEL_SENTINEL } from '../../adapters/registry.js';
import type { SessionConfig } from '../../types/session.js';
import { VERSION } from '../../index.js';

// ── Setup phases ──

export type SetupPhase = 'select-dir' | 'select-coder' | 'coder-model' | 'select-reviewer' | 'reviewer-model' | 'select-god' | 'god-model' | 'enter-task' | 'confirm';

export const PHASE_LABELS: Record<SetupPhase, string> = {
  'select-dir': 'Project',
  'select-coder': 'Coder',
  'coder-model': 'Coder',
  'select-reviewer': 'Reviewer',
  'reviewer-model': 'Reviewer',
  'select-god': 'God',
  'god-model': 'God',
  'enter-task': 'Task',
  'confirm': 'Confirm',
};

export const PHASE_ORDER: SetupPhase[] = ['select-dir', 'select-coder', 'coder-model', 'select-reviewer', 'reviewer-model', 'select-god', 'god-model', 'enter-task', 'confirm'];

// ── Branded Header ──

// Box border (2) + paddingX 3×2 (6) = 8 chars overhead.
// Content must stay ≤ MAX_HEADER_CONTENT to fit 80-column terminals.
export const MAX_HEADER_CONTENT = 72;

export const LOGO_LINES = [
  '  ██████╗  ██╗   ██╗  ██████╗ ',
  '  ██╔══██╗ ██║   ██║ ██╔═══██╗',
  '  ██║  ██║ ██║   ██║ ██║   ██║',
  '  ██║  ██║ ██║   ██║ ██║   ██║',
  '  ██████╔╝ ╚██████╔╝ ╚██████╔╝',
  '  ╚═════╝   ╚═════╝   ╚═════╝ ',
];

export const BRAND_SLOGAN = 'Coder writes. Reviewer guards. God decides.';

export const FEATURE_BULLETS = [
  'Coder × Reviewer × God — triple-agent architecture',
  'Autonomous task decomposition & convergence',
  'Built-in quality gates & decision routing',
];

export const SEPARATOR_WIDTH = 60;

// Fixed box width: border(2) + paddingX 3×2(6) + content(62) = 70 chars.
// Well within 80-column terminals.
export const HEADER_BOX_WIDTH = 70;

export function BrandHeader({ version }: { version: string }): React.ReactElement {
  const tagline = '  Multi-AI Collaborative Coding Engine';
  const versionLabel = `v${version}`;
  const versionPad = SEPARATOR_WIDTH + 2 - tagline.length - versionLabel.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={3}
      paddingY={1}
      alignSelf="flex-start"
      width={HEADER_BOX_WIDTH}
    >
      <Box flexDirection="column">
        {LOGO_LINES.map((line, i) => (
          <Text key={i} color="cyan" bold>{line}</Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color="white" bold>{'  ' + BRAND_SLOGAN}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{'  ' + '─'.repeat(SEPARATOR_WIDTH)}</Text>
        <Box>
          <Text dimColor>{tagline}</Text>
          <Text dimColor>{' '.repeat(Math.max(1, versionPad))}{versionLabel}</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {FEATURE_BULLETS.map((bullet, i) => (
          <Box key={i}>
            <Text color="cyan">{'  ◆ '}</Text>
            <Text dimColor>{bullet}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// ── Progress Stepper ──

/** Main display phases (model sub-phases are grouped with their parent) */
const STEPPER_PHASES: { key: string; label: string; phases: SetupPhase[] }[] = [
  { key: 'project', label: 'Project', phases: ['select-dir'] },
  { key: 'coder', label: 'Coder', phases: ['select-coder', 'coder-model'] },
  { key: 'reviewer', label: 'Reviewer', phases: ['select-reviewer', 'reviewer-model'] },
  { key: 'god', label: 'God', phases: ['select-god', 'god-model'] },
  { key: 'task', label: 'Task', phases: ['enter-task'] },
  { key: 'confirm', label: 'Confirm', phases: ['confirm'] },
];

function ProgressStepper({ currentPhase }: { currentPhase: SetupPhase }): React.ReactElement {
  const currentIndex = PHASE_ORDER.indexOf(currentPhase);

  return (
    <Box paddingX={1} marginTop={1}>
      {STEPPER_PHASES.map((step, i) => {
        const stepPhaseIndices = step.phases.map((p) => PHASE_ORDER.indexOf(p));
        const isActive = stepPhaseIndices.includes(currentIndex);
        const isDone = stepPhaseIndices.every((idx) => idx < currentIndex);
        const isLast = i === STEPPER_PHASES.length - 1;

        const icon = isDone ? '●' : isActive ? '◉' : '○';
        const color = isDone ? 'green' : isActive ? 'cyan' : 'gray';

        return (
          <React.Fragment key={step.key}>
            <Text color={color} bold={isActive}>
              {icon} {step.label}
            </Text>
            {!isLast && <Text dimColor> {'─'} </Text>}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

// ── CLI Selector ──

function CLISelector({
  detected,
  onSelect,
  exclude,
  label,
}: {
  detected: DetectedCLI[];
  onSelect: (name: string) => void;
  exclude?: string;
  label: string;
}): React.ReactElement {
  const items = detected.filter((d) => d.installed && d.name !== exclude);
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setSelected((prev) => Math.max(0, prev - 1));
    if (key.downArrow) setSelected((prev) => Math.min(items.length - 1, prev + 1));
    if (key.return && items.length > 0) onSelect(items[selected].name);
  });

  if (items.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="red">No CLI tools available. Install at least one AI CLI tool.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>{label}</Text>
      <Text dimColor>  Use arrow keys to navigate, Enter to select</Text>
      <Box flexDirection="column" marginTop={1}>
        {items.map((item, i) => {
          const isSelected = i === selected;
          return (
            <Box key={item.name}>
              <Text color={isSelected ? 'cyan' : 'gray'} bold={isSelected}>
                {isSelected ? ' ▸ ' : '   '}
              </Text>
              <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                {item.displayName}
              </Text>
              {item.version && (
                <Text dimColor> ({item.version})</Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

// ── God Selector (with "Same as Reviewer" default) ──

export const SAME_AS_REVIEWER = '__same_as_reviewer__';

export function GodSelector({
  detected,
  reviewer,
  onSelect,
  label,
}: {
  detected: DetectedCLI[];
  reviewer?: string;
  onSelect: (name: string) => void;
  label: string;
}): React.ReactElement {
  const cliItems = getInstalledGodAdapters(detected);
  const canReuseReviewer = reviewer ? isSupportedGodAdapterName(reviewer) : false;
  const DEFAULT_GOD = canReuseReviewer ? SAME_AS_REVIEWER : 'claude-code';
  const items: { key: string; display: string; version?: string | null; recommended?: boolean }[] = [
    ...(canReuseReviewer ? [{ key: SAME_AS_REVIEWER, display: 'Same as Reviewer' }] : []),
    ...cliItems.map((d) => ({
      key: d.name,
      display: d.displayName,
      version: d.version,
      recommended: d.name === 'claude-code',
    })),
  ];
  const defaultIndex = Math.max(0, items.findIndex((d) => d.key === DEFAULT_GOD));
  const [selected, setSelected] = useState(defaultIndex);

  useInput((input, key) => {
    if (key.upArrow) setSelected((prev) => Math.max(0, prev - 1));
    if (key.downArrow) setSelected((prev) => Math.min(items.length - 1, prev + 1));
    if (key.return && items.length > 0) onSelect(items[selected].key);
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>{label}</Text>
      <Text dimColor>  Use arrow keys to navigate, Enter to select</Text>
      <Text dimColor color="yellow">
        {'  Supported God adapters: Claude Code, Codex, and Gemini. God runs statelessly with tools disabled.'}
      </Text>
      {!canReuseReviewer && reviewer && (
        <Text dimColor color="yellow">
          {`  Reviewer '${reviewer}' cannot act as God. Choose Claude Code, Codex, or Gemini.`}
        </Text>
      )}
      {items.length === 0 && (
        <Text color="red">  No supported God adapters installed. Install Claude Code or Codex.</Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        {items.map((item, i) => {
          const isSelected = i === selected;
          return (
            <Box key={item.key}>
              <Text color={isSelected ? 'cyan' : 'gray'} bold={isSelected}>
                {isSelected ? ' ▸ ' : '   '}
              </Text>
              <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                {item.display}
              </Text>
              {item.version && (
                <Text dimColor> ({item.version})</Text>
              )}
              {item.recommended && <Text color="yellow"> ★ recommended</Text>}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

// ── Model Selector (list-based, with __custom__ fallback) ──

export { CUSTOM_MODEL_SENTINEL };

export function ModelSelector({
  roleName,
  adapterName,
  cliName,
  onSubmit,
}: {
  roleName: string;
  adapterName: string;
  cliName: string;
  onSubmit: (model: string | undefined) => void;
}): React.ReactElement {
  const models = getAdapterModels(cliName);
  // Items: "Use default" + known models (may include CUSTOM_MODEL_SENTINEL entry).
  const items: { id: string | undefined; label: string }[] = [
    { id: undefined, label: 'Use default' },
    ...models.map((m) => ({ id: m.id, label: `${m.label}  (${m.id})` })),
  ];

  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<'select' | 'custom'>('select');
  const [customValue, setCustomValue] = useState('');

  // Refs to avoid stale closures in useInput callback.
  const selectedRef = useRef(0);
  const modeRef = useRef<'select' | 'custom'>('select');
  const customValueRef = useRef('');

  useInput((_input, key) => {
    if (modeRef.current === 'select') {
      if (key.upArrow) {
        const next = Math.max(0, selectedRef.current - 1);
        selectedRef.current = next;
        setSelected(next);
      }
      if (key.downArrow) {
        const next = Math.min(items.length - 1, selectedRef.current + 1);
        selectedRef.current = next;
        setSelected(next);
      }
      if (key.return) {
        const id = items[selectedRef.current].id;
        if (id === CUSTOM_MODEL_SENTINEL) {
          modeRef.current = 'custom';
          setMode('custom');
        } else {
          onSubmit(id);
        }
      }
    } else {
      // Custom text-input mode.
      if (key.return) {
        onSubmit(customValueRef.current.trim() || undefined);
      } else if (key.backspace || key.delete) {
        const next = customValueRef.current.slice(0, -1);
        customValueRef.current = next;
        setCustomValue(next);
      } else if (_input && !key.ctrl && !key.meta) {
        const next = customValueRef.current + _input;
        customValueRef.current = next;
        setCustomValue(next);
      }
    }
  });

  if (mode === 'custom') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Model for {roleName} ({adapterName}):</Text>
        <Text dimColor>  Type a model name and press Enter, or press Enter to use default</Text>
        <Box marginTop={1}>
          <Text color="cyan" bold>{'  ▸ '}</Text>
          <Text color="white">{customValue}</Text>
          <Text dimColor>{customValue ? '█' : '(default) █'}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Model for {roleName} ({adapterName}):</Text>
      <Text dimColor>  Use arrow keys to navigate, Enter to select</Text>
      <Box flexDirection="column" marginTop={1}>
        {items.map((item, i) => {
          const isSelected = i === selected;
          return (
            <Box key={item.id ?? '__default__'}>
              <Text color={isSelected ? 'cyan' : 'gray'} bold={isSelected}>
                {isSelected ? ' ▸ ' : '   '}
              </Text>
              <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                {item.label}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

// ── Task Input ──

function TaskInput({ onSubmit }: { onSubmit: (task: string) => void }): React.ReactElement {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (key.return && value.trim()) {
      onSubmit(value.trim());
    } else if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      setValue((prev) => prev + input);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Describe the task for this session:</Text>
      <Text dimColor>  Type your task description and press Enter</Text>
      <Box marginTop={1}>
        <Text color="cyan" bold>{'  ▸ '}</Text>
        <Text color="white">{value}</Text>
        <Text dimColor>{'█'}</Text>
      </Box>
    </Box>
  );
}

// ── Confirmation Screen ──

export function ConfirmScreen({
  config,
  detected,
  onConfirm,
  onBack,
}: {
  config: Partial<SessionConfig>;
  detected: DetectedCLI[];
  onConfirm: () => void;
  onBack: () => void;
}): React.ReactElement {
  const home = process.env.HOME ?? '';
  const findDisplayName = (name?: string) =>
    detected.find((d) => d.name === name)?.displayName ?? name ?? '—';

  const displayDir = config.projectDir?.replace(home, '~') ?? '—';

  useInput((_input, key) => {
    if (key.return) onConfirm();
    if (key.escape) onBack();
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">Session Configuration</Text>
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={2} paddingY={1}>
        <Box>
          <Box width={14}><Text bold dimColor>Project</Text></Box>
          <Text color="white">{displayDir}</Text>
        </Box>
        <Box>
          <Box width={14}><Text bold dimColor>Coder</Text></Box>
          <Text color="blue">{findDisplayName(config.coder)}</Text>
          {config.coderModel && <Text dimColor> ({config.coderModel})</Text>}
        </Box>
        <Box>
          <Box width={14}><Text bold dimColor>Reviewer</Text></Box>
          <Text color="green">{findDisplayName(config.reviewer)}</Text>
          {config.reviewerModel && <Text dimColor> ({config.reviewerModel})</Text>}
        </Box>
        <Box>
          <Box width={14}><Text bold dimColor>God</Text></Box>
          <Text color="magenta">
            {config.god === config.reviewer
              ? `${findDisplayName(config.god)} (same as Reviewer)`
              : findDisplayName(config.god)}
          </Text>
          {config.godModel && <Text dimColor> ({config.godModel})</Text>}
        </Box>
        <Box>
          <Box width={14}><Text bold dimColor>Task</Text></Box>
          <Text color="white">{config.task ?? '—'}</Text>
        </Box>
      </Box>
      <Box marginTop={1} paddingX={1}>
        <Text dimColor>Press </Text>
        <Text color="cyan" bold>Enter</Text>
        <Text dimColor> to start session, </Text>
        <Text color="yellow" bold>Esc</Text>
        <Text dimColor> to go back</Text>
      </Box>
    </Box>
  );
}

/** Check if a CLI adapter supports model selection based on registry modelFlag. */
function adapterSupportsModel(name: string): boolean {
  const entry = getRegistryEntry(name);
  return Boolean(entry?.modelFlag);
}

// ── Props ──

export interface SetupWizardProps {
  detected: DetectedCLI[];
  initialConfig?: Partial<SessionConfig>;
  onComplete: (config: SessionConfig) => void;
}

// ── Main SetupWizard Component ──

export function SetupWizard({
  detected,
  initialConfig,
  onComplete,
}: SetupWizardProps): React.ReactElement {
  const [phase, setPhase] = useState<SetupPhase>('select-dir');
  const [config, setConfig] = useState<Partial<SessionConfig>>({
    projectDir: initialConfig?.projectDir ?? process.cwd(),
    coder: initialConfig?.coder,
    reviewer: initialConfig?.reviewer,
    task: initialConfig?.task,
  });

  return (
    <Box flexDirection="column">
      <BrandHeader version={VERSION} />
      <ProgressStepper currentPhase={phase} />

      <Box marginTop={1}>
        <Text dimColor>{'─'.repeat(58)}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {phase === 'select-dir' && (
          <DirectoryPicker
            onSelect={(dir) => {
              setConfig((prev) => ({ ...prev, projectDir: dir }));
              setPhase('select-coder');
            }}
            onCancel={() => {
              setConfig((prev) => ({ ...prev, projectDir: process.cwd() }));
              setPhase('select-coder');
            }}
          />
        )}

        {phase === 'select-coder' && (
          <CLISelector
            detected={detected}
            label="Select Coder (writes code):"
            onSelect={(name) => {
              setConfig((prev) => ({ ...prev, coder: name, coderModel: undefined }));
              setPhase(adapterSupportsModel(name) ? 'coder-model' : 'select-reviewer');
            }}
          />
        )}

        {phase === 'coder-model' && (
          <ModelSelector
            roleName="Coder"
            adapterName={detected.find((d) => d.name === config.coder)?.displayName ?? config.coder ?? ''}
            cliName={config.coder ?? ''}
            onSubmit={(model) => {
              setConfig((prev) => ({ ...prev, coderModel: model }));
              setPhase('select-reviewer');
            }}
          />
        )}

        {phase === 'select-reviewer' && (
          <CLISelector
            detected={detected}
            label="Select Reviewer (reviews code):"
            exclude={config.coder}
            onSelect={(name) => {
              setConfig((prev) => ({ ...prev, reviewer: name, reviewerModel: undefined }));
              setPhase(adapterSupportsModel(name) ? 'reviewer-model' : 'select-god');
            }}
          />
        )}

        {phase === 'reviewer-model' && (
          <ModelSelector
            roleName="Reviewer"
            adapterName={detected.find((d) => d.name === config.reviewer)?.displayName ?? config.reviewer ?? ''}
            cliName={config.reviewer ?? ''}
            onSubmit={(model) => {
              setConfig((prev) => ({ ...prev, reviewerModel: model }));
              setPhase('select-god');
            }}
          />
        )}

        {phase === 'select-god' && (
          <GodSelector
            detected={detected}
            reviewer={config.reviewer}
            label="Select God (orchestrator):"
            onSelect={(name) => {
              const godValue = (name === SAME_AS_REVIEWER ? config.reviewer! : name) as SessionConfig['god'];
              setConfig((prev) => ({ ...prev, god: godValue, godModel: undefined }));
              setPhase(adapterSupportsModel(godValue) ? 'god-model' : 'enter-task');
            }}
          />
        )}

        {phase === 'god-model' && (
          <ModelSelector
            roleName="God"
            adapterName={detected.find((d) => d.name === config.god)?.displayName ?? config.god ?? ''}
            cliName={config.god ?? ''}
            onSubmit={(model) => {
              setConfig((prev) => ({ ...prev, godModel: model }));
              setPhase('enter-task');
            }}
          />
        )}

        {phase === 'enter-task' && (
          <TaskInput
            onSubmit={(task) => {
              setConfig((prev) => ({ ...prev, task }));
              setPhase('confirm');
            }}
          />
        )}

        {phase === 'confirm' && (
          <ConfirmScreen
            config={config}
            detected={detected}
            onConfirm={() => {
              onComplete({
                projectDir: config.projectDir!,
                coder: config.coder!,
                reviewer: config.reviewer!,
                god: config.god!,
                task: config.task!,
                coderModel: config.coderModel,
                reviewerModel: config.reviewerModel,
                godModel: config.godModel,
              });
            }}
            onBack={() => setPhase('enter-task')}
          />
        )}
      </Box>
    </Box>
  );
}
