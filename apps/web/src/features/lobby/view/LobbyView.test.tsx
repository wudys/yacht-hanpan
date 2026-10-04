// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { LobbyView } from '@/features/lobby/view/LobbyView';

afterEach(cleanup);

const props = {
  profile: { imageUrl: '/character.webp', alt: 'Player' },
  labels: {
    editProfile: 'Edit profile',
    settings: 'Settings',
    createRoom: 'Create game',
    joinRoom: 'Join game',
  },
} as const;

test.each([false, true])(
  'gates each room action when interactionLocked=%s',
  (interactionLocked) => {
    const create = vi.fn();
    const join = vi.fn();
    render(
      <LobbyView
        {...props}
        interactionLocked={interactionLocked}
        onCreateRoom={create}
        onJoinRoom={join}
      />,
    );

    expect(screen.getByRole('main').hasAttribute('inert')).toBe(interactionLocked);

    fireEvent.click(screen.getByRole('button', { name: props.labels.createRoom }));
    fireEvent.click(screen.getByRole('button', { name: props.labels.joinRoom }));

    expect(create).toHaveBeenCalledTimes(interactionLocked ? 0 : 1);
    expect(join).toHaveBeenCalledTimes(interactionLocked ? 0 : 1);
  },
);
