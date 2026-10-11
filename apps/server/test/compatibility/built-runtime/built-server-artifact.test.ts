import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, spyOn, test } from 'bun:test';

import { withBuiltServerArtifact } from './built-server-artifact';

test.each(['dist copy', 'dependency mkdir', 'dependency copy', 'spawn', 'callback'] as const)(
  'removes the acquired artifact and preserves the original %s failure',
  async (fault) => {
    const root = await mkdtemp(join(tmpdir(), 'hanpan-artifact-test-'));
    const packageRoot = join(root, 'package');
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await writeFile(join(packageRoot, 'dist/main.js'), 'console.log("fixture")');
    const failure = new Error(fault);
    let directory: string | undefined;
    let copies = 0;
    let ran = false;
    let spawnFailure: unknown;
    try {
      const execution = withBuiltServerArtifact(
        packageRoot,
        () => {
          ran = true;
          if (fault === 'spawn') {
            try {
              Bun.spawn(['missing-built-server-executable'], { cwd: directory });
            } catch (error) {
              spawnFailure = error;
              throw error;
            }
          }
          throw failure;
        },
        {
          mkdtemp: async () => {
            directory = await mkdtemp(join(root, 'artifact-'));
            return directory;
          },
          cp: async (source, destination, options) => {
            copies += 1;
            if (
              (fault === 'dist copy' && copies === 1) ||
              (fault === 'dependency copy' && copies === 2)
            )
              throw failure;
            await cp(source, destination, options);
          },
          mkdir: async (path, options) => {
            if (fault === 'dependency mkdir') throw failure;
            return mkdir(path, options);
          },
        },
      );
      let caught: unknown;
      try {
        await execution;
      } catch (error) {
        caught = error;
      }
      if (fault === 'spawn') {
        expect(spawnFailure).toBeInstanceOf(Error);
        expect(caught).toBe(spawnFailure);
      } else expect(caught).toBe(failure);
      expect(ran).toBe(fault === 'spawn' || fault === 'callback');
      expect(directory).toBeDefined();
      expect(await readdir(root)).toEqual(['package']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('keeps only built files and runtime dependencies until the callback child has exited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hanpan-artifact-test-'));
  const packageRoot = join(root, 'package');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await mkdir(join(packageRoot, 'src'));
  await mkdir(join(packageRoot, '.git'));
  await writeFile(join(packageRoot, 'release.json'), '{}');
  await writeFile(join(packageRoot, 'dist/main.js'), 'process.exit(0)');
  let directory: string | undefined;
  try {
    const result = await withBuiltServerArtifact(
      packageRoot,
      async (artifact) => {
        expect((await readdir(artifact)).sort()).toEqual(['main.js', 'node_modules']);
        const child = Bun.spawn([process.execPath, 'main.js'], { cwd: artifact });
        expect(await child.exited).toBe(0);
        return 'exited';
      },
      {
        mkdtemp: async () => {
          directory = await mkdtemp(join(root, 'artifact-'));
          return directory;
        },
      },
    );
    expect(result).toBe('exited');
    expect(directory).toBeDefined();
    expect(await readdir(root)).toEqual(['package']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  'reports removal failure without replacing an existing callback failure (%s)',
  async (callbackFails) => {
    const root = await mkdtemp(join(tmpdir(), 'hanpan-artifact-test-'));
    const packageRoot = join(root, 'package');
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    const primary = new Error('callback failure');
    const removal = new Error('removal failure');
    const report = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let caught: unknown;
      try {
        await withBuiltServerArtifact(
          packageRoot,
          () => {
            if (callbackFails) throw primary;
          },
          {
            mkdtemp: () => mkdtemp(join(root, 'artifact-')),
            rm: async () => {
              throw removal;
            },
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(callbackFails ? primary : removal);
      if (callbackFails)
        expect(report).toHaveBeenCalledWith('Built server artifact removal failed:', removal);
      else expect(report).not.toHaveBeenCalled();
    } finally {
      report.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);
