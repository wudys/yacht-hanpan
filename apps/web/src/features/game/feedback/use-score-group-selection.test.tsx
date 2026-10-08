// @vitest-environment jsdom
import { parseGameSnapshot } from '@repo/game-protocol/state';
import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { expect, test } from 'vitest';

import { useScoreGroupSelection } from '@/features/game/feedback/use-score-group-selection';
import { playingGame } from '@/testing/game-fixtures';

type Feedback = Parameters<typeof useScoreGroupSelection>[0];

function confirmation(session: object, version: number = 8): Feedback {
  if (playingGame.match.status !== 'playing') throw new Error('Expected playing fixture');
  return {
    session,
    tabRequest: { version, group: 'lower' },
    record: {
      record: {
        stateVersion: parseGameSnapshot({ ...playingGame, stateVersion: version }).stateVersion,
        completedTurnId: playingGame.match.currentTurn.turnId,
        seatIndex: 0,
        categoryId: 'choice',
        score: 20,
      },
      startedAt: 0,
      phase: 'confirming',
      bonusEarned: false,
      final: false,
      visible: true,
    },
  };
}

test('StrictMode and duplicate feedback preserve the latest manual choice', () => {
  const feedback = confirmation({});
  const { result, rerender } = renderHook(useScoreGroupSelection, {
    initialProps: feedback,
    wrapper: StrictMode,
  });
  expect(result.current.activeGroup).toBe('lower');
  act(() => result.current.selectGroup('upper'));
  act(() => result.current.selectGroup('lower'));
  rerender({ ...feedback });
  rerender({ ...feedback, record: { ...feedback.record!, phase: 'incoming' } });
  expect(result.current.activeGroup).toBe('lower');
});

test('a new session discards the old temporary selection and can consume the same version', () => {
  const { result, rerender } = renderHook(useScoreGroupSelection, {
    initialProps: confirmation({}),
  });
  const session = {};
  rerender({ session, record: null, tabRequest: null });
  expect(result.current.activeGroup).toBe('upper');
  const fresh = confirmation(session);
  rerender(fresh);
  expect(result.current.activeGroup).toBe('lower');
  rerender({ ...fresh, record: { ...fresh.record!, phase: 'incoming' } });
  expect(result.current.activeGroup).toBe('upper');
});

test('a newer confirmation restores the preference rather than stacking temporary tabs', () => {
  const session = {};
  const { result, rerender } = renderHook(useScoreGroupSelection, {
    initialProps: confirmation(session),
  });
  const newer = confirmation(session, 9);
  rerender(newer);
  expect(result.current.activeGroup).toBe('lower');
  rerender({ ...newer, record: { ...newer.record!, phase: 'incoming' } });
  expect(result.current.activeGroup).toBe('upper');
});

test('Yacht navigation becomes the preference for a later confirmation', () => {
  const session = {};
  const { result, rerender } = renderHook(useScoreGroupSelection, {
    initialProps: { session, record: null, tabRequest: null } as Feedback,
  });
  const { selectYachtGroup } = result.current;
  act(() => selectYachtGroup());
  const lower = confirmation(session);
  const upper: Feedback = {
    ...lower,
    tabRequest: { version: 8, group: 'upper' },
    record: { ...lower.record!, record: { ...lower.record!.record, categoryId: 'twos' } },
  };
  rerender(upper);
  expect(result.current.activeGroup).toBe('upper');
  expect(result.current.selectYachtGroup).toBe(selectYachtGroup);
  rerender({ ...upper, record: { ...upper.record!, phase: 'incoming' } });
  expect(result.current.activeGroup).toBe('lower');
});
