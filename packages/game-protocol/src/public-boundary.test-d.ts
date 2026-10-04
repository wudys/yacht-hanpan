// Raw schema objects are implementation details; consumers receive parsers and inferred DTO types.
// @ts-expect-error raw command schemas are intentionally absent from the public Socket entry.
type GameCommandSchema = typeof import('@repo/game-protocol/socket').gameCommandSchema;
type ResolvedRollArtifactSchema =
  // @ts-expect-error raw artifact schemas are intentionally absent from the public Socket entry.
  typeof import('@repo/game-protocol/socket').resolvedRollArtifactSchema;

export type PublicSchemaLeakCheck = [GameCommandSchema, ResolvedRollArtifactSchema];
