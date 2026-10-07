import { describe, expect, test } from 'bun:test';

import { createJsonLogger, type LogFields, protectLogger } from '@/runtime/logger';

describe('JSON logger', () => {
  test('preserves a class logger method surface and receiver', () => {
    class ErrorLogger {
      public readonly events: string[] = [];
      public error(event: string, _fields?: LogFields): void {
        this.events.push(event);
        throw new Error('diagnostic failure');
      }
    }
    const source = new ErrorLogger();
    const logger = protectLogger(source);
    expect(Object.keys(logger)).toEqual(['error']);
    expect(() => logger.error('failed')).not.toThrow();
    expect(source.events).toEqual(['failed']);
  });

  test('retains minimum log level and circular field normalization', () => {
    const lines: string[] = [];
    const logger = createJsonLogger((line) => lines.push(line), 'warn');
    const fields: Record<string, unknown> = { safe: 'visible' };
    fields.self = fields;
    logger.info('filtered');
    logger.warn('circular', fields);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { level: 'warn', event: 'circular', safe: 'visible', self: '[Circular]' },
    ]);
  });

  test('isolates synchronous sink and field normalization failures', () => {
    const failure = () => {
      throw new Error('diagnostic failure');
    };
    const logger = createJsonLogger(failure);
    expect(() => logger.info('sink.failed')).not.toThrow();
    expect(() =>
      logger.error('normalization.failed', {
        get field() {
          return failure();
        },
      }),
    ).not.toThrow();
  });

  test('writes one structured JSON event', () => {
    const lines: string[] = [];
    const logger = createJsonLogger((line) => lines.push(line));

    logger.info('http.completed', {
      requestId: 'request-1',
      method: 'POST',
      status: 201,
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      level: 'info',
      event: 'http.completed',
      requestId: 'request-1',
      method: 'POST',
      status: 201,
    });
  });

  test('suppresses routine debug output by default while retaining operational events', () => {
    const lines: string[] = [];
    const logger = createJsonLogger((line) => lines.push(line));
    logger.debug('routine');
    logger.info('aggregate');
    logger.warn('recovery');
    logger.error('failure');
    expect(lines.map((line) => JSON.parse(line).event)).toEqual([
      'aggregate',
      'recovery',
      'failure',
    ]);
  });

  test('recursively redacts authority and secret-shaped keys', () => {
    const lines: string[] = [];
    const logger = createJsonLogger((line) => lines.push(line));

    logger.warn('security.rejected', {
      authorization: 'Bearer raw-secret',
      nested: {
        seatToken: 'raw-token',
        credentialHash: 'private-hash',
        safe: 'visible',
      },
    });

    const line = lines[0]!;
    expect(line).not.toMatch(/raw-secret|raw-token|private-hash/u);
    expect(JSON.parse(line)).toEqual({
      level: 'warn',
      event: 'security.rejected',
      authorization: '[REDACTED]',
      nested: {
        seatToken: '[REDACTED]',
        credentialHash: '[REDACTED]',
        safe: 'visible',
      },
    });
  });

  test('normalizes thrown values without serializing stack or arbitrary properties', () => {
    const lines: string[] = [];
    const logger = createJsonLogger((line) => lines.push(line));
    const error = Object.assign(new Error('private failure'), { seatToken: 'raw-token' });

    logger.error('internal.failed', { error });

    expect(JSON.parse(lines[0]!)).toEqual({
      level: 'error',
      event: 'internal.failed',
      error: { name: 'Error' },
    });
    expect(lines[0]).not.toMatch(/private failure|raw-token|stack/u);
  });
});
