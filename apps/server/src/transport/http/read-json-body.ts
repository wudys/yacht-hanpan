import type { IncomingMessage } from 'node:http';

const JSON_BODY_LIMIT_BYTES = 16 * 1_024;

class UnsupportedMediaTypeError extends Error {}
class BodyTooLargeError extends Error {}
class InvalidJsonBodyError extends Error {}
class BodyReadTimeoutError extends Error {}

type JsonBodyReadResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly status: 400 | 408 | 413 | 415;
      readonly closeConnection: boolean;
    };

export async function readJsonBody(
  request: IncomingMessage,
  timeoutMs: number = 5_000,
): Promise<JsonBodyReadResult> {
  try {
    let value: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      value = await Promise.race([
        parseJsonBody(request),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new BodyReadTimeoutError()), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof BodyReadTimeoutError) {
      return { ok: false, status: 408, closeConnection: true };
    }
    if (error instanceof UnsupportedMediaTypeError) {
      return { ok: false, status: 415, closeConnection: false };
    }
    if (error instanceof BodyTooLargeError) {
      return { ok: false, status: 413, closeConnection: true };
    }
    return { ok: false, status: 400, closeConnection: false };
  }
}

async function parseJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = headerValue(request.headers['content-type']);
  if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new UnsupportedMediaTypeError();
  }
  const contentLength = Number(headerValue(request.headers['content-length']) ?? '0');
  if (Number.isFinite(contentLength) && contentLength > JSON_BODY_LIMIT_BYTES) {
    throw new BodyTooLargeError();
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > JSON_BODY_LIMIT_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new InvalidJsonBodyError();
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
