import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { DICE_BOARD_CSS } from '@/ui/layout/dice-board-layout';
import {
  BASE_FRAME_HEIGHT,
  BASE_FRAME_WIDTH,
  computeFrameMetrics,
  computeLogoPlacement,
  type FrameMetrics,
  isUnsupportedCoarseLandscape,
  type SafeAreaInsets,
} from '@/ui/layout/metrics';

const COARSE_POINTER_QUERY = '(pointer: coarse)';

export type GameFrameProps = Readonly<{
  children: ReactNode;
  logo?: ReactNode;
  onOrientationGuardExit?: () => void;
  orientationMessage: ReactNode;
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

function initialCoarsePointer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(COARSE_POINTER_QUERY).matches
  );
}

export function GameFrame({
  children,
  logo,
  onOrientationGuardExit,
  orientationMessage,
}: GameFrameProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const orientationBlockedRef = useRef(false);
  const [metrics, setMetrics] = useState<FrameMetrics | null>(null);
  const [coarsePointer, setCoarsePointer] = useState(initialCoarsePointer);

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

  useEffect(() => {
    const query = window.matchMedia(COARSE_POINTER_QUERY);
    const update = () => setCoarsePointer(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  const unsupportedLandscape = metrics
    ? isUnsupportedCoarseLandscape({
        width: metrics.content.width,
        height: metrics.content.height,
        coarsePointer,
      })
    : false;

  useLayoutEffect(() => {
    const wasBlocked = orientationBlockedRef.current;
    orientationBlockedRef.current = unsupportedLandscape;
    if (wasBlocked && !unsupportedLandscape) onOrientationGuardExit?.();
  }, [onOrientationGuardExit, unsupportedLandscape]);

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
        inert={unsupportedLandscape || undefined}
        aria-hidden={unsupportedLandscape || undefined}
      >
        <div
          className='game-logical-canvas'
          style={{ ...DICE_BOARD_CSS, width: BASE_FRAME_WIDTH, height: BASE_FRAME_HEIGHT }}
          data-game-logical-canvas='true'
        >
          {children}
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
      {unsupportedLandscape ? (
        <div className='game-orientation-blocker' role='status' data-orientation-blocker='true'>
          <div className='game-orientation-blocker__message'>{orientationMessage}</div>
        </div>
      ) : null}
    </div>
  );
}
