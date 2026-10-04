import release from '@repo/product-release';

import { isPublicHttpsOrigin, readPublicSiteOrigin } from './public-origin.ts'; // eslint-disable-line no-restricted-imports, import-x/extensions -- Also loaded by the native Vite config.

export interface WebConfig {
  readonly gameServerUrl: string;
  readonly releaseId: string;
}

type WebEnvironment = Readonly<{
  DEV: boolean;
  VITE_GAME_SERVER_URL?: unknown;
  VITE_SITE_ORIGIN?: unknown;
  VITE_DEPLOYMENT_ENV?: unknown;
}>;

export class WebConfigError extends Error {
  public constructor(message: string = 'Invalid web configuration') {
    super(message);
    this.name = 'WebConfigError';
  }
}

export function parseWebConfig(environment: WebEnvironment): WebConfig {
  const gameServerUrl =
    environment.VITE_GAME_SERVER_URL ?? (environment.DEV ? 'http://127.0.0.1:3002' : null);

  if (typeof gameServerUrl !== 'string') {
    throw new WebConfigError();
  }

  let parsed: URL;
  try {
    parsed = new URL(gameServerUrl);
  } catch {
    throw new WebConfigError();
  }
  if (
    parsed.origin !== gameServerUrl ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    (environment.DEV
      ? parsed.protocol !== 'http:' && parsed.protocol !== 'https:'
      : parsed.protocol !== 'https:')
  ) {
    throw new WebConfigError();
  }

  if (environment.VITE_DEPLOYMENT_ENV === 'production' && !isPublicHttpsOrigin(gameServerUrl))
    throw new WebConfigError();

  if (environment.VITE_DEPLOYMENT_ENV === 'production' && !readPublicSiteOrigin(environment))
    throw new WebConfigError('VITE_SITE_ORIGIN must be a public HTTPS origin without a path.');

  return { gameServerUrl, releaseId: release.version };
}
