export type CanvasLike = HTMLCanvasElement | OffscreenCanvas;
export type CanvasFactory = (width: number, height: number) => CanvasLike;

export function defaultCanvasFactory(width: number, height: number): CanvasLike {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('A browser Canvas implementation is required to create dice face textures');
}
