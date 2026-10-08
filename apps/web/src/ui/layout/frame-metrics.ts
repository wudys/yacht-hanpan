export const BASE_FRAME_WIDTH = 360;
export const BASE_FRAME_HEIGHT = 500;
export const COMPACT_MAX_WIDTH = 430;
export const MAX_FRAME_SCALE = 16 / 9;
export const MIN_PLAYABLE_CONTENT_WIDTH = 320;
export const MIN_PLAYABLE_CONTENT_HEIGHT = 444.5;

export type SafeAreaInsets = Readonly<{ top: number; right: number; bottom: number; left: number }>;
export type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

export type FrameMetrics = Readonly<{
  mode: 'compact' | 'wide';
  scale: number;
  content: Rect;
  frame: Rect;
}>;

export type FrameMetricInput = Readonly<{
  width: number;
  height: number;
  safeArea?: SafeAreaInsets;
}>;

const ZERO_SAFE_AREA: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export function computeFrameMetrics({
  width,
  height,
  safeArea = ZERO_SAFE_AREA,
}: FrameMetricInput): FrameMetrics {
  const contentWidth = Math.max(0, width - safeArea.left - safeArea.right);
  const contentHeight = Math.max(0, height - safeArea.top - safeArea.bottom);
  const scale = Math.max(
    0,
    Math.min(contentWidth / BASE_FRAME_WIDTH, contentHeight / BASE_FRAME_HEIGHT, MAX_FRAME_SCALE),
  );
  const frameWidth = BASE_FRAME_WIDTH * scale;
  const frameHeight = BASE_FRAME_HEIGHT * scale;
  return {
    mode: width <= COMPACT_MAX_WIDTH ? 'compact' : 'wide',
    scale,
    content: {
      x: safeArea.left,
      y: safeArea.top,
      width: contentWidth,
      height: contentHeight,
    },
    frame: {
      x: safeArea.left + (contentWidth - frameWidth) / 2,
      y: safeArea.top,
      width: frameWidth,
      height: frameHeight,
    },
  };
}

export type LogoPlacementInput = Readonly<{
  width: number;
  height: number;
  edge: number;
  clearance: number;
}>;

export type LogoPlacement = Readonly<{ visible: boolean; x: number; y: number }>;

export function computeLogoPlacement(
  metrics: FrameMetrics,
  logo: LogoPlacementInput,
): LogoPlacement {
  const x = metrics.content.x + metrics.content.width - logo.edge - logo.width;
  const y = metrics.content.y + metrics.content.height - logo.edge - logo.height;
  const fits = x >= metrics.content.x && y >= metrics.content.y;
  const overlapsFrame = !(
    x >= metrics.frame.x + metrics.frame.width + logo.clearance ||
    y >= metrics.frame.y + metrics.frame.height + logo.clearance
  );
  return fits && !overlapsFrame ? { visible: true, x, y } : { visible: false, x: 0, y: 0 };
}

export function isPlayableArea(content: Pick<Rect, 'width' | 'height'>): boolean {
  return (
    content.width >= MIN_PLAYABLE_CONTENT_WIDTH && content.height >= MIN_PLAYABLE_CONTENT_HEIGHT
  );
}
