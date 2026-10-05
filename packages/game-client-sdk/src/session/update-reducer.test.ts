import {
  GAME_COMMAND_TYPE,
  type GameCommand,
  type GameSnapshot,
  parseCommittedRoomUpdate,
  parseGameCommand,
  parseRoomView,
  type RoomView,
} from '@repo/game-protocol/socket';
import { describe, expect, test } from 'bun:test';

import {
  createSessionState,
  reduceCommandView,
  reduceCommittedUpdate,
  reduceRestoredView,
  reduceRoomView,
  type SessionState,
} from './update-reducer';

const ROOM_ID = '01890f47-e89b-7cc3-98c5-4c5da03f78ab';
const TURN_ID = turnId('de305d54-75b4-431b-adb2-eb6b9e546018');
const NEXT_TURN_ID = turnId('de305d54-75b4-431b-adb2-eb6b9e546019');
const SCORE_COMMAND = scoreCommand();

function scoreCommand() {
  const command = parseGameCommand({
    type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
    actionId: 'de305d54-75b4-431b-adb2-eb6b9e546020',
    turnId: TURN_ID,
    categoryId: 'ones',
  });
  if (command.type !== GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY)
    throw new Error('expected score command');
  return command;
}

function turnId(id: string) {
  const command = parseGameCommand({
    type: GAME_COMMAND_TYPE.ROLL_DICE,
    actionId: 'de305d54-75b4-431b-adb2-eb6b9e546020',
    turnId: id,
  });
  if (command.type !== GAME_COMMAND_TYPE.ROLL_DICE) throw new Error('expected roll command');
  return command.turnId;
}

function version(value: number) {
  return view(value).game!.stateVersion;
}

type PlayingMatch = Extract<GameSnapshot['match'], { status: 'playing' }>;

function alterMatch(original: RoomView, transform: (match: PlayingMatch) => GameSnapshot['match']) {
  if (original.game?.match.status !== 'playing') throw new Error('expected playing fixture');
  const match = transform(original.game.match);
  return parseRoomView({
    ...original,
    room:
      match.status === 'finished'
        ? { ...original.room, status: 'finished', finishedAt: 3000 }
        : original.room,
    game: { ...original.game, match },
  });
}

function live(state: SessionState, incoming: RoomView): SessionState {
  const reduction = reduceCommittedUpdate(
    state,
    parseCommittedRoomUpdate({ type: 'state:committed', view: incoming }),
  );
  if (reduction.kind === 'invalid') throw new Error('unexpected invalid update');
  return reduction.state;
}

function timeoutView(stateVersion = 2) {
  return alterMatch(view(stateVersion), (match) => ({
    ...match,
    players: [{ ...match.players[0], timeoutCount: 1 }, match.players[1]],
    currentTurn: { ...match.currentTurn, turnId: NEXT_TURN_ID, seatIndex: 1 },
  }));
}

function waitingView() {
  return parseRoomView({
    room: {
      status: 'waiting',
      roomId: ROOM_ID,
      roomCode: '001204',
      createdAt: 1000,
      expiresAt: 301000,
      seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
    },
    game: null,
    presence: { roomId: ROOM_ID, presenceVersion: 0, seats: [{ status: 'connected' }] },
  });
}

function scoredView(stateVersion = 2, score = 0) {
  const baseline = view(stateVersion);
  if (baseline.game?.match.status !== 'playing') throw new Error('expected playing fixture');
  return parseRoomView({
    ...baseline,
    game: {
      ...baseline.game,
      match: {
        ...baseline.game.match,
        players: [{ scorecard: { ones: score }, timeoutCount: 0 }, baseline.game.match.players[1]],
        currentTurn: {
          ...baseline.game.match.currentTurn,
          turnId: NEXT_TURN_ID,
          seatIndex: 1,
        },
      },
    },
  });
}

function view(stateVersion: number, presenceVersion = 1) {
  return parseRoomView({
    room: {
      status: 'playing',
      roomId: ROOM_ID,
      roomCode: '001204',
      createdAt: 1000,
      startedAt: 2000,
      seats: [
        { profile: { characterId: 'navy-bob', variant: false } },
        { profile: { characterId: 'blonde-buns', variant: false } },
      ],
    },
    game: {
      stateVersion,
      match: {
        status: 'playing',
        players: [
          { scorecard: {}, timeoutCount: 0 },
          { scorecard: {}, timeoutCount: 0 },
        ],
        currentTurn: {
          turnId: TURN_ID,
          seatIndex: 0,
          startedAt: 1,
          deadlineAt: 60001,
          rollCount: 0,
          heldSlots: [],
          dice: null,
        },
      },
    },
    presence: {
      roomId: ROOM_ID,
      presenceVersion,
      seats: [{ status: 'connected' }, { status: 'connected' }],
    },
  });
}

