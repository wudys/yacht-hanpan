import type { ReactNode } from 'react';

export function CapabilityFailureView({
  code,
  title,
  message,
  footer,
}: Readonly<{ code: string; title: string; message: string; footer?: ReactNode }>) {
  return (
    <section
      className='game-status-view capability-failure-view'
      role='alert'
      data-product-view='unsupported'
      data-capability-failure={code}
    >
      <h1>{title}</h1>
      <p>{message}</p>
      {footer && <footer className='entry-view__footer'>{footer}</footer>}
    </section>
  );
}
