import React from 'react';
import { Box, Text, type BoxProps } from '../tui/primitives.js';
import {
  buildDividerContent,
  buildPanelTone,
  buildRowProps,
  buildSelectionRowModel,
  type PanelTone,
} from './tui-layout-model.js';

export {
  buildDividerContent,
  buildPanelTone,
  buildRowProps,
  buildSelectionRowModel,
};

export function Row({ children, ...props }: BoxProps): React.ReactElement {
  return (
    <Box {...buildRowProps()} {...props}>
      {children}
    </Box>
  );
}

export function Column({ children, ...props }: BoxProps): React.ReactElement {
  return (
    <Box flexDirection="column" {...props}>
      {children}
    </Box>
  );
}

export function CenteredContent({
  children,
  width,
  height,
  justifyContent = 'flex-start',
}: {
  children: React.ReactNode;
  width: number | string;
  height?: number | string;
  justifyContent?: string;
}): React.ReactElement {
  return (
    <Column width="100%" height={height} justifyContent={justifyContent}>
      <Row width="100%" justifyContent="center">
        <Column width={width}>
          {children}
        </Column>
      </Row>
    </Column>
  );
}

export function Panel({
  children,
  tone = 'section',
  ...props
}: BoxProps & { tone?: PanelTone }): React.ReactElement {
  const colors = buildPanelTone(tone);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.borderColor}
      paddingX={1}
      {...props}
    >
      {children}
    </Box>
  );
}

export function Divider({ width, color = 'gray' }: { width: number; color?: string }): React.ReactElement {
  return <Text color={color} dimColor={color === 'gray'}>{buildDividerContent(width)}</Text>;
}

export function SectionTitle({
  title,
  tone = 'section',
}: {
  title: string;
  tone?: PanelTone;
}): React.ReactElement {
  const colors = buildPanelTone(tone);
  return (
    <Text color={colors.titleColor} bold>{title}</Text>
  );
}

export function LabelValueRow({
  label,
  value,
  labelWidth = 14,
  valueColor = 'white',
}: {
  label: string;
  value: React.ReactNode;
  labelWidth?: number;
  valueColor?: string;
}): React.ReactElement {
  return (
    <Row>
      <Box width={labelWidth}>
        <Text dimColor bold>{label}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {typeof value === 'string'
          ? <Text color={valueColor}>{value}</Text>
          : <>{value}</>}
      </Box>
    </Row>
  );
}

export function SelectionRow({
  label,
  selected,
  suffix,
}: {
  label: string;
  selected: boolean;
  suffix?: string;
}): React.ReactElement {
  const model = buildSelectionRowModel({ label, selected, suffix });
  return (
    <Row>
      <Text color={model.chevronColor} bold={model.emphasis}>{` ${model.chevron} `}</Text>
      <Text color={model.textColor} bold={model.emphasis}>{model.label}</Text>
      {model.suffix && <Text dimColor>{` ${model.suffix}`}</Text>}
    </Row>
  );
}

export function PromptRow({
  prompt = '▸',
  promptColor = 'cyan',
  value,
  placeholder,
  cursor = '█',
  leadingSpace = true,
}: {
  prompt?: string;
  promptColor?: string;
  value: string;
  placeholder?: string;
  cursor?: string;
  leadingSpace?: boolean;
}): React.ReactElement {
  const showPlaceholder = value.length === 0 && placeholder;

  return (
    <Row>
      <Text color={promptColor} bold>{leadingSpace ? ` ${prompt} ` : `${prompt} `}</Text>
      {showPlaceholder ? (
        <Text dimColor>{placeholder}</Text>
      ) : (
        <>
          <Text color="white">{value}</Text>
          <Text inverse>{cursor}</Text>
        </>
      )}
    </Row>
  );
}

export function FooterHint({ text }: { text: string }): React.ReactElement {
  return <Text dimColor>{text}</Text>;
}
