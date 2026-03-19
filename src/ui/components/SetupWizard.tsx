/**
 * SetupWizard — branded startup flow for Duo OpenTUI.
 *
 * Keeps the large Duo hero frame while aligning the active setup panels with the
 * same hybrid theme used in the live session UI.
 */

import React, { useRef, useState } from 'react';
import { Text, useInput } from '../../tui/primitives.js';
import { DirectoryPicker } from './DirectoryPicker.js';
import type { DetectedCLI } from '../../adapters/detect.js';
import { getInstalledGodAdapters, isSupportedGodAdapterName } from '../../god/god-adapter-config.js';
import { getRegistryEntry, getAdapterModels, CUSTOM_MODEL_SENTINEL } from '../../adapters/registry.js';
import type { SessionConfig } from '../../types/session.js';
import { VERSION } from '../../index.js';
import {
  CenteredContent,
  Column,
  Divider,
  FooterHint,
  LabelValueRow,
  Panel,
  PromptRow,
  Row,
  SectionTitle,
  buildSelectionRowModel,
} from '../tui-layout.js';
import {
  computeSetupDividerWidth,
  computeSetupSurfaceWidth,
} from '../screen-shell-layout.js';
import {
  SETUP_FEATURE_BULLETS,
  SETUP_HERO_SLOGAN,
  SETUP_HERO_SUBHEAD,
} from '../setup-copy.js';
import {
  SETUP_PANEL_WIDTH,
  buildSetupHeroLayout,
  buildSetupStepperModel,
} from '../setup-wizard-layout.js';

export type SetupPhase =
  | 'select-dir'
  | 'select-coder'
  | 'coder-model'
  | 'select-reviewer'
  | 'reviewer-model'
  | 'select-god'
  | 'god-model'
  | 'enter-task'
  | 'confirm';

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

export const PHASE_ORDER: SetupPhase[] = [
  'select-dir',
  'select-coder',
  'coder-model',
  'select-reviewer',
  'reviewer-model',
  'select-god',
  'god-model',
  'enter-task',
  'confirm',
];

export const LOGO_LINES = [
  '  ██████╗  ██╗   ██╗  ██████╗ ',
  '  ██╔══██╗ ██║   ██║ ██╔═══██╗',
  '  ██║  ██║ ██║   ██║ ██║   ██║',
  '  ██║  ██║ ██║   ██║ ██║   ██║',
  '  ██████╔╝ ╚██████╔╝ ╚██████╔╝',
  '  ╚═════╝   ╚═════╝   ╚═════╝ ',
];

function SelectionListRow({
  label,
  selected,
  suffix,
  accent,
  extra,
}: {
  label: string;
  selected: boolean;
  suffix?: string;
  accent?: string;
  extra?: React.ReactNode;
}): React.ReactElement {
  const model = buildSelectionRowModel({ label, selected, suffix });
  return (
    <Row>
      <Text color={model.chevronColor} bold={model.emphasis}>{` ${model.chevron} `}</Text>
      <Text color={accent ?? model.textColor} bold={model.emphasis}>{model.label}</Text>
      {model.suffix && <Text dimColor>{` ${model.suffix}`}</Text>}
      {extra}
    </Row>
  );
}

export function BrandHeader({
  version,
  width,
  rows,
}: {
  version: string;
  width: number;
  rows: number;
}): React.ReactElement {
  const heroLayout = buildSetupHeroLayout(rows);
  const dividerWidth = Math.max(24, width - 10);

  return (
    <Panel
      tone="hero"
      paddingX={3}
      paddingY={heroLayout.compact ? 0 : 1}
      alignSelf="flex-start"
      width={width}
    >
      <Column>
        {LOGO_LINES.map((line, i) => (
          <Text key={i} color="cyan" bold>{line}</Text>
        ))}
      </Column>

      <Row marginTop={heroLayout.topMargin}>
        <Text color="white" bold>{`  ${SETUP_HERO_SLOGAN}`}</Text>
      </Row>

      <Row marginTop={heroLayout.topMargin}>
        <Divider width={dividerWidth} />
      </Row>

      {heroLayout.showSubhead && (
        <Column marginTop={heroLayout.topMargin}>
          <Text dimColor>{SETUP_HERO_SUBHEAD}</Text>
          {heroLayout.showVersionLine && (
            <Text dimColor>{`Workflow-guided OpenTUI session setup · v${version}`}</Text>
          )}
        </Column>
      )}

      {heroLayout.showBullets && (
        <Column marginTop={heroLayout.topMargin}>
          {SETUP_FEATURE_BULLETS.map((bullet, i) => (
            <Row key={i}>
              <Text color="cyan">{'  ◆ '}</Text>
              <Text dimColor>{bullet}</Text>
            </Row>
          ))}
        </Column>
      )}
    </Panel>
  );
}

