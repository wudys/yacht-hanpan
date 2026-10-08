import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import { AchievementSequence } from '@/features/game/ui/AchievementSequence';
import { ACHIEVEMENT_SEQUENCE_DURATION_MS } from '@/ui/achievement-timing';

test('renders the supplied title with the shared common duration and no particles', () => {
  const view = renderToStaticMarkup(<AchievementSequence kind='other' title='Full House' />);

  expect(view).toContain('role="status"');
  expect(view).toContain('aria-live="polite"');
  expect(view).toContain('data-achievement-kind="other"');
  expect(view).toContain(
    `data-achievement-duration-ms="${ACHIEVEMENT_SEQUENCE_DURATION_MS.other}"`,
  );
  expect(view).toContain(`--achievement-duration:${ACHIEVEMENT_SEQUENCE_DURATION_MS.other}ms`);
  expect(view.match(/Full House/gu)?.length).toBe(1);
  expect(view).not.toContain('data-achievement-particles');
});

test('renders the Yacht sequence with the shared duration, decorative particles and no subtitle', () => {
  const view = renderToStaticMarkup(<AchievementSequence kind='yacht' title='요트' />);

  expect(view).toContain('data-achievement-kind="yacht"');
  expect(view).toContain(
    `data-achievement-duration-ms="${ACHIEVEMENT_SEQUENCE_DURATION_MS.yacht}"`,
  );
  expect(view).toContain(`--achievement-duration:${ACHIEVEMENT_SEQUENCE_DURATION_MS.yacht}ms`);
  expect(view.match(/요트/gu)?.length).toBe(1);
  expect(view).toContain('data-achievement-particles="true"');
});
