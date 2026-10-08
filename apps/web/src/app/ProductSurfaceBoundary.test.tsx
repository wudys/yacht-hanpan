// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { StrictMode, useContext, useEffect } from 'react';
import { expect, test, vi } from 'vitest';

import { ProductSurfaceContext } from '@/app/product-surface-context';
import { ProductSurfaceBoundary } from '@/app/ProductSurfaceBoundary';
import type { FrameAvailability } from '@/ui/layout';

test('withholds exposure until measured and composes global coverage without ending children', () => {
  const onRestored = vi.fn();
  const onExposure = vi.fn();
  const onUnmount = vi.fn();
  function Consumer() {
    const exposed = useContext(ProductSurfaceContext);
    useEffect(() => onUnmount, []);
    return <button type='button'>{exposed ? 'Exposed' : 'Covered'}</button>;
  }
  const tree = (availability: FrameAvailability, contentExposed = true) => (
    <ProductSurfaceBoundary
      frameAvailability={availability}
      contentExposed={contentExposed}
      onPlayableAreaRestored={onRestored}
      onSurfaceExposureChange={onExposure}
    >
      <Consumer />
    </ProductSurfaceBoundary>
  );
  const view = render(tree('unmeasured'));
  const button = screen.getByText('Covered');
  expect(screen.queryByRole('button', { name: 'Covered' })).toBeNull();
  expect(onExposure).toHaveBeenLastCalledWith(false);

  view.rerender(tree('available'));
  expect(screen.getByRole('button', { name: 'Exposed' })).toBe(button);
  expect(onRestored).not.toHaveBeenCalled();
  view.rerender(tree('available', false));
  expect(button.textContent).toBe('Covered');
  expect(onExposure).toHaveBeenLastCalledWith(false);
  expect(onUnmount).not.toHaveBeenCalled();
  view.rerender(tree('available'));
  expect(onRestored).not.toHaveBeenCalled();
  view.unmount();
  expect(onExposure).toHaveBeenLastCalledWith(false);
  expect(onUnmount).toHaveBeenCalledOnce();
});

test('hands each area restoration to synchronization before exposing descendants under StrictMode', () => {
  const observed: string[] = [];
  const onRestored = vi.fn(() => observed.push('sync'));
  const onExposure = vi.fn();
  function Consumer() {
    const exposed = useContext(ProductSurfaceContext);
    useEffect(() => {
      observed.push(exposed ? 'exposed' : 'covered');
    }, [exposed]);
    return <button type='button'>Play</button>;
  }
  const tree = (availability: FrameAvailability) => (
    <StrictMode>
      <ProductSurfaceBoundary
        frameAvailability={availability}
        contentExposed
        onPlayableAreaRestored={onRestored}
        onSurfaceExposureChange={onExposure}
      >
        <Consumer />
      </ProductSurfaceBoundary>
    </StrictMode>
  );
  const view = render(tree('insufficient-space'));
  observed.length = 0;
  view.rerender(tree('available'));
  expect(observed).toEqual(['sync', 'exposed']);
  expect(onRestored).toHaveBeenCalledOnce();
  view.rerender(tree('available'));
  expect(onRestored).toHaveBeenCalledOnce();
  view.rerender(tree('insufficient-space'));
  view.rerender(tree('available'));
  expect(onRestored).toHaveBeenCalledTimes(2);
  view.unmount();
});
