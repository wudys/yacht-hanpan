import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';

// Render's public ingress passes through Cloudflare. Never trust arbitrary XFF chains.
export function resolveClientAddress(
  headers: IncomingHttpHeaders,
  directAddress: string | undefined,
  trustRenderProxy: boolean,
): string {
  const forwarded = headers['cf-connecting-ip'];
  const edgeAddress =
    trustRenderProxy && typeof forwarded === 'string' ? normalizeIp(forwarded.trim()) : null;
  return edgeAddress ?? normalizeIp(directAddress ?? '') ?? 'unknown';
}

function normalizeIp(address: string): string | null {
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) return address.slice(7);
  const version = isIP(address);
  if (version === 4) return address;
  if (version === 6 && !address.includes('%'))
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return null;
}
