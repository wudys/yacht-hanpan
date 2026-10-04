import '@/app/styles.css';
import '@/dev/anchors.css';

import { createRoot } from 'react-dom/client';

import { Anchor } from '@/dev/Anchor';
import { normalizeLocale } from '@/i18n';

const params = new URLSearchParams(location.search);
const anchor = params.get('anchor') ?? 'game';
const mode = params.get('mode') ?? 'playing';
const locale = normalizeLocale(params.get('locale'));
document.documentElement.lang = locale;
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
if (anchor === 'replay') {
  // This entry is development-only; never reachable from the product router/build.
  void import('@/dev/ReplayAnchor').then(({ ReplayAnchor }) =>
    createRoot(root).render(
      <ReplayAnchor
        anchor={anchor}
        mode={mode}
        locale={locale}
        seed={params.get('seed') ?? 'gesture-explore-20260921-14'}
        pourStyle={params.get('style') ?? 'classic'}
        count={Number(params.get('count') ?? 5)}
        arrange={params.get('arrange') === '1'}
      />,
    ),
  );
} else {
  createRoot(root).render(<Anchor anchor={anchor} mode={mode} locale={locale} />);
}
