import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import { LoadingView } from '@/features/loading/ui/LoadingView';

test('uses localized labels and exposes the same visible and semantic progress', () => {
  const view = renderToStaticMarkup(
    <LoadingView progress={0.25} label='게임을 준비하고 있어요.' progressLabel='리소스 로딩률' />,
  );

  expect(view).toContain('게임을 준비하고 있어요.');
  expect(view).toContain('aria-label="리소스 로딩률"');
  expect(view).toContain('value="0.25"');
  expect(view).toContain('>25%</');
});

test('uses actual readiness progress and does not display completion before the gate completes', () => {
  const view = renderToStaticMarkup(
    <LoadingView progress={0.999} label='Loading resources' progressLabel='Readiness progress' />,
  );

  expect(view).toContain('value="0.999"');
  expect(view).toContain('>99%</');
  expect(view).not.toContain('>100%</');
});

test('clamps progress above completion for both visible and semantic values', () => {
  const view = renderToStaticMarkup(
    <LoadingView progress={2} label='Loading resources' progressLabel='Readiness progress' />,
  );

  expect(view).toContain('value="1"');
  expect(view).toContain('>100%</');
});

test('clamps progress below start for both visible and semantic values', () => {
  const view = renderToStaticMarkup(
    <LoadingView progress={-1} label='Loading resources' progressLabel='Readiness progress' />,
  );

  expect(view).toContain('value="0"');
  expect(view).toContain('>0%</');
});
