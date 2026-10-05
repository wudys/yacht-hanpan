import * as v from 'valibot';

function uuidSchema<const Name extends v.BrandName>(name: Name) {
  return v.pipe(v.string(), v.uuid(), v.brand(name));
}

function uuidV4Schema<const Name extends v.BrandName>(name: Name) {
  return v.pipe(
    v.string(),
    v.uuid(),
    v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu),
    v.brand(name),
  );
}

function uuidV7Schema<const Name extends v.BrandName>(name: Name) {
  return v.pipe(
    v.string(),
    v.uuid(),
    v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu),
    v.brand(name),
  );
}

function counterSchema<const Name extends v.BrandName>(name: Name) {
  return v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0), v.brand(name));
}

export const actionIdSchema = uuidSchema('ActionId');
export const clientIdSchema = uuidV7Schema('ClientId');
export const operationIdSchema = uuidSchema('OperationId');
export const requestIdSchema = uuidSchema('RequestId');
export const rollIdSchema = uuidSchema('RollId');
export const roomIdSchema = uuidV7Schema('RoomId');
export const seatIndexSchema = v.picklist([0, 1]);
export const seatTokenSchema = uuidV4Schema('SeatToken');
export const turnIdSchema = uuidSchema('TurnId');

export const epochMillisecondsSchema = v.pipe(
  v.number(),
  v.finite(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER),
  v.brand('EpochMilliseconds'),
);
export const presenceVersionSchema = counterSchema('PresenceVersion');
export const stateVersionSchema = counterSchema('StateVersion');

export const roomCodeSchema = v.pipe(v.string(), v.regex(/^\d{6}$/u), v.brand('RoomCode'));

export type ActionId = v.InferOutput<typeof actionIdSchema>;
export type ClientId = v.InferOutput<typeof clientIdSchema>;
export type RequestId = v.InferOutput<typeof requestIdSchema>;
export type RollId = v.InferOutput<typeof rollIdSchema>;
export type RoomId = v.InferOutput<typeof roomIdSchema>;
export type SeatIndex = v.InferOutput<typeof seatIndexSchema>;
export type SeatToken = v.InferOutput<typeof seatTokenSchema>;
export type TurnId = v.InferOutput<typeof turnIdSchema>;
export type EpochMilliseconds = v.InferOutput<typeof epochMillisecondsSchema>;
export type PresenceVersion = v.InferOutput<typeof presenceVersionSchema>;
export type StateVersion = v.InferOutput<typeof stateVersionSchema>;
export type RoomCode = v.InferOutput<typeof roomCodeSchema>;
