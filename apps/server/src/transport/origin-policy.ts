export function isBrowserOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  return origin === undefined || allowedOrigins.includes(origin);
}
