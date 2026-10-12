import type { ReactNode } from 'react';

import { BrandLockup } from '@/ui';

export type EntryViewProps = Readonly<{
  title: string;
  startLabel: string;
  demoServerNotice?: string;
  activationFailure?: string;
  pending: boolean;
  onStart: () => void;
  privacyAction?: ReactNode;
}>;

export function EntryView({
  title,
  startLabel,
  demoServerNotice,
  activationFailure,
  pending,
  onStart,
  privacyAction,
}: EntryViewProps) {
  return (
    <main className='entry-view' data-product-view='entry'>
      <h1 className='entry-view__title'>{title}</h1>
      <BrandLockup />
      <div className='entry-view__action'>
        {activationFailure ? (
          <p className='entry-view__activation-failure' role='alert'>
            {activationFailure}
          </p>
        ) : null}
        <button
          className='entry-view__start'
          type='button'
          tabIndex={-1}
          disabled={pending}
          data-interaction-locked={pending ? 'true' : 'false'}
          onClick={(event) => {
            if (!pending && event.detail > 0 && event.button === 0) onStart();
          }}
        >
          {startLabel}
        </button>
        {demoServerNotice && <p className='entry-view__server-notice'>{demoServerNotice}</p>}
      </div>
      {privacyAction && <div className='entry-view__privacy'>{privacyAction}</div>}
    </main>
  );
}
