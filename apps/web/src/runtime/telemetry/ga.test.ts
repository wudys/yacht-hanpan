// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { createGoogleAnalytics } from '@/runtime/telemetry/ga';
import type { ProductEvent } from '@/runtime/telemetry/telemetry';
afterEach(() => vi.unstubAllGlobals());
it('sends only manual sanitized events through the HTML-owned tag', () => {
  const tag = vi.fn();
  vi.stubGlobal('hanpanGtag', tag);
  const sink = createGoogleAnalytics('G-TEST123', 'https://yacht.example.com');
  expect(tag).not.toHaveBeenCalled();
  sink.send({ name: 'page_view', screen: 'game' });
  expect(tag.mock.calls).toEqual([
    [
      'config',
      'G-TEST123',
      {
        update: true,
        send_page_view: false,
        page_location: 'https://yacht.example.com/game',
        page_title: 'Yacht Hanpan · game',
        page_referrer: '',
      },
    ],
    [
      'event',
      'page_view',
      {
        screen: 'game',
        send_to: 'G-TEST123',
        page_location: 'https://yacht.example.com/game',
        page_title: 'Yacht Hanpan · game',
        page_referrer: '',
      },
    ],
  ]);
});
it('does not throw when the HTML-owned tag is absent', () => {
  vi.stubGlobal('hanpanGtag', undefined);
  const sink = createGoogleAnalytics('G-TEST123', 'https://yacht.example.com');
  expect(() => sink.send({ name: 'page_view', screen: 'entry' })).not.toThrow();
});

it.each<{ event: ProductEvent; parameters: Record<string, string | number> }>([
  { event: { name: 'page_view', screen: 'entry' }, parameters: { screen: 'entry' } },
  {
    event: { name: 'bootstrap_result', outcome: 'failure', duration_ms: 100 },
    parameters: { outcome: 'failure', duration_ms: 100 },
  },
  {
    event: { name: 'room_request', operation: 'join', phase: 'start' },
    parameters: { operation: 'join', phase: 'start' },
  },
  {
    event: { name: 'room_request', operation: 'join', phase: 'success', duration_ms: 200 },
    parameters: { operation: 'join', phase: 'success', duration_ms: 200 },
  },
  {
    event: { name: 'waiting_result', outcome: 'matched', duration_ms: 300 },
    parameters: { outcome: 'matched', duration_ms: 300 },
  },
  { event: { name: 'play_started', entry: 'new' }, parameters: { entry: 'new' } },
  {
    event: { name: 'play_finished', entry: 'resumed', reason: 'completed', outcome: 'win' },
    parameters: { entry: 'resumed', reason: 'completed', outcome: 'win' },
  },
  {
    event: { name: 'recovery_started', operation: 'reentry' },
    parameters: { operation: 'reentry' },
  },
  {
    event: {
      name: 'recovery_result',
      operation: 'connection',
      outcome: 'success',
      duration_ms: 400,
    },
    parameters: { operation: 'connection', outcome: 'success', duration_ms: 400 },
  },
])('sends only approved fields for $event.name', ({ event, parameters }) => {
  const tag = vi.fn();
  vi.stubGlobal('hanpanGtag', tag);
  const sink = createGoogleAnalytics('G-TEST123', 'https://yacht.example.com');
  // Structurally compatible objects can carry product data outside the event contract.
  const productData = {
    ...event,
    roomId: 'PRIVATE',
    seatToken: 'PRIVATE',
    error_code: 'INTERNAL_ERROR',
  };
  sink.send(productData);
  const page = {
    page_location: 'https://yacht.example.com/entry',
    page_title: 'Yacht Hanpan · entry',
    page_referrer: '',
  };
  expect(tag.mock.calls).toEqual([
    ...(event.name === 'page_view'
      ? [['config', 'G-TEST123', { update: true, send_page_view: false, ...page }]]
      : []),
    ['event', event.name, { ...parameters, send_to: 'G-TEST123', ...page }],
  ]);
});

