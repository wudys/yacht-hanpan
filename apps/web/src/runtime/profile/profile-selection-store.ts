import { CHARACTER_IDS, isCharacterId, type ProfileSelection } from '@repo/game-assets/characters';

const STORAGE_KEY = 'profileSelection';

interface ProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type ProfileSelectionSnapshot = Readonly<{
  selection: ProfileSelection;
  storageFailed: boolean;
}>;

export interface ProfileSelectionStore {
  initialize(): ProfileSelectionSnapshot;
  getSnapshot(): ProfileSelectionSnapshot;
  subscribe(listener: () => void): () => void;
  setSelection(selection: ProfileSelection): boolean;
}

export function createProfileSelectionStore(
  storage: ProfileStorage,
  random: () => number = Math.random,
): ProfileSelectionStore {
  let snapshot: ProfileSelectionSnapshot | null = null;
  const subscribers = new Set<() => void>();

  function persist(selection: ProfileSelection): boolean {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(selection));
      return true;
    } catch {
      return false;
    }
  }

  function initialize(): ProfileSelectionSnapshot {
    if (snapshot !== null) return snapshot;
    let selection: ProfileSelection | null = null;
    let storageFailed = false;
    try {
      selection = parseProfile(storage.getItem(STORAGE_KEY));
    } catch {
      // Browser storage is best-effort; retain the selection in memory.
    }
    if (selection === null) {
      const index = Math.floor(random() * CHARACTER_IDS.length);
      selection = { characterId: CHARACTER_IDS[index] ?? CHARACTER_IDS[0], variant: false };
      storageFailed = !persist(selection);
    }
    snapshot = { selection, storageFailed };
    return snapshot;
  }

  return {
    initialize,
    getSnapshot: initialize,
    subscribe(listener: () => void) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    setSelection(selection: ProfileSelection) {
      const current = initialize();
      const changed =
        current.selection.characterId !== selection.characterId ||
        current.selection.variant !== selection.variant;
      if (!changed && !current.storageFailed) return false;
      const storageFailed = !persist(selection);
      if (changed || current.storageFailed !== storageFailed) {
        snapshot = { selection: { ...selection }, storageFailed };
        for (const subscriber of subscribers) subscriber();
      }
      return changed;
    },
  };
}

function parseProfile(value: string | null): ProfileSelection | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (
      !('characterId' in parsed) ||
      !isCharacterId(parsed.characterId) ||
      !('variant' in parsed) ||
      typeof parsed.variant !== 'boolean'
    )
      return null;
    return { characterId: parsed.characterId, variant: parsed.variant };
  } catch {
    return null;
  }
}
