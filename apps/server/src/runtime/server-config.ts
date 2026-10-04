import release from '@repo/product-release';

type ServerEnvironment = 'development' | 'test' | 'production';

export interface ServerConfig {
  readonly trustRenderProxy: boolean;
  readonly allowedOrigins: readonly string[];
  readonly host: string;
  readonly port: number;
  readonly releaseId: string;
}

export class ServerConfigError extends Error {
  public constructor(message: string = 'Invalid game server configuration') {
    super(message);
    this.name = 'ServerConfigError';
  }
}

export function parseServerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ServerConfig {
  const mode = parseEnvironment(environment.NODE_ENV);
  const port = parsePort(environment.PORT);
  const trustRenderProxy = environment.RENDER === 'true';
  const host = environment.HOST ?? (trustRenderProxy ? '0.0.0.0' : '127.0.0.1');
  const allowedOrigins = parseAllowedOrigins(environment.ALLOWED_WEB_ORIGINS, mode);

  if (host.length === 0 || host.trim() !== host) throw new ServerConfigError();
  if (mode === 'production' && allowedOrigins.length === 0) {
    throw new ServerConfigError();
  }

  return {
    allowedOrigins,
    trustRenderProxy,
    host,
    port,
    releaseId: release.version,
  };
}

function parseAllowedOrigins(
  value: string | undefined,
  environment: ServerEnvironment,
): readonly string[] {
  if (value === undefined) {
    return environment === 'production'
      ? []
      : [
          'http://localhost:3001',
          'http://127.0.0.1:3001',
          'http://localhost:4173',
          'http://127.0.0.1:4173',
        ];
  }

  const origins = value.split(',').map((origin) => origin.trim());
  if (origins.some((origin) => origin.length === 0)) throw new ServerConfigError();
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ServerConfigError();
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.origin !== origin ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      throw new ServerConfigError();
    }
  }
  return [...new Set(origins)];
}

function parseEnvironment(value: string | undefined): ServerEnvironment {
  const environment = value ?? 'development';
  if (environment !== 'development' && environment !== 'test' && environment !== 'production') {
    throw new ServerConfigError();
  }
  return environment;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3002;
  if (!/^\d+$/u.test(value)) throw new ServerConfigError();
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new ServerConfigError();
  return port;
}