function ProgressStepper({ currentPhase }: { currentPhase: SetupPhase }): React.ReactElement {
  const steps = buildSetupStepperModel(currentPhase);

  return (
    <Row paddingX={1} marginTop={1}>
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        const icon = step.state === 'complete' ? '●' : step.state === 'active' ? '◉' : '○';
        const color = step.state === 'complete' ? 'green' : step.state === 'active' ? 'cyan' : 'gray';

        return (
          <React.Fragment key={step.key}>
            <Text color={color} bold={step.state === 'active'}>
              {icon} {step.label}
            </Text>
            {!isLast && <Text dimColor>{'  ─  '}</Text>}
          </React.Fragment>
        );
      })}
    </Row>
  );
}

function CLISelector({
  detected,
  onSelect,
  exclude,
  label,
  panelWidth = SETUP_PANEL_WIDTH,
}: {
  detected: DetectedCLI[];
  onSelect: (name: string) => void;
  exclude?: string;
  label: string;
  panelWidth?: number;
}): React.ReactElement {
  const items = detected.filter((d) => d.installed && d.name !== exclude);
  const [selected, setSelected] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) setSelected((prev) => Math.max(0, prev - 1));
    if (key.downArrow) setSelected((prev) => Math.min(items.length - 1, prev + 1));
    if (key.return && items.length > 0) onSelect(items[selected].name);
  });

  if (items.length === 0) {
    return (
      <Panel tone="warning" width={panelWidth} alignSelf="flex-start">
        <SectionTitle title={label} tone="warning" />
        <Text color="red">No CLI tools available. Install at least one AI CLI tool.</Text>
      </Panel>
    );
  }

  return (
    <Panel tone="section" width={panelWidth} alignSelf="flex-start" paddingX={2}>
      <SectionTitle title={label} />
      <FooterHint text="Arrow keys navigate · Enter selects" />
      <Column marginTop={1}>
        {items.map((item, i) => (
          <SelectionListRow
            key={item.name}
            label={item.displayName}
            suffix={item.version ? `(${item.version})` : undefined}
            selected={i === selected}
          />
        ))}
      </Column>
    </Panel>
  );
}

export const SAME_AS_REVIEWER = '__same_as_reviewer__';

export function GodSelector({
  detected,
  reviewer,
  onSelect,
  label,
  panelWidth = SETUP_PANEL_WIDTH,
}: {
  detected: DetectedCLI[];
  reviewer?: string;
  onSelect: (name: string) => void;
  label: string;
  panelWidth?: number;
}): React.ReactElement {
  const cliItems = getInstalledGodAdapters(detected);
  const canReuseReviewer = reviewer ? isSupportedGodAdapterName(reviewer) : false;
  const defaultGod = canReuseReviewer ? SAME_AS_REVIEWER : 'claude-code';
  const items: { key: string; display: string; version?: string | null; recommended?: boolean }[] = [
    ...(canReuseReviewer ? [{ key: SAME_AS_REVIEWER, display: 'Same as Reviewer' }] : []),
    ...cliItems.map((adapter) => ({
      key: adapter.name,
      display: adapter.displayName,
      version: adapter.version,
      recommended: adapter.name === 'claude-code',
    })),
  ];
  const defaultIndex = Math.max(0, items.findIndex((item) => item.key === defaultGod));
  const [selected, setSelected] = useState(defaultIndex);

  useInput((_input, key) => {
    if (key.upArrow) setSelected((prev) => Math.max(0, prev - 1));
    if (key.downArrow) setSelected((prev) => Math.min(items.length - 1, prev + 1));
    if (key.return && items.length > 0) onSelect(items[selected].key);
  });

  return (
    <Panel tone="section" width={panelWidth} alignSelf="flex-start" paddingX={2}>
      <SectionTitle title={label} />
      <FooterHint text="Arrow keys navigate · Enter selects" />
      <Text dimColor color="yellow">
        Supported God adapters: Claude Code, Codex, and Gemini. God runs statelessly with tools disabled.
      </Text>
      {!canReuseReviewer && reviewer && (
        <Text dimColor color="yellow">
          {`Reviewer '${reviewer}' cannot act as God. Choose Claude Code, Codex, or Gemini.`}
        </Text>
      )}
      {items.length === 0 && (
        <Text color="red">No supported God adapters installed. Install Claude Code or Codex.</Text>
      )}
      <Column marginTop={1}>
        {items.map((item, i) => (
          <SelectionListRow
            key={item.key}
            label={item.display}
            suffix={item.version ? `(${item.version})` : undefined}
            selected={i === selected}
            extra={item.recommended ? <Text color="yellow">{' ★ recommended'}</Text> : undefined}
          />
        ))}
      </Column>
    </Panel>
  );
}

