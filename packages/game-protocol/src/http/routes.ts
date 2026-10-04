import type { CancelRoomRequest } from './cancel-room';
import type { JoinRoomRequest } from './join-room';
import type { ResumeRoomRequest } from './resume-room';

export const HTTP_METHOD = {
  GET: 'GET',
  OPTIONS: 'OPTIONS',
  POST: 'POST',
} as const;

export const ROOM_HTTP_ROUTE_KIND = {
  CREATE: 'createRoom',
  CANCEL: 'cancelRoom',
  JOIN: 'joinRoom',
  RESUME: 'resumeRoom',
} as const;

export const ROOM_HTTP_PATH = {
  CREATE: '/rooms',
  cancel: (roomId: CancelRoomRequest['roomId']): string => `/rooms/${roomId}/cancel`,
  join: (roomCode: JoinRoomRequest['roomCode']): string => `/rooms/${roomCode}/join`,
  resume: (roomId: ResumeRoomRequest['roomId']): string => `/rooms/${roomId}/resume`,
} as const;

export type RoomHttpPathMatch =
  | { readonly kind: typeof ROOM_HTTP_ROUTE_KIND.CREATE }
  | { readonly kind: typeof ROOM_HTTP_ROUTE_KIND.CANCEL; readonly roomId: string }
  | { readonly kind: typeof ROOM_HTTP_ROUTE_KIND.JOIN; readonly roomCode: string }
  | { readonly kind: typeof ROOM_HTTP_ROUTE_KIND.RESUME; readonly roomId: string };

export function matchRoomHttpPath(pathname: string): RoomHttpPathMatch | null {
  if (pathname === ROOM_HTTP_PATH.CREATE) return { kind: ROOM_HTTP_ROUTE_KIND.CREATE };

  const join = /^\/rooms\/([^/]+)\/join$/u.exec(pathname);
  if (join?.[1] !== undefined) {
    return { kind: ROOM_HTTP_ROUTE_KIND.JOIN, roomCode: join[1] };
  }

  const cancel = /^\/rooms\/([^/]+)\/cancel$/u.exec(pathname);
  if (cancel?.[1] !== undefined) {
    return { kind: ROOM_HTTP_ROUTE_KIND.CANCEL, roomId: cancel[1] };
  }

  const resume = /^\/rooms\/([^/]+)\/resume$/u.exec(pathname);
  if (resume?.[1] !== undefined) {
    return { kind: ROOM_HTTP_ROUTE_KIND.RESUME, roomId: resume[1] };
  }

  return null;
}
