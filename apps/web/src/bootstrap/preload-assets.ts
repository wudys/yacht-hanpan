import { GAME_ASSET_MANIFEST, type GameAssetManifestEntry } from '@repo/game-assets';

export type VisualAssetManifestEntry = GameAssetManifestEntry & Readonly<{ kind: 'image' | 'svg' }>;

export const VISUAL_ASSET_MANIFEST: readonly VisualAssetManifestEntry[] =
  GAME_ASSET_MANIFEST.filter(
    (entry) =>
      (entry.kind === 'image' || entry.kind === 'svg') &&
      entry.id !== 'brand.favicon' &&
      entry.id !== 'brand.social-card',
  );

export type AssetDecoder = (
  entry: VisualAssetManifestEntry,
  signal: AbortSignal,
) => Promise<HTMLImageElement>;

export function createAssetPreloader(
  manifest: readonly VisualAssetManifestEntry[],
  decode: AssetDecoder,
): { preload(signal?: AbortSignal): Promise<void>; dispose(): Promise<void> } {
  let decoded: readonly HTMLImageElement[] | null = null;
  let loading: { controller: AbortController; promise: Promise<void> } | null = null;

  return {
    preload(signal?: AbortSignal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (decoded !== null) return Promise.resolve();
      if (loading) return loading.promise;
      const controller = new AbortController();
      let complete!: () => void;
      let decline!: (error: unknown) => void;
      const promise = new Promise<void>((resolve, reject) => {
        complete = resolve;
        decline = reject;
      });
      const attempt = { controller, promise };
      loading = attempt;
      const resources: HTMLImageElement[] = [];
      let settled = false;
      function cleanup() {
        signal?.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', onAbort);
        if (loading === attempt) loading = null;
      }
      function fail(error: unknown) {
        if (settled) return;
        settled = true;
        cleanup();
        controller.abort(error);
        resources.length = 0;
        decline(error);
      }
      function cancel() {
        controller.abort(signal?.reason);
      }
      function onAbort() {
        fail(controller.signal.reason);
      }
      signal?.addEventListener('abort', cancel, { once: true });
      controller.signal.addEventListener('abort', onAbort, { once: true });
      void Promise.all(
        manifest.map(async (entry) => {
          const value = await decode(entry, controller.signal);
          if (!settled) resources.push(value);
        }),
      ).then(() => {
        if (settled) return;
        settled = true;
        cleanup();
        decoded = resources;
        complete();
      }, fail);
      return promise;
    },
    async dispose() {
      loading?.controller.abort(new DOMException('Asset preparation disposed', 'AbortError'));
      decoded = null;
    },
  };
}
