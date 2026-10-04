import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ASSET_SOURCE_CATALOG } from '../src/source-catalog.ts';
import { CHARACTER_CATALOG } from '../src/characters.ts';
import { GAME_ASSET_MANIFEST } from '../src/manifest.generated.ts';
import { buildManifest, PACKAGE_ROOT, syncPublic, verifySourceAssets } from './asset-pipeline.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('asset pipeline', () => {
  test('generated manifest exactly matches source bytes', async () => {
    expect(await buildManifest()).toEqual(GAME_ASSET_MANIFEST);
    expect((await verifySourceAssets()).errors).toEqual([]);
  });

  test('ignores Finder metadata while still rejecting unregistered assets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hanpan-asset-metadata-'));
    temporaryDirectories.push(root);
    await cp(path.join(PACKAGE_ROOT, 'files'), path.join(root, 'files'), { recursive: true });
    const nestedDirectory = path.dirname(ASSET_SOURCE_CATALOG[0].sourcePath);
    await writeFile(path.join(root, 'files/.DS_Store'), 'Finder metadata');
    await writeFile(path.join(root, nestedDirectory, '.DS_Store'), 'Finder metadata');

    expect((await verifySourceAssets({ root })).errors).toEqual([]);

    await writeFile(path.join(root, nestedDirectory, 'unregistered.svg'), '<svg/>');
    expect((await verifySourceAssets({ root })).errors).toEqual([
      `orphaned asset file: ${nestedDirectory}/unregistered.svg`,
    ]);
  });

  test('catalog has unique IDs and covers every shipped source', () => {
    expect(new Set(ASSET_SOURCE_CATALOG.map(({ id }) => id)).size).toBe(
      ASSET_SOURCE_CATALOG.length,
    );
    expect(
      GAME_ASSET_MANIFEST.every(({ url }) =>
        /^\/assets\/game\/.+\/[0-9a-f]{64}\.[a-z0-9]+$/u.test(url),
      ),
    ).toBe(true);
    expect(
      ['files/fonts', 'files/models', 'files/textures'].some((directory) => existsSync(directory)),
    ).toBe(false);
    expect(
      CHARACTER_CATALOG.every(({ imageAssetIds }) =>
        Object.values(imageAssetIds).every((id) =>
          GAME_ASSET_MANIFEST.some((asset) => asset.id === id),
        ),
      ),
    ).toBe(true);
  });

  test('keeps the wrapper pattern within its runtime tile and byte budget', () => {
    const wrapperPattern = GAME_ASSET_MANIFEST.find(({ id }) => id === 'brand.wrapper-pattern');
    expect(wrapperPattern).toMatchObject({
      width: 512,
      height: 512,
      mime: 'image/png',
    });
    expect(wrapperPattern?.bytes).toBeLessThanOrEqual(320 * 1024);
  });

  test('ships the three scene BGM tracks as production MP3 assets', () => {
    expect(
      GAME_ASSET_MANIFEST.filter(({ id }) => id.startsWith('audio.bgm.')).map(({ id, mime }) => ({
        id,
        mime,
      })),
    ).toEqual([
      { id: 'audio.bgm.game', mime: 'audio/mpeg' },
      { id: 'audio.bgm.lobby', mime: 'audio/mpeg' },
      { id: 'audio.bgm.result', mime: 'audio/mpeg' },
    ]);
    expect(GAME_ASSET_MANIFEST.filter(({ kind }) => kind === 'audio').map(({ id }) => id)).toEqual([
      'audio.bgm.game',
      'audio.bgm.lobby',
      'audio.bgm.result',
    ]);
  });

  test('sync owns only the assets/game namespace and preserves file bytes', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'hanpan-assets-'));
    temporaryDirectories.push(target);
    const page = path.join(target, 'index.html');
    const font = path.join(target, 'assets/fonts/product.woff2');
    const staleAsset = path.join(target, 'assets/game/stale.svg');
    const pageBytes = Buffer.from('<main>preserved page</main>');
    const fontBytes = Buffer.from([0, 1, 2, 255]);
    await mkdir(path.dirname(font), { recursive: true });
    await mkdir(path.dirname(staleAsset), { recursive: true });
    await writeFile(page, pageBytes);
    await writeFile(font, fontBytes);
    await writeFile(staleAsset, '<svg>stale asset</svg>');

    expect(await syncPublic(target)).toBe(GAME_ASSET_MANIFEST.length);
    expect(await readFile(page)).toEqual(pageBytes);
    expect(await readFile(font)).toEqual(fontBytes);
    expect(existsSync(staleAsset)).toBe(false);
    for (const entry of GAME_ASSET_MANIFEST) {
      const copied = await readFile(path.join(target, entry.url));
      expect(copied.length).toBe(entry.bytes);
      expect(createHash('sha256').update(copied).digest('hex')).toBe(entry.sha256);
    }
  });

  test('rejects stale manifest before replacing the existing public assets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hanpan-asset-source-'));
    temporaryDirectories.push(root);
    await cp(path.join(PACKAGE_ROOT, 'files'), path.join(root, 'files'), { recursive: true });
    const target = path.join(root, 'public');
    await syncPublic(target, root);
    const source = ASSET_SOURCE_CATALOG.find(({ id }) => id === 'score.ones');
    const entry = GAME_ASSET_MANIFEST.find(({ id }) => id === source.id);
    const previous = await readFile(path.join(target, entry.url));
    await appendFile(path.join(root, source.sourcePath), '\n<!-- updated source -->\n');

    await expect(syncPublic(target, root)).rejects.toThrow('generated manifest is stale');
    expect(await readFile(path.join(target, entry.url))).toEqual(previous);
  });
});
