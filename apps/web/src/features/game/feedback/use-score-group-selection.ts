import { useCallback, useState } from 'react';

import type { TurnFeedbackSnapshot } from '@/features/game/feedback/use-turn-feedback';

type ScoreGroup = 'upper' | 'lower';
type ScoreTabFeedback = Pick<TurnFeedbackSnapshot, 'session' | 'record' | 'tabRequest'>;

interface ScoreGroupSelection {
  readonly session: object | null;
  readonly consumedVersion: number;
  readonly preferredGroup: ScoreGroup;
  readonly temporary: Readonly<{ version: number; group: ScoreGroup }> | null;
}

/** Keeps navigation choices independent of a briefly displayed record group. */
export function useScoreGroupSelection({ session, record, tabRequest }: ScoreTabFeedback) {
  const [state, setState] = useState<ScoreGroupSelection>({
    session: null,
    consumedVersion: -1,
    preferredGroup: 'upper',
    temporary: null,
  });
  let next =
    state.session === session ? state : { ...state, session, consumedVersion: -1, temporary: null };
  const showingRecord = record?.visible && (record.final || record.phase !== 'incoming');
  if (
    next.temporary !== null &&
    (!showingRecord || record.record.stateVersion !== next.temporary.version)
  )
    next = { ...next, temporary: null };

  if (tabRequest !== null && tabRequest.version > next.consumedVersion) {
    const temporary = showingRecord && record.record.stateVersion === tabRequest.version;
    next = {
      ...next,
      consumedVersion: tabRequest.version,
      preferredGroup: temporary ? next.preferredGroup : tabRequest.group,
      temporary: temporary && next.preferredGroup !== tabRequest.group ? tabRequest : null,
    };
  }
  // Project the group with the current owner, before either reaches the view.
  if (next !== state) setState(next);

  const selectGroup = useCallback((group: ScoreGroup) => {
    setState((current) =>
      current.preferredGroup === group && current.temporary === null
        ? current
        : { ...current, preferredGroup: group, temporary: null },
    );
  }, []);
  const selectYachtGroup = useCallback(() => selectGroup('lower'), [selectGroup]);

  return {
    activeGroup: next.temporary?.group ?? next.preferredGroup,
    selectGroup,
    selectYachtGroup,
  };
}
