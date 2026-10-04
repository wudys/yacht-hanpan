import '@/features/privacy/privacy.css';

import { requireGameAsset } from '@repo/game-assets';
import { type ReactNode, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { type Locale, translate } from '@/i18n';
import { IconButton } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';

export function PrivacyDialog({
  locale,
  children,
}: {
  locale: Locale;
  children: (privacyLink: ReactNode) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const privacyLink = (
    <button className='web-privacy-link' type='button' onClick={() => setOpen(true)}>
      {translate(locale, 'privacy.title')}
    </button>
  );
  return (
    <div ref={container} className='web-privacy-scope'>
      <div
        className='web-privacy-background'
        inert={open || undefined}
        aria-hidden={open || undefined}
      >
        {children(privacyLink)}
      </div>
      {open &&
        container.current &&
        createPortal(
          <PrivacyDialogContent locale={locale} onClose={() => setOpen(false)} />,
          container.current,
        )}
    </div>
  );
}

function PrivacyDialogContent({ locale, onClose }: { locale: Locale; onClose: () => void }) {
  return (
    <div
      className='web-privacy-overlay'
      role='dialog'
      aria-modal='true'
      aria-label={translate(locale, 'privacy.title')}
    >
      <ScrollablePanel
        title={translate(locale, 'privacy.title')}
        className='web-privacy-surface'
        footer={
          <button type='button' className='web-privacy-confirm' onClick={onClose}>
            {translate(locale, 'common.confirm')}
          </button>
        }
        headerAction={
          <IconButton
            label={translate(locale, 'common.close')}
            icon={<img src={requireGameAsset('ui.close').url} alt='' />}
            onClick={onClose}
          />
        }
      >
        <div className='web-privacy-content'>
          {translate(locale, 'privacy.body')
            .split(/\n\s*\n/u)
            .map((block) =>
              block.startsWith('- ') ? (
                <ul key={block}>
                  {block.split('\n').map((item) => (
                    <li key={item}>{item.slice(2)}</li>
                  ))}
                </ul>
              ) : (
                <p key={block}>{block}</p>
              ),
            )}
        </div>
      </ScrollablePanel>
    </div>
  );
}
