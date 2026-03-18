/**
 * Interactive directory picker TUI component.
 * Source: FR-019 (AC-065, AC-066, AC-067)
 *
 * Features:
 * - Path input with Tab autocomplete (AC-065)
 * - MRU list persisted to ~/.duo/recent.json (AC-066)
 * - Auto-discover git repos in ~/Projects, ~/Developer, ~/code
 * - Warning for non-git directories (AC-067)
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from '../../tui/primitives.js';
import {
  completePath,
  isGitRepo,
  discoverGitRepos,
  loadMRU,
  saveMRU,
  addToMRU,
  processPickerInput,
  DEFAULT_SCAN_DIRS,
  type PickerState,
} from '../directory-picker-state.js';
import * as path from 'node:path';

const home = process.env.HOME ?? '/home/user';
const MRU_FILE = path.join(home, '.duo', 'recent.json');

export interface DirectoryPickerProps {
  onSelect: (dir: string) => void;
  onCancel: () => void;
  mruFile?: string;
  scanDirs?: string[];
}

export function DirectoryPicker({
  onSelect,
  onCancel,
  mruFile = MRU_FILE,
  scanDirs = DEFAULT_SCAN_DIRS,
}: DirectoryPickerProps): React.ReactElement {
  // Load MRU and discover repos once on mount
  const mru = useMemo(() => loadMRU(mruFile), [mruFile]);
  const discovered = useMemo(() => discoverGitRepos(scanDirs), [scanDirs]);

  const [inputValue, setInputValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [completions, setCompletions] = useState<string[]>([]);
  const [warning, setWarning] = useState<string | null>(null);

  // Combined items list: MRU first, then discovered (deduplicated)
  const items = useMemo(() => {
    const combined = [...mru];
    for (const d of discovered) {
      if (!combined.includes(d)) {
        combined.push(d);
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
        // AC-067: warn if not a git repo
        if (!isGitRepo(dir)) {
          setWarning('Warning: Selected directory is not a git repository (Codex requires git)');
        }
        // Save to MRU
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
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold color="cyan">Select Project Directory</Text>
      <Box marginTop={1}>
        <Text>Path: </Text>
        <Text color="white">{inputValue}</Text>
        <Text dimColor>█</Text>
      </Box>
      <Text dimColor>  (Tab to autocomplete, ↑↓ to browse, Esc to cancel)</Text>

      {/* Tab completion results */}
      {completions.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Completions:</Text>
          {completions.map((c, i) => (
            <Text key={i} color="cyan">  {c}</Text>
          ))}
        </Box>
      )}

      {/* Warning */}
      {warning && (
        <Box marginTop={1}>
          <Text color="yellow">{warning}</Text>
        </Box>
      )}

      {/* MRU section */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Recent:</Text>
        {mru.length === 0 ? (
          <Text dimColor>  (no recent directories)</Text>
        ) : (
          mru.map((dir, i) => {
            const isSelected = selectedIndex === i;
            const label = dir.replace(home, '~');
            return (
              <Text key={dir} color={isSelected ? 'green' : undefined}>
                {isSelected ? '> ' : '  '}{label}
              </Text>
            );
          })
        )}
      </Box>

      {/* Discovered repos section */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Discovered (git repos):</Text>
        {discovered.length === 0 ? (
          <Text dimColor>  (none found)</Text>
        ) : (
          discovered.filter((d) => !mru.includes(d)).map((dir, i) => {
            const globalIndex = mru.length + i;
            const isSelected = selectedIndex === globalIndex;
            const label = dir.replace(home, '~');
            return (
              <Text key={dir} color={isSelected ? 'green' : undefined}>
                {isSelected ? '> ' : '  '}{label}
              </Text>
            );
          })
        )}
      </Box>
    </Box>
  );
}
