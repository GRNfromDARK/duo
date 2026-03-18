/** @jsxImportSource @opentui/react */
import React from 'react';

export interface TuiAppProps {
  title: string;
  body: string;
}

export function TuiApp({ title, body }: TuiAppProps): React.ReactElement {
  return (
    <box width="100%" height="100%" flexDirection="column" padding={1}>
      <box marginBottom={1}>
        <text>{title}</text>
      </box>
      <scrollbox
        flexGrow={1}
        scrollbarOptions={{ visible: true }}
      >
        <text wrapMode="word">{body}</text>
      </scrollbox>
    </box>
  );
}
