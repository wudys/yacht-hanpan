import { describe, expect, test } from 'bun:test';

import { resolveClientAddress } from '@/transport/client-address';

describe('client address at the Render boundary', () => {
  test('ignores caller-controlled forwarding headers outside Render', () => {
    expect(
      resolveClientAddress(
        { 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.2' },
        '::ffff:127.0.0.1',
        false,
      ),
    ).toBe('127.0.0.1');
  });

  test('uses one valid edge IP and canonicalizes IPv6 for a shared rate-limit key', () => {
    expect(
      resolveClientAddress(
        { 'cf-connecting-ip': '2001:0db8:0:0:0:0:0:1', 'x-forwarded-for': '192.0.2.2' },
        '10.0.0.1',
        true,
      ),
    ).toBe('2001:db8::1');
    expect(resolveClientAddress({ 'cf-connecting-ip': '::ffff:192.0.2.1' }, '10.0.0.1', true)).toBe(
      '192.0.2.1',
    );
  });

  test.each(
    [
      undefined,
      '',
      'not-an-ip',
      '192.0.2.1, 192.0.2.2',
      ['192.0.2.1', '192.0.2.2'],
      'fe80::1%eth0',
    ].map((forwarded) => ({ forwarded })),
  )('falls back to the direct peer for absent or invalid edge IP (%j)', ({ forwarded }) => {
    expect(
      resolveClientAddress(
        { 'cf-connecting-ip': forwarded, 'x-forwarded-for': '192.0.2.2' },
        '10.0.0.1',
        true,
      ),
    ).toBe('10.0.0.1');
  });
});
