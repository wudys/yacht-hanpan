import type { ActionId, PresenceVersion, RequestId, StateVersion } from './index';

type IsAssignable<From, To> = [From] extends [To] ? true : false;
type AssertFalse<Value extends false> = Value;

export type ActionIsNotRequest = AssertFalse<IsAssignable<ActionId, RequestId>>;
export type StateIsNotPresence = AssertFalse<IsAssignable<StateVersion, PresenceVersion>>;
