export function readPublicSiteOrigin(environment: Readonly<Record<string, unknown>>): string {
  const value = environment.VITE_SITE_ORIGIN;
  return typeof value === 'string' && isPublicHttpsOrigin(value) ? value : '';
}

export function isPublicHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.hostname.includes('.') &&
      // Keep one exact origin spelling; a trailing DNS dot must not bypass suffix checks.
      !url.hostname.endsWith('.') &&
      !/^[\d.]+$/u.test(url.hostname) &&
      !url.hostname.startsWith('[') &&
      !/(?:^|\.)(?:localhost|local|test|invalid)$/u.test(url.hostname)
    );
  } catch {
    return false;
  }
}
