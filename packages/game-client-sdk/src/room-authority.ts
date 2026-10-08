import type { CreateRoomResponse, JoinRoomResponse } from '@repo/game-protocol/http';

export type RoomAuthority = Extract<
  CreateRoomResponse | JoinRoomResponse,
  { readonly ok: true }
>['data']['authority'];
