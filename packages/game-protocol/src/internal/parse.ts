import * as v from 'valibot';

type Schema = v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>;

export class GameApiParseError extends Error {
  public readonly code: 'INVALID_GAME_API_VALUE' = 'INVALID_GAME_API_VALUE';

  public constructor() {
    super('Invalid game API value');
    this.name = 'GameApiParseError';
  }
}

export type SafeParseResult<Output> =
  | { readonly success: true; readonly output: Output }
  | { readonly success: false; readonly error: GameApiParseError };

export function parseWith<const TSchema extends Schema>(
  schema: TSchema,
  input: unknown,
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, input);
  if (!result.success) throw new GameApiParseError();
  return result.output;
}

export function safeParseWith<const TSchema extends Schema>(
  schema: TSchema,
  input: unknown,
): SafeParseResult<v.InferOutput<TSchema>> {
  const result = v.safeParse(schema, input);
  return result.success
    ? { success: true, output: result.output }
    : { success: false, error: new GameApiParseError() };
}
