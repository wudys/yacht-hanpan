import { CHARACTER_IDS } from '@repo/game-assets/characters';
import { expect, test, vi } from 'vitest';

import { createProfileSelectionStore } from '@/runtime/profile/profile-selection-store';

test('requires explicit initialization before snapshot reads without storage or random effects', () => {
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
  const random = vi.fn(() => 0);
  const profile = createProfileSelectionStore(storage, random);
  const listener = vi.fn();
  const unsubscribe = profile.subscribe(listener);

  expect(() => profile.getSnapshot()).toThrow('Profile selection has not been initialized');
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(random).not.toHaveBeenCalled();
  expect(listener).not.toHaveBeenCalled();

  const initial = profile.initialize();
  expect(profile.getSnapshot()).toBe(initial);
  expect(profile.getSnapshot()).toBe(initial);
  expect(profile.initialize()).toBe(initial);
  expect(storage.getItem).toHaveBeenCalledOnce();
  expect(storage.setItem).toHaveBeenCalledOnce();
  expect(random).toHaveBeenCalledOnce();
  unsubscribe();
});

test('initializes only when requested and preserves legacy identity and unrelated storage', () => {
  const values = new Map([
    ['characterId', 'lumi'],
    ['clientId', 'existing-client'],
    ['settings', 'unchanged'],
  ]);
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  const random = vi.fn(() => 0.99);
  const profile = createProfileSelectionStore(storage, random);
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(random).not.toHaveBeenCalled();
  expect(profile.initialize().selection).toEqual({
    characterId: CHARACTER_IDS[11],
    variant: false,
  });
  expect(profile.initialize()).toBe(profile.getSnapshot());
  expect(random).toHaveBeenCalledTimes(1);
  profile.setSelection({ characterId: CHARACTER_IDS[4], variant: true });
  expect(createProfileSelectionStore(storage).initialize().selection).toEqual({
    characterId: CHARACTER_IDS[4],
    variant: true,
  });
  expect(values.get('characterId')).toBe('lumi');
  expect(values.get('clientId')).toBe('existing-client');
  expect(values.get('settings')).toBe('unchanged');
});

test.each([
  'malformed',
  '{"characterId":"removed","variant":false}',
  '{"characterId":"navy-bob","variant":"false"}',
])('replaces invalid stored selection %s with a stable default', (stored) => {
  const storage = { getItem: () => stored, setItem: vi.fn() };
  const profile = createProfileSelectionStore(storage, () => 0.25);
  const selection = { characterId: CHARACTER_IDS[3], variant: false };
  expect(profile.initialize().selection).toEqual(selection);
  expect(storage.setItem).toHaveBeenCalledWith('profileSelection', JSON.stringify(selection));
});

test('keeps a stable memory selection when storage cannot be read or written', () => {
  const profile = createProfileSelectionStore(
    {
      getItem: () => {
        throw new Error('storage unavailable');
      },
      setItem: () => {
        throw new Error('storage unavailable');
      },
    },
    () => 0,
  );
  const initial = profile.initialize();
  expect(initial.selection).toEqual({ characterId: CHARACTER_IDS[0], variant: false });
  expect(initial.storageFailed).toBe(true);
  expect(profile.getSnapshot()).toBe(initial);
  const selection = { characterId: CHARACTER_IDS[1], variant: true } as const;
  profile.setSelection(selection);
  expect(profile.getSnapshot()).toEqual({ selection, storageFailed: true });
});

test('uses the default write result when the initial profile cannot be read', () => {
  const storage = {
    getItem: () => {
      throw new Error('read denied');
    },
    setItem: vi.fn(),
  };
  const profile = createProfileSelectionStore(storage, () => 0);
  expect(profile.initialize().storageFailed).toBe(false);
  expect(storage.setItem).toHaveBeenCalledOnce();
});

test('reports selection changes separately from storage recovery and skips saved reselections', () => {
  const storage = {
    getItem: () => JSON.stringify({ characterId: CHARACTER_IDS[0], variant: false }),
    setItem: vi.fn(),
  };
  const profile = createProfileSelectionStore(storage);
  const initial = profile.initialize();
  const observed: ReturnType<typeof profile.getSnapshot>[] = [];
  const unsubscribe = profile.subscribe(() => observed.push(profile.getSnapshot()));
  expect(profile.setSelection(initial.selection)).toBe(false);
  expect(storage.setItem).not.toHaveBeenCalled();
  const selection = { characterId: CHARACTER_IDS[1], variant: true } as const;
  storage.setItem.mockImplementationOnce(() => {
    throw new Error('write denied');
  });

  expect(profile.setSelection(selection)).toBe(true);
  expect(observed).toEqual([{ selection, storageFailed: true }]);
  expect(profile.getSnapshot()).toBe(observed[0]);
  expect(initial.selection).toEqual({ characterId: CHARACTER_IDS[0], variant: false });

  expect(profile.setSelection(selection)).toBe(false);
  expect(observed).toEqual([
    { selection, storageFailed: true },
    { selection, storageFailed: false },
  ]);
  expect(storage.setItem).toHaveBeenLastCalledWith('profileSelection', JSON.stringify(selection));
  expect(profile.setSelection(selection)).toBe(false);
  expect(storage.setItem).toHaveBeenCalledTimes(2);
  unsubscribe();
  profile.setSelection({ characterId: CHARACTER_IDS[2], variant: false });
  expect(observed).toHaveLength(2);
});