describe('authoritative whole-view acceptance', () => {
  test('a continuous live score records zero with its completed turn and active seat', () => {
    const incoming = scoredView();
    const reduction = reduceCommittedUpdate(
      { view: view(1), presentation: { kind: 'settled' } },
      parseCommittedRoomUpdate({ type: 'state:committed', view: incoming }),
    );
    expect(reduction).toMatchObject({
      kind: 'applied',
      state: {
        presentation: {
          kind: 'score',
          record: {
            stateVersion: 2,
            completedTurnId: TURN_ID,
            seatIndex: 0,
            categoryId: 'ones',
            score: 0,
          },
        },
      },
    });
  });

  test('accepts a baseline and a coherent version jump as settled complete views', () => {
    const baselineUpdate = parseCommittedRoomUpdate({ type: 'state:committed', view: view(1) });
    const baseline = reduceCommittedUpdate(createSessionState(), baselineUpdate);
    expect(baseline.kind).toBe('applied');
    if (baseline.kind !== 'applied') throw new Error('expected applied baseline');
    const jumpUpdate = parseCommittedRoomUpdate({ type: 'state:committed', view: view(5, 3) });
    const jump = reduceCommittedUpdate(baseline.state, jumpUpdate);
    expect(jump.kind).toBe('applied');
    if (jump.kind !== 'applied') throw new Error('expected applied jump');
    expect(jump.state.view).toBe(jumpUpdate.view);
    expect(jump.state.presentation).toEqual({ kind: 'settled' });
  });

  test.each([
    { game: 5, presence: 6, kind: 'applied' },
    { game: 6, presence: 5, kind: 'applied' },
    { game: 6, presence: 6, kind: 'applied' },
    { game: 5, presence: 5, kind: 'ignored' },
    { game: 4, presence: 5, kind: 'ignored' },
    { game: 5, presence: 4, kind: 'ignored' },
    { game: 4, presence: 4, kind: 'ignored' },
    { game: 4, presence: 6, kind: 'invalid' },
    { game: 6, presence: 4, kind: 'invalid' },
  ] as const)('keeps the complete view indivisible for $game/$presence: $kind', (candidate) => {
    const current = {
      view: view(5, 5),
      presentation: { kind: 'settled' as const },
    };
    const incoming = view(candidate.game, candidate.presence);
    const reduction = reduceRoomView(current, incoming);
    expect(reduction.kind).toBe(candidate.kind);
    if (reduction.kind === 'applied') expect(reduction.state.view).toBe(incoming);
    if (reduction.kind === 'ignored') expect(reduction.state).toBe(current);
    expect(Number(current.view.game?.stateVersion)).toBe(5);
    expect(Number(current.view.presence.presenceVersion)).toBe(5);
  });

  test('a stale waiting view cannot replace playing lifecycle or profiles', () => {
    const current = {
      view: view(5, 5),
      presentation: { kind: 'settled' as const },
    };
    const waiting = parseRoomView({
      room: {
        status: 'waiting',
        roomId: ROOM_ID,
        roomCode: '001204',
        createdAt: 1000,
        expiresAt: 301000,
        seats: [{ profile: { characterId: 'black-hime', variant: false } }],
      },
      game: null,
      presence: { roomId: ROOM_ID, presenceVersion: 4, seats: [{ status: 'connected' }] },
    });
    const reduction = reduceRoomView(current, waiting);
    expect(reduction).toEqual({ kind: 'ignored', state: current });
    expect(current.view.room.seats[0].profile.characterId).toBe('navy-bob');
  });
});

