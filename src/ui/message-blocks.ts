import { getRoleStyle } from '../types/ui.js';
import type { Message } from '../types/ui.js';
import type { DisplayMode } from './display-mode.js';

export interface MessageBlockHeader {
  name: string;
  roleTag: string;
  time: string;
  tokenText?: string;
}

export interface MessageBlockBody {
  content: string;
  cliCommand?: string;
  railKind: 'border';
  railColor: string;
  tone: 'accent' | 'muted' | 'neutral';
}

export interface MessageBlock {
  id: string;
  header: MessageBlockHeader;
  body: MessageBlockBody;
}

function formatTime(timestamp: number, verbose: boolean): string {
  const d = new Date(timestamp);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  if (!verbose) return `${h}:${m}`;
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatTokenCount(count: number): string {
  if (count < 1000) return `${count} tokens`;
  return `${(count / 1000).toFixed(1)}k tokens`;
}

export function buildMessageBlocks(
  messages: Message[],
  displayMode: DisplayMode,
): MessageBlock[] {
  return messages.map((message) => {
    const style = getRoleStyle(message.role);
    const roleTag = message.roleLabel ?? style.displayName;
    const isVerbose = displayMode === 'verbose';
    const tone = message.role === 'system'
      ? 'muted'
      : message.role === 'user'
        ? 'neutral'
        : 'accent';

    return {
      id: message.id,
      header: {
        name: style.displayName,
        roleTag,
        time: formatTime(message.timestamp, isVerbose),
        tokenText: isVerbose && message.metadata?.tokenCount != null
          ? formatTokenCount(message.metadata.tokenCount)
          : undefined,
      },
      body: {
        content: message.content,
        cliCommand: isVerbose ? message.metadata?.cliCommand : undefined,
        railKind: 'border',
        railColor: tone === 'muted' ? '#758195' : style.color,
        tone,
      },
    };
  });
}
