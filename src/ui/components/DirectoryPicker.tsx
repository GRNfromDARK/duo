/**
 * Interactive directory picker for the setup flow.
 */

import React, { useMemo, useState } from 'react';
import { Text, useInput } from '../../tui/primitives.js';
import {
  addToMRU,
  completePath,
  DEFAULT_SCAN_DIRS,
  discoverGitRepos,
  isGitRepo,
  loadMRU,
  processPickerInput,
  saveMRU,
  type PickerState,
} from '../directory-picker-state.js';
import { Column, FooterHint, Panel, PromptRow, Row, SectionTitle, buildSelectionRowModel } from '../tui-layout.js';
import { SETUP_PANEL_WIDTH } from '../setup-wizard-layout.js';
import * as path from 'node:path';

const home = process.env.HOME ?? '/home/user';
const MRU_FILE = path.join(home, '.duo', 'recent.json');

export interface DirectoryPickerProps {
  onSelect: (dir: string) => void;
  onCancel: () => void;
  mruFile?: string;
  scanDirs?: string[];
  panelWidth?: number;
}

export function DirectoryPicker({
  onSelect,
  onCancel,
  mruFile = MRU_FILE,
  scanDirs = DEFAULT_SCAN_DIRS,
  panelWidth = SETUP_PANEL_WIDTH,
}: DirectoryPickerProps): React.ReactElement {
  const mru = useMemo(() => loadMRU(mruFile), [mruFile]);
  const discovered = useMemo(() => discoverGitRepos(scanDirs), [scanDirs]);

  const [inputValue, setInputValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [completions, setCompletions] = useState<string[]>([]);
  const [warning, setWarning] = useState<string | null>(null);

  const items = useMemo(() => {
    const combined = [...mru];
    for (const dir of discovered) {
      if (!combined.includes(dir)) {
        combined.push(dir);
      }
    }
    return combined;
  }, [mru, discovered]);

  const state: PickerState = {
    inputValue,
    selectedIndex,
    items,
    mru,
    discovered,
    completions,
    warning,
  };

  useInput((input, key) => {
    const action = processPickerInput(state, input, key);

    switch (action.type) {
      case 'update_input':
        setInputValue(action.value);
        setCompletions([]);
        setWarning(null);
        break;
      case 'tab_complete': {
        const matches = completePath(inputValue);
        if (matches.length === 1) {
          setInputValue(matches[0]! + '/');
          setCompletions([]);
        } else if (matches.length > 1) {
          setCompletions(matches);
        }
        break;
      }
      case 'submit': {
        const dir = action.value;
        if (!isGitRepo(dir)) {
          setWarning('Warning: selected directory is not a git repository.');
        }
        const updated = addToMRU(mru, dir);
        saveMRU(mruFile, updated);
        onSelect(dir);
        break;
      }
      case 'select':
        setSelectedIndex(action.index);
        break;
      case 'cancel':
        onCancel();
        break;
      case 'noop':
        break;
    }
  });

  return (
    <Panel tone="section" width={panelWidth} alignSelf="flex-start" paddingX={2}>
      <SectionTitle title="Select Project Directory" tone="hero" />
      <FooterHint text="Tab autocomplete · Arrow keys browse · Esc cancel" />

      <Row marginTop={1}>
        <Text dimColor>Path</Text>
      </Row>
      <Row>
        <PromptRow value={inputValue} placeholder="Enter or paste a directory" leadingSpace={false} />
      </Row>

      {completions.length > 0 && (
        <Column marginTop={1}>
          <Text dimColor>Completions:</Text>
          {completions.map((completion, i) => (
            <Text key={i} color="cyan">{`  ${completion}`}</Text>
          ))}
        </Column>
      )}

      {warning && (
        <Row marginTop={1}>
          <Text color="yellow">{warning}</Text>
        </Row>
      )}

      <Column marginTop={1}>
        <Text bold>Recent:</Text>
        {mru.length === 0 ? (
          <Text dimColor>  (no recent directories)</Text>
        ) : (
          mru.map((dir, i) => {
            const label = dir.replace(home, '~');
            const model = buildSelectionRowModel({ label, selected: selectedIndex === i });
            return (
              <Row key={dir}>
                <Text color={model.chevronColor} bold={model.emphasis}>{` ${model.chevron} `}</Text>
                <Text color={selectedIndex === i ? 'green' : model.textColor} bold={model.emphasis}>{label}</Text>
              </Row>
            );
          })
        )}
      </Column>

      <Column marginTop={1}>
        <Text bold>Discovered (git repos):</Text>
        {discovered.length === 0 ? (
          <Text dimColor>  (none found)</Text>
        ) : (
          discovered.filter((dir) => !mru.includes(dir)).map((dir, i) => {
            const globalIndex = mru.length + i;
            const label = dir.replace(home, '~');
            const model = buildSelectionRowModel({ label, selected: selectedIndex === globalIndex });
            return (
              <Row key={dir}>
                <Text color={model.chevronColor} bold={model.emphasis}>{` ${model.chevron} `}</Text>
                <Text color={selectedIndex === globalIndex ? 'green' : model.textColor} bold={model.emphasis}>{label}</Text>
              </Row>
            );
          })
        )}
      </Column>
    </Panel>
  );
}
