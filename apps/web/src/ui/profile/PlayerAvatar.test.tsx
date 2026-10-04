import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import { PlayerAvatar } from '@/ui/profile/PlayerAvatar';

test('does not request an empty or invented image while room metadata is unavailable', () => {
  expect(renderToStaticMarkup(<PlayerAvatar alt='Opponent' />)).not.toContain('<img');
  expect(
    renderToStaticMarkup(<PlayerAvatar imageUrl='/characters/noir.png' alt='Opponent' />),
  ).toContain('src="/characters/noir.png"');
});
