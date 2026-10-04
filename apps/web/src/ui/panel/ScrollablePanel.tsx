import type { ReactNode } from 'react';

export type ScrollablePanelProps = Readonly<{
  title: string;
  className?: string;
  variant?: 'layer' | 'notice';
  meta?: ReactNode;
  headerAction?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  ariaLabel?: string;
}>;

export function ScrollablePanel({
  title,
  className,
  variant = 'layer',
  meta,
  headerAction,
  footer,
  children,
  ariaLabel,
}: ScrollablePanelProps) {
  return (
    <section
      className={className ? `scrollable-panel ${className}` : 'scrollable-panel'}
      data-variant={variant}
      data-has-footer={footer ? 'true' : 'false'}
      aria-label={ariaLabel ?? title}
    >
      <header className='scrollable-panel__header'>
        {headerAction}
        <h1>{title}</h1>
        {meta ? <div className='scrollable-panel__meta'>{meta}</div> : null}
      </header>
      <div className='scrollable-panel__body' data-scroll-body='true'>
        {children}
      </div>
      {footer ? (
        <footer className='scrollable-panel__footer' data-layer-footer='true'>
          {footer}
        </footer>
      ) : null}
    </section>
  );
}
