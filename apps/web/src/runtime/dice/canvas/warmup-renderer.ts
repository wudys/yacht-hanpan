import type { Camera, Scene, WebGLRenderer } from 'three';

export async function warmupRenderer(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
): Promise<void> {
  if (typeof renderer.compileAsync === 'function') await renderer.compileAsync(scene, camera);
  else renderer.compile(scene, camera);
  renderer.render(scene, camera);
  // Readiness can reveal the Canvas before the next presentation frame is drawn.
  // Keep the warmed resources, not the preparation scene's pixels.
  renderer.clear();
}