export { CUSTOM_MODEL_SENTINEL };

export function ModelSelector({
  roleName,
  adapterName,
  cliName,
  onSubmit,
  panelWidth = SETUP_PANEL_WIDTH,
}: {
  roleName: string;
  adapterName: string;
  cliName: string;
  onSubmit: (model: string | undefined) => void;
  panelWidth?: number;
}): React.ReactElement {
  const models = getAdapterModels(cliName);
  const items: { id: string | undefined; label: string }[] = [
    { id: undefined, label: 'Use default' },
    ...models.map((model) => ({ id: model.id, label: `${model.label} (${model.id})` })),
  ];

  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<'select' | 'custom'>('select');
  const [customValue, setCustomValue] = useState('');

  const selectedRef = useRef(0);
  const modeRef = useRef<'select' | 'custom'>('select');
  const customValueRef = useRef('');

  useInput((input, key) => {
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
    } else if (key.return) {
      onSubmit(customValueRef.current.trim() || undefined);
    } else if (key.backspace || key.delete) {
      const next = customValueRef.current.slice(0, -1);
      customValueRef.current = next;
      setCustomValue(next);
    } else if (input && !key.ctrl && !key.meta) {
      const next = customValueRef.current + input;
      customValueRef.current = next;
      setCustomValue(next);
    }
  });

  if (mode === 'custom') {
    return (
      <Panel tone="section" width={panelWidth} alignSelf="flex-start" paddingX={2}>
        <SectionTitle title={`Model for ${roleName} (${adapterName}):`} />
        <FooterHint text="Type a model id and press Enter, or Enter on empty for default" />
        <Row marginTop={1}>
          <PromptRow value={customValue} placeholder="Use adapter default" leadingSpace={false} />
        </Row>
      </Panel>
    );
  }

  return (
    <Panel tone="section" width={panelWidth} alignSelf="flex-start" paddingX={2}>
      <SectionTitle title={`Model for ${roleName} (${adapterName}):`} />
      <FooterHint text="Arrow keys navigate · Enter selects" />
      <Column marginTop={1}>
        {items.map((item, i) => (
          <SelectionListRow
            key={item.id ?? '__default__'}
            label={item.label}
            selected={i === selected}
          />
        ))}
      </Column>
    </Panel>
  );
}

function TaskInput({
  onSubmit,
  panelWidth = SETUP_PANEL_WIDTH,
}: {
  onSubmit: (task: string) => void;
  panelWidth?: number;
}): React.ReactElement {
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
    <Panel tone="section" width={panelWidth} alignSelf="flex-start" paddingX={2}>
      <SectionTitle title="Describe the task for this session:" />
      <FooterHint text="Type the task prompt and press Enter" />
      <Row marginTop={1}>
        <PromptRow value={value} placeholder="Describe the task" leadingSpace={false} />
      </Row>
    </Panel>
  );
}

export function ConfirmScreen({
  config,
  detected,
  onConfirm,
  onBack,
  panelWidth = SETUP_PANEL_WIDTH,
}: {
  config: Partial<SessionConfig>;
  detected: DetectedCLI[];
  onConfirm: () => void;
  onBack: () => void;
  panelWidth?: number;
}): React.ReactElement {
  const home = process.env.HOME ?? '';
  const findDisplayName = (name?: string) =>
    detected.find((detectedCli) => detectedCli.name === name)?.displayName ?? name ?? '—';

  const displayDir = config.projectDir?.replace(home, '~') ?? '—';

  useInput((_input, key) => {
    if (key.return) onConfirm();
    if (key.escape) onBack();
  });

  return (
    <Panel tone="section" width={panelWidth} alignSelf="flex-start" paddingX={2}>
      <SectionTitle title="Session Configuration" tone="hero" />
      <Column marginTop={1}>
        <LabelValueRow label="Project" value={displayDir} />
        <LabelValueRow
          label="Coder"
          value={<>
            <Text color="blue">{findDisplayName(config.coder)}</Text>
            {config.coderModel && <Text dimColor>{` (${config.coderModel})`}</Text>}
          </>}
        />
        <LabelValueRow
          label="Reviewer"
          value={<>
            <Text color="green">{findDisplayName(config.reviewer)}</Text>
            {config.reviewerModel && <Text dimColor>{` (${config.reviewerModel})`}</Text>}
          </>}
        />
        <LabelValueRow
          label="God"
          value={<>
            <Text color="magenta">
              {config.god === config.reviewer
                ? `${findDisplayName(config.god)} (same as Reviewer)`
                : findDisplayName(config.god)}
            </Text>
            {config.godModel && <Text dimColor>{` (${config.godModel})`}</Text>}
          </>}
        />
        <LabelValueRow label="Task" value={config.task ?? '—'} />
      </Column>
      <Row marginTop={1}>
        <FooterHint text="Enter starts the session · Esc goes back" />
      </Row>
    </Panel>
  );
}

