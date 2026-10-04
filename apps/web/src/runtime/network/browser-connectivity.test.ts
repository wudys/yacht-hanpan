import { expect, test, vi } from 'vitest';

import {
  type BrowserConnectivitySource,
  subscribeBrowserConnectivity,
} from '@/runtime/network/browser-connectivity';

test('publishes initial and browser connectivity changes until unsubscribed', () => {
  let online = false;
  const listeners = new Map<'offline' | 'online', Set<() => void>>([
    ['offline', new Set()],
    ['online', new Set()],
  ]);
  const source: BrowserConnectivitySource = {
    isOnline: () => online,
    addEventListener: (type, listener) => listeners.get(type)?.add(listener),
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
  };
  const onChange = vi.fn();

  const unsubscribe = subscribeBrowserConnectivity(onChange, source);
  online = true;
  listeners.get('online')?.forEach((listener) => listener());
  unsubscribe();
  online = false;
  listeners.get('offline')?.forEach((listener) => listener());

  expect(onChange.mock.calls).toEqual([[false], [true]]);
  expect(listeners.get('online')?.size).toBe(0);
  expect(listeners.get('offline')?.size).toBe(0);
});
