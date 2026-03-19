import type { SetupPhase } from './components/SetupWizard.js';

export interface SetupStepperItem {
  key: string;
  label: string;
  state: 'complete' | 'active' | 'pending';
}

export interface SetupHeroLayout {
  compact: boolean;
  showBullets: boolean;
  showSubhead: boolean;
  showVersionLine: boolean;
  topMargin: 0 | 1;
}

const STEPPER_GROUPS: { key: string; label: string; phases: SetupPhase[] }[] = [
  { key: 'project', label: 'Project', phases: ['select-dir'] },
  { key: 'coder', label: 'Coder', phases: ['select-coder', 'coder-model'] },
  { key: 'reviewer', label: 'Reviewer', phases: ['select-reviewer', 'reviewer-model'] },
  { key: 'god', label: 'God', phases: ['select-god', 'god-model'] },
  { key: 'task', label: 'Task', phases: ['enter-task'] },
  { key: 'confirm', label: 'Confirm', phases: ['confirm'] },
];

export const SETUP_PANEL_WIDTH = 70;

export function buildSetupStepperModel(currentPhase: SetupPhase): SetupStepperItem[] {
  const currentGroupIndex = STEPPER_GROUPS.findIndex((group) => group.phases.includes(currentPhase));

  return STEPPER_GROUPS.map((group, index) => ({
    key: group.key,
    label: group.label,
    state: index < currentGroupIndex
      ? 'complete'
      : index === currentGroupIndex
        ? 'active'
        : 'pending',
  }));
}

export function buildSetupHeroLayout(rows: number): SetupHeroLayout {
  const compact = rows <= 28;
  const showBullets = rows >= 30;
  const showVersionLine = rows >= 32;

  return {
    compact,
    showBullets,
    showSubhead: true,
    showVersionLine,
    topMargin: compact ? 0 : 1,
  };
}