function adapterSupportsModel(name: string): boolean {
  const entry = getRegistryEntry(name);
  return Boolean(entry?.modelFlag);
}

export interface SetupWizardProps {
  detected: DetectedCLI[];
  initialConfig?: Partial<SessionConfig>;
  onComplete: (config: SessionConfig) => void;
  columns: number;
  rows: number;
}

export function SetupWizard({
  detected,
  initialConfig,
  onComplete,
  columns,
  rows,
}: SetupWizardProps): React.ReactElement {
  const panelWidth = computeSetupSurfaceWidth(columns);
  const dividerWidth = computeSetupDividerWidth(panelWidth);
  const [phase, setPhase] = useState<SetupPhase>('select-dir');
  const [config, setConfig] = useState<Partial<SessionConfig>>({
    projectDir: initialConfig?.projectDir ?? process.cwd(),
    coder: initialConfig?.coder,
    reviewer: initialConfig?.reviewer,
    task: initialConfig?.task,
  });

  return (
    <CenteredContent width={panelWidth}>
      <BrandHeader version={VERSION} width={panelWidth} rows={rows} />
      <ProgressStepper currentPhase={phase} />

      <Row marginTop={1}>
        <Divider width={dividerWidth} />
      </Row>

      <Column marginTop={1}>
        {phase === 'select-dir' && (
          <DirectoryPicker
            panelWidth={panelWidth}
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
            label="Select Coder"
            panelWidth={panelWidth}
            onSelect={(name) => {
              setConfig((prev) => ({ ...prev, coder: name, coderModel: undefined }));
              setPhase(adapterSupportsModel(name) ? 'coder-model' : 'select-reviewer');
            }}
          />
        )}

        {phase === 'coder-model' && (
          <ModelSelector
            roleName="Coder"
            adapterName={detected.find((detectedCli) => detectedCli.name === config.coder)?.displayName ?? config.coder ?? ''}
            cliName={config.coder ?? ''}
            panelWidth={panelWidth}
            onSubmit={(model) => {
              setConfig((prev) => ({ ...prev, coderModel: model }));
              setPhase('select-reviewer');
            }}
          />
        )}

        {phase === 'select-reviewer' && (
          <CLISelector
            detected={detected}
            label="Select Reviewer"
            exclude={config.coder}
            panelWidth={panelWidth}
            onSelect={(name) => {
              setConfig((prev) => ({ ...prev, reviewer: name, reviewerModel: undefined }));
              setPhase(adapterSupportsModel(name) ? 'reviewer-model' : 'select-god');
            }}
          />
        )}

        {phase === 'reviewer-model' && (
          <ModelSelector
            roleName="Reviewer"
            adapterName={detected.find((detectedCli) => detectedCli.name === config.reviewer)?.displayName ?? config.reviewer ?? ''}
            cliName={config.reviewer ?? ''}
            panelWidth={panelWidth}
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
            label="Select God"
            panelWidth={panelWidth}
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
            adapterName={detected.find((detectedCli) => detectedCli.name === config.god)?.displayName ?? config.god ?? ''}
            cliName={config.god ?? ''}
            panelWidth={panelWidth}
            onSubmit={(model) => {
              setConfig((prev) => ({ ...prev, godModel: model }));
              setPhase('enter-task');
            }}
          />
        )}

        {phase === 'enter-task' && (
          <TaskInput
            panelWidth={panelWidth}
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
            panelWidth={panelWidth}
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
      </Column>
    </CenteredContent>
  );
}
