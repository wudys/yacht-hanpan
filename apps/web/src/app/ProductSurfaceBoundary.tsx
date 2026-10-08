import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { ProductSurfaceContext } from '@/app/product-surface-context';
import type { FrameAvailability } from '@/ui/layout';

export function ProductSurfaceBoundary({
  frameAvailability,
  contentExposed,
  onPlayableAreaRestored,
  onSurfaceExposureChange,
  children,
}: Readonly<{
  frameAvailability: FrameAvailability;
  contentExposed: boolean;
  onPlayableAreaRestored: () => void;
  onSurfaceExposureChange: (exposed: boolean) => void;
  children: ReactNode;
}>) {
  const [transition, setTransition] = useState({
    availability: frameAvailability,
    restoring: false,
  });
  const current = useMemo(
    () =>
      transition.availability === frameAvailability
        ? transition
        : {
            availability: frameAvailability,
            restoring:
              transition.availability === 'insufficient-space' && frameAvailability === 'available',
          },
    [transition, frameAvailability],
  );
  if (current !== transition) setTransition(current);

  // Keep descendants covered until recovery has synchronously acquired its input lock.
  const restoredTransition = useRef<typeof current | null>(null);
  const exposed = frameAvailability === 'available' && contentExposed && !current.restoring;

  useLayoutEffect(() => {
    if (!current.restoring || restoredTransition.current === current) return;
    restoredTransition.current = current;
    onPlayableAreaRestored();
    setTransition((latest) => (latest === current ? { ...latest, restoring: false } : latest));
  }, [current, onPlayableAreaRestored]);

  useLayoutEffect(() => {
    onSurfaceExposureChange(exposed);
    return () => onSurfaceExposureChange(false);
  }, [exposed, onSurfaceExposureChange]);

  return (
    <ProductSurfaceContext.Provider value={exposed}>
      <div
        className='web-product-surface'
        inert={!exposed || undefined}
        aria-hidden={!exposed || undefined}
      >
        {children}
      </div>
    </ProductSurfaceContext.Provider>
  );
}
