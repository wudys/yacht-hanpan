import type { ServerClock } from '@repo/game-client-sdk';
import { useLayoutEffect } from 'react';

import { useDeadlineSeconds } from '@/features/game/game-display-hooks';
import { GameTimer } from '@/features/game/view/board';
import { type Locale, translate } from '@/i18n';

export function GameDeadlineDisplay({
  clock,
  deadlineAt,
  locale,
  onReadinessSample,
}: Readonly<{
  clock: Pick<ServerClock, 'now'>;
  deadlineAt: number | null;
  locale: Locale;
  onReadinessSample: () => void;
}>) {
  const seconds = useDeadlineSeconds(clock, deadlineAt);
  const ready = seconds !== null && seconds > 0;
  // A remounted display can poll before the input gate; align boundary changes before paint.
  useLayoutEffect(onReadinessSample, [onReadinessSample, ready]);
  return (
    <GameTimer
      label={`${seconds ?? '—'}${translate(locale, 'game.seconds')}`}
      warning={seconds !== null && seconds <= 5}
    />
  );
}
