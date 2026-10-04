import type { ReactNode } from 'react';

import { BrandLockup } from '@/ui/brand';

export type EntryViewProps = Readonly<{
  title: string;
  startLabel: string;
  activationFailure?: string;
  pending: boolean;
  onStart: () => void;
  footer?: ReactNode;
}>;

export function EntryView({
  title,
  startLabel,
  activationFailure,
  pending,
  onStart,
  footer,
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
      </div>
      {footer && <footer className='entry-view__footer'>{footer}</footer>}
    </main>
  );
}
