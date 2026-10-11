import {
  createProceduralDiceResources,
  type ProceduralDiceResources,
} from '@/runtime/dice/resources/procedural-resources';

export interface ProceduralResourceCache {
  preload(): Promise<ProceduralDiceResources>;
  dispose(): Promise<void>;
}

/** Lazily creates one procedural Three resource set shared within its visual owner. */
export function createProceduralResourceCache(
  create: () =>
    ProceduralDiceResources | Promise<ProceduralDiceResources> = createProceduralDiceResources,
): ProceduralResourceCache {
  let resource: ProceduralDiceResources | null = null;
  let loading: Promise<ProceduralDiceResources> | null = null;

  return {
    preload() {
      if (resource) return Promise.resolve(resource);
      if (loading) return loading;
      loading = Promise.resolve()
        .then(() => create())
        .then((created) => {
          resource = created;
          return created;
        })
        .finally(() => {
          loading = null;
        });
      return loading;
    },
    async dispose() {
      const owned = resource ?? (loading ? await loading.catch(() => null) : null);
      if (!owned || owned !== resource) return;
      resource = null;
      owned.dispose();
    },
  };
}
