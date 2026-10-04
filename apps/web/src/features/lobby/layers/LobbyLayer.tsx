import type { ReactNode } from 'react';

import { ScrollablePanel } from '@/ui/panel';

export function LobbyNoticeLayer({
  title,
  children,
  actions,
}: Readonly<{ title: string; children: ReactNode; actions: ReactNode }>) {
  return (
    <LobbyLayer role='alertdialog' ariaLabel={title}>
      <ScrollablePanel
        className='web-lobby-surface'
        variant='notice'
        title={title}
        footer={actions}
      >
        {children}
      </ScrollablePanel>
    </LobbyLayer>
  );
}

export function LobbyLayer({
  children,
  role,
  ariaLabel,
  admission,
}: Readonly<{
  children: ReactNode;
  role?: 'alertdialog';
  ariaLabel?: string;
  admission?: 'join' | 'waiting';
}>) {
  return (
    <div
      className='web-lobby-layer'
      data-admission={admission}
      role={role}
      aria-label={ariaLabel}
      aria-modal={role ? 'true' : undefined}
    >
      {children}
    </div>
  );
}

export function PendingIndicator({ label }: Readonly<{ label: string }>) {
  return (
    <span className='web-lobby-progress' data-lobby-pending='true'>
      <span className='web-lobby-progress__spinner' aria-hidden='true' />
      {label}
    </span>
  );
}
