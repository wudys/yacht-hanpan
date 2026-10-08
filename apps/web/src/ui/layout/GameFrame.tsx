import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react';

import { DICE_BOARD_CSS } from '@/ui/layout/dice-board-layout';
import {
  BASE_FRAME_HEIGHT,
  BASE_FRAME_WIDTH,
  computeFrameMetrics,
  computeLogoPlacement,
  type FrameMetrics,
  isPlayableArea,
  type SafeAreaInsets,
} from '@/ui/layout/frame-metrics';

export type FrameAvailability = 'unmeasured' | 'insufficient-space' | 'available';

export type GameFrameProps = Readonly<{
  children: ReactNode | ((availability: FrameAvailability) => ReactNode);
  logo?: ReactNode;
  playAreaMessage: ReactNode;
}>;

function numberValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function measure(element: HTMLElement): FrameMetrics {
  const style = getComputedStyle(element);
  const safeArea: SafeAreaInsets = {
    top: numberValue(style.paddingTop),
    right: numberValue(style.paddingRight),
    bottom: numberValue(style.paddingBottom),
    left: numberValue(style.paddingLeft),
  };
  return computeFrameMetrics({
    width: element.clientWidth,
    height: element.clientHeight,
    safeArea,
  });
}

export function GameFrame({ children, logo, playAreaMessage }: GameFrameProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState<FrameMetrics | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const update = () => setMetrics(measure(root));
    update();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(update);
      observer.observe(root);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const availability: FrameAvailability = metrics
    ? isPlayableArea(metrics.content)
      ? 'available'
      : 'insufficient-space'
    : 'unmeasured';
  const blocked = availability !== 'available';

  const logoPlacement =
    metrics && logo
      ? computeLogoPlacement(metrics, { width: 80, height: 32, edge: 16, clearance: 12 })
      : { visible: false, x: 0, y: 0 };
  const slotStyle = metrics
    ? ({
        '--game-frame-left': `${metrics.frame.x}px`,
        '--game-frame-top': `${metrics.frame.y}px`,
        '--game-frame-width': `${metrics.frame.width}px`,
        '--game-frame-height': `${metrics.frame.height}px`,
        '--game-frame-scale': metrics.scale,
      } as CSSProperties)
    : undefined;

  return (
    <div
      ref={rootRef}
      className='game-frame-wrapper'
      data-game-ui-root='true'
      data-layout-mode={metrics?.mode ?? 'unmeasured'}
      data-measured={metrics ? 'true' : 'false'}
    >
      <div
        className='game-frame-slot'
        style={slotStyle}
        data-game-frame-slot='true'
        inert={blocked || undefined}
        aria-hidden={blocked || undefined}
      >
        <div
          className='game-logical-canvas'
          style={{ ...DICE_BOARD_CSS, width: BASE_FRAME_WIDTH, height: BASE_FRAME_HEIGHT }}
          data-game-logical-canvas='true'
        >
          {typeof children === 'function' ? children(availability) : children}
        </div>
      </div>
      {logo ? (
        <div
          className='game-wrapper-logo'
          data-visible={logoPlacement.visible ? 'true' : 'false'}
          style={{ left: logoPlacement.x, top: logoPlacement.y }}
        >
          {logo}
        </div>
      ) : null}
      {availability === 'insufficient-space' ? (
        <div className='game-play-area-blocker' role='status' data-play-area-blocker='true'>
          <div className='game-play-area-blocker__message'>{playAreaMessage}</div>
        </div>
      ) : null}
    </div>
  );
}
