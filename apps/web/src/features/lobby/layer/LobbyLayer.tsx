import type { ReactNode } from 'react';

import { ScrollablePanel } from '@/ui/panel';

export function LobbyNoticeLayer({
  title,
  children,
  actions,
}: Readonly<{ title: string; children: ReactNode; actions: ReactNode }>) {
  return (
    <LobbyLayer kind='notice' role='alertdialog' ariaLabel={title}>
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
  kind,
}: Readonly<{
  children: ReactNode;
  role?: 'alertdialog';
  ariaLabel?: string;
  kind: 'profile' | 'settings' | 'join' | 'waiting' | 'reentry' | 'notice';
}>) {
  return (
    <div
      className='web-lobby-layer'
      data-lobby-layer={kind}
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
