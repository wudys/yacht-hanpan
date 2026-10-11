import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ArtifactOperations {
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly cp: typeof cp;
  readonly mkdir: (path: string, options: { recursive: true }) => Promise<string | undefined>;
  readonly rm: typeof rm;
}

// Tooling-local seam for preparation faults; the artifact contains no project source.
export async function withBuiltServerArtifact<Result>(
  packageRoot: string,
  run: (directory: string) => Result | Promise<Result>,
  overrides: Partial<ArtifactOperations> = {},
): Promise<Result> {
  const operations = { mkdtemp, cp, mkdir, rm, ...overrides };
  const directory = await operations.mkdtemp(join(tmpdir(), 'hanpan-built-server-'));
  let outcome:
    { readonly ok: true; readonly value: Result } | { readonly ok: false; readonly error: unknown };
  let removalFailure: { readonly error: unknown } | undefined;
  try {
    await operations.cp(resolve(packageRoot, 'dist'), directory, { recursive: true });
    const dependencies = join(directory, 'node_modules/@dimforge');
    await operations.mkdir(dependencies, { recursive: true });
    await operations.cp(
      dirname(
        fileURLToPath(
          import.meta.resolve('@dimforge/rapier3d-deterministic/rapier_wasm3d_bg.wasm'),
        ),
      ),
      join(dependencies, 'rapier3d-deterministic'),
      { recursive: true },
    );
    outcome = { ok: true, value: await run(directory) };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    try {
      await operations.rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      removalFailure = { error: cleanupError };
    }
  }
  if (!outcome.ok) {
    if (removalFailure !== undefined)
      console.error('Built server artifact removal failed:', removalFailure.error);
    throw outcome.error;
  }
  if (removalFailure !== undefined) throw removalFailure.error;
  return outcome.value;
}