it('updates virtual context before page views and preserves the prior internal referrer', () => {
  const tag = vi.fn();
  vi.stubGlobal('hanpanGtag', tag);
  window.history.replaceState(null, '', '/?PRIVATE_QUERY');
  const sink = createGoogleAnalytics('G-TEST123', 'https://yacht.example.com');
  sink.send({ name: 'page_view', screen: 'entry' });
  sink.send({ name: 'page_view', screen: 'loading' });
  sink.send({ name: 'bootstrap_result', outcome: 'success', duration_ms: 50 });
  sink.send({ name: 'page_view', screen: 'lobby' });
  expect(tag.mock.calls.map(([command, name]) => [command, name])).toEqual([
    ['config', 'G-TEST123'],
    ['event', 'page_view'],
    ['config', 'G-TEST123'],
    ['event', 'page_view'],
    ['event', 'bootstrap_result'],
    ['config', 'G-TEST123'],
    ['event', 'page_view'],
  ]);
  expect(tag.mock.calls[2]?.[2]).toEqual({
    update: true,
    send_page_view: false,
    page_location: 'https://yacht.example.com/loading',
    page_title: 'Yacht Hanpan · loading',
    page_referrer: 'https://yacht.example.com/entry',
  });
  expect(tag.mock.calls[4]?.[2]).toEqual({
    send_to: 'G-TEST123',
    outcome: 'success',
    duration_ms: 50,
    page_location: 'https://yacht.example.com/loading',
    page_title: 'Yacht Hanpan · loading',
    page_referrer: 'https://yacht.example.com/entry',
  });
  expect(tag.mock.calls[5]?.[2]).toEqual({
    update: true,
    send_page_view: false,
    page_location: 'https://yacht.example.com/lobby',
    page_title: 'Yacht Hanpan · lobby',
    page_referrer: 'https://yacht.example.com/loading',
  });
  expect(JSON.stringify(tag.mock.calls)).not.toContain('PRIVATE_QUERY');
});

it.each([
  { name: 'room_request', operation: 'join', phase: 'failure', duration_ms: 200 },
  { name: 'recovery_result', operation: 'connection', outcome: 'failure', duration_ms: 400 },
] as const)('projects only fixed typed failure fields for $name', (event) => {
  const tag = vi.fn();
  vi.stubGlobal('hanpanGtag', tag);
  const sink = createGoogleAnalytics('G-TEST123', 'https://yacht.example.com');
  const productData = {
    ...event,
    failure_kind: 'transport' as const,
    failure_code: 'ACK_TIMEOUT' as const,
    requestId: 'PRIVATE',
  };
  sink.send(productData);
  expect(tag.mock.calls[0]?.[2]).toMatchObject({
    failure_kind: 'transport',
    failure_code: 'ACK_TIMEOUT',
  });
  for (const fields of [
    { failure_kind: 'PRIVATE', failure_code: 'ACK_TIMEOUT' },
    { failure_kind: 'transport', failure_code: 'PRIVATE' },
  ]) {
    sink.send({ ...event, ...fields } as ProductEvent);
    const parameters = tag.mock.lastCall?.[2];
    expect(parameters).not.toHaveProperty('failure_kind');
    expect(parameters).not.toHaveProperty('failure_code');
  }
  expect(JSON.stringify(tag.mock.calls)).not.toContain('PRIVATE');
});

it.each([
  { name: 'room_request', operation: 'create', phase: 'start' },
  { name: 'room_request', operation: 'join', phase: 'success' },
  { name: 'recovery_result', operation: 'reentry', outcome: 'success', duration_ms: 10 },
  { name: 'recovery_result', operation: 'reentry', outcome: 'cancelled', duration_ms: 10 },
] as const)('does not attach failure fields to non-failure $name', (event) => {
  const tag = vi.fn();
  vi.stubGlobal('hanpanGtag', tag);
  const sink = createGoogleAnalytics('G-TEST123', 'https://yacht.example.com');
  sink.send({ ...event, failure_kind: 'server', failure_code: 'INTERNAL_ERROR' });
  expect(tag.mock.calls[0]?.[2]).not.toHaveProperty('failure_kind');
  expect(tag.mock.calls[0]?.[2]).not.toHaveProperty('failure_code');
});