describe('fresh score and turn provenance', () => {
  const baseline: SessionState = { view: view(1), presentation: { kind: 'settled' } };

  test('records the prior active opponent and a scoresCompleted final record', () => {
    const previous = alterMatch(view(1), (match) => ({
      ...match,
      currentTurn: { ...match.currentTurn, seatIndex: 1 },
    }));
    const incoming = alterMatch(view(2), (match) => ({
      ...match,
      players: [match.players[0], { scorecard: { yacht: 50 }, timeoutCount: 0 }],
      currentTurn: { ...match.currentTurn, turnId: NEXT_TURN_ID },
    }));
    expect(live({ ...baseline, view: previous }, incoming).presentation).toMatchObject({
      kind: 'score',
      record: {
        stateVersion: 2,
        completedTurnId: TURN_ID,
        seatIndex: 1,
        categoryId: 'yacht',
        score: 50,
      },
    });
    const final = alterMatch(scoredView(), (match) => ({
      status: 'finished',
      players: match.players,
      result: { reason: 'scoresCompleted', winnerSeatIndex: null },
    }));
    expect(live(baseline, final).presentation).toMatchObject({
      kind: 'score',
      record: { categoryId: 'ones', score: 0 },
    });
  });

  test.each([
    { name: 'an extra active category', card: { ones: 0, twos: 4 } },
    { name: 'no added category', card: {} },
  ])('does not turn $name into a score event', ({ card }) => {
    const incoming = alterMatch(scoredView(), (match) => ({
      ...match,
      players: [{ ...match.players[0], scorecard: card }, match.players[1]],
    }));
    expect(live(baseline, incoming).presentation).toEqual({ kind: 'settled' });
  });

  test.each(['changed', 'removed'] as const)('rejects a %s prior active score', (kind) => {
    const previous = alterMatch(view(1), (match) => ({
      ...match,
      players: [{ ...match.players[0], scorecard: { twos: 4 } }, match.players[1]],
    }));
    const incoming = alterMatch(scoredView(), (match) => ({
      ...match,
      players: [
        { ...match.players[0], scorecard: kind === 'changed' ? { ones: 0, twos: 6 } : { ones: 0 } },
        match.players[1],
      ],
    }));
    expect(live({ ...baseline, view: previous }, incoming).presentation).toEqual({
      kind: 'settled',
    });
  });

  test.each([
    'opponent-card',
    'active-timeout',
    'opponent-timeout',
    'same-owner',
    'same-turn',
    'rolled-turn',
    'other-finish',
  ] as const)('does not infer a record when %s also changes', (kind) => {
    const incoming = alterMatch(scoredView(), (match) => {
      if (kind === 'other-finish')
        return {
          status: 'finished',
          players: match.players,
          result: { reason: 'explicitForfeit', winnerSeatIndex: 1 },
        };
      return {
        ...match,
        players: [
          { ...match.players[0], timeoutCount: kind === 'active-timeout' ? 1 : 0 },
          {
            scorecard: kind === 'opponent-card' ? { twos: 4 } : {},
            timeoutCount: kind === 'opponent-timeout' ? 1 : 0,
          },
        ],
        currentTurn:
          kind === 'rolled-turn'
            ? {
                ...match.currentTurn,
                rollCount: 1,
                dice: [{ value: 1 }, { value: 1 }, { value: 1 }, { value: 1 }, { value: 1 }],
              }
            : {
                ...match.currentTurn,
                seatIndex: kind === 'same-owner' ? 0 : 1,
                turnId: kind === 'same-turn' ? TURN_ID : NEXT_TURN_ID,
              },
      };
    });
    expect(live(baseline, incoming).presentation).toEqual({ kind: 'settled' });
  });

  test('baseline, a gap, plain acceptance and restored score views only settle', () => {
    expect(live(createSessionState(), scoredView()).presentation).toEqual({ kind: 'settled' });
    expect(live(baseline, scoredView(3)).presentation).toEqual({ kind: 'settled' });
    for (const reduce of [reduceRoomView, reduceRestoredView]) {
      expect(reduce(baseline, scoredView())).toMatchObject({
        state: { presentation: { kind: 'settled' } },
      });
    }
  });

  test.each(['score', 'turn'] as const)(
    'presence and duplicates preserve %s identity; recovery settles only current or newer',
    (kind) => {
      const currentView = kind === 'score' ? scoredView() : timeoutView();
      const fresh = live(baseline, currentView);
      const presenceOnly = parseRoomView({
        ...currentView,
        presence: { ...currentView.presence, presenceVersion: 2 },
      });
      const updated = live(fresh, presenceOnly);
      expect(updated.presentation).toBe(fresh.presentation);
      expect(live(updated, presenceOnly)).toBe(updated);
      expect(reduceRestoredView(updated, view(1))).toEqual({ kind: 'ignored', state: updated });
      expect(reduceRestoredView(updated, presenceOnly)).toMatchObject({
        kind: 'ignored',
        state: { presentation: { kind: 'settled' } },
      });
      const newer = parseRoomView({ ...scoredView(3), presence: presenceOnly.presence });
      expect(reduceRestoredView(updated, newer)).toMatchObject({
        kind: 'applied',
        state: { presentation: { kind: 'settled' } },
      });
    },
  );

  test.each([
    'match',
    'gap',
    'older-receipt',
    'wrong-turn',
    'wrong-category',
    'other-command',
  ] as const)(
    'score ACK %s needs a consecutive version, matching original command and receipt version',
    (kind) => {
      let command: GameCommand = SCORE_COMMAND;
      if (command.type !== GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY)
        throw new Error('expected score command');
      if (kind === 'wrong-turn') command = { ...SCORE_COMMAND, turnId: NEXT_TURN_ID };
      if (kind === 'wrong-category') command = { ...SCORE_COMMAND, categoryId: 'twos' };
      if (kind === 'other-command')
        command = { type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: command.actionId };
      const reduction = reduceCommandView(
        baseline,
        {
          receipt: { stateVersion: version(kind === 'older-receipt' ? 1 : kind === 'gap' ? 3 : 2) },
          view: scoredView(kind === 'gap' ? 3 : 2),
        },
        command,
      );
      expect(reduction).toMatchObject({
        state: { presentation: { kind: kind === 'match' ? 'score' : 'settled' } },
      });
    },
  );

  test('live-first and ACK-first retain the first score object without restart', () => {
    const incoming = scoredView();
    const liveFirst = live(baseline, incoming);
    const ackAfter = reduceCommandView(
      liveFirst,
      { receipt: { stateVersion: version(2) }, view: incoming },
      SCORE_COMMAND,
    );
    expect(ackAfter).toEqual({ kind: 'ignored', state: liveFirst });
    const ackFirst = reduceCommandView(
      baseline,
      { receipt: { stateVersion: version(2) }, view: incoming },
      SCORE_COMMAND,
    );
    if (ackFirst.kind === 'invalid') throw new Error('expected accepted ACK');
    expect(live(ackFirst.state, incoming)).toBe(ackFirst.state);
  });

  test('a turn cue requires a known waiting baseline or exactly one active-seat timeout', () => {
    expect(live({ view: waitingView(), presentation: null }, view(1)).presentation).toEqual({
      kind: 'turn',
      turnId: TURN_ID,
    });
    expect(live(createSessionState(), view(1)).presentation).toEqual({ kind: 'settled' });
    expect(live(baseline, timeoutView()).presentation).toEqual({
      kind: 'turn',
      turnId: NEXT_TURN_ID,
    });
    expect(
      reduceCommandView(
        baseline,
        { receipt: { stateVersion: version(2) }, view: timeoutView() },
        SCORE_COMMAND,
      ),
    ).toMatchObject({ state: { presentation: { kind: 'settled' } } });
  });

  test('accepts a live timeout version gap as settled authority without a turn cue', () => {
    const update = parseCommittedRoomUpdate({ type: 'state:committed', view: timeoutView(3) });
    const reduction = reduceCommittedUpdate(baseline, update);
    expect(reduction.kind).toBe('applied');
    if (reduction.kind !== 'applied') throw new Error('expected accepted timeout gap');
    expect(reduction.state.view).toBe(update.view);
    expect(reduction.state.presentation).toEqual({ kind: 'settled' });
  });

  test.each([
    'no-timeout',
    'two-timeouts',
    'opponent-timeout',
    'both-timeouts',
    'score-change',
    'same-owner',
    'same-turn',
    'rolled-turn',
  ] as const)('turn-id changes with %s are not fresh timeout turns', (kind) => {
    const incoming = alterMatch(timeoutView(), (match) => ({
      ...match,
      players: [
        {
          scorecard: kind === 'score-change' ? { ones: 0 } : {},
          timeoutCount:
            kind === 'no-timeout' || kind === 'opponent-timeout'
              ? 0
              : kind === 'two-timeouts'
                ? 2
                : 1,
        },
        {
          scorecard: {},
          timeoutCount: kind === 'opponent-timeout' || kind === 'both-timeouts' ? 1 : 0,
        },
      ],
      currentTurn:
        kind === 'rolled-turn'
          ? {
              ...match.currentTurn,
              rollCount: 1,
              dice: [{ value: 1 }, { value: 1 }, { value: 1 }, { value: 1 }, { value: 1 }],
            }
          : {
              ...match.currentTurn,
              seatIndex: kind === 'same-owner' ? 0 : 1,
              turnId: kind === 'same-turn' ? TURN_ID : NEXT_TURN_ID,
            },
    }));
    expect(live(baseline, incoming).presentation).toEqual({ kind: 'settled' });
  });
});
