export interface BrowserConnectivitySource {
  isOnline(): boolean;
  addEventListener(type: 'offline' | 'online', listener: () => void): void;
  removeEventListener(type: 'offline' | 'online', listener: () => void): void;
}

const BROWSER_CONNECTIVITY_SOURCE: BrowserConnectivitySource = {
  isOnline: () => globalThis.navigator.onLine,
  addEventListener: (type, listener) => globalThis.addEventListener(type, listener),
  removeEventListener: (type, listener) => globalThis.removeEventListener(type, listener),
};

export function subscribeBrowserConnectivity(
  listener: (online: boolean) => void,
  source: BrowserConnectivitySource = BROWSER_CONNECTIVITY_SOURCE,
): () => void {
  const publish = (): void => listener(source.isOnline());
  source.addEventListener('offline', publish);
  source.addEventListener('online', publish);
  publish();
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    source.removeEventListener('offline', publish);
    source.removeEventListener('online', publish);
  };
}
