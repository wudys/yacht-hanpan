import { expect, type Locator, type Page } from '@playwright/test';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { createSocketPacketObserver } from '../helpers/socket-packets';
import { test } from '../helpers/test';

for (const locale of ['ko', 'en'] as const) {
  test(`real command pending and opponent presence retain the authoritative Game in ${locale}`, async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(90_000);
    let rollGate = deferred();
    const scoreGate = deferred();
    let rollReached = deferred();
    const scoreReached = deferred();
    let rollCommandCount = 0;
    let scoreCommandCount = 0;
    let observingScorePending = false;

    await page.routeWebSocket(/\/game-socket\//u, (socket) => {
      const server = socket.connectToServer();
      const packets = createSocketPacketObserver();
      socket.onClose((code, reason) => {
        packets.dispose();
        void server.close({ code, reason });
      });
      server.onClose((code, reason) => {
        packets.dispose();
        void socket.close({ code, reason });
      });
      server.onMessage((message) => {
        packets.observeServer(message);
        socket.send(message);
      });
      socket.onMessage((message) => {
        const request = packets.observeClient(message);
        if (request?.kind === 'command') {
          const { command } = request;
          if (command.type === 'rollDice') {
            rollCommandCount += 1;
            rollReached.resolve();
            void rollGate.promise.then(() => server.send(message));
            return;
          }
          if (command.type === 'selectScoreCategory') {
            scoreCommandCount += 1;
            if (observingScorePending) {
              scoreReached.resolve();
              void scoreGate.promise.then(() => server.send(message));
              return;
            }
          }
        }
        server.send(message);
      });
    });

    await page.setViewportSize({ width: 320, height: 568 });
    await page.addInitScript((value) => localStorage.setItem('locale', value), locale);
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page
      .getByRole('button', { name: locale === 'ko' ? '게임 시작' : 'Start Game', exact: true })
      .click();
    const guestContext = await joinProductGame(page, browser, {
      locale,
      viewport: { width: 320, height: 568 },
    });
    let creatorOffline = false;

    try {
      const guest = guestContext.pages()[0]!;
      const rollAction = page.locator('.roll-action-rail .ui-button');
      const rollProgress = rollAction.locator('.ui-button__progress');
      const presentation = page.locator('[data-dice-presentation-phase]');
      const rollLabels = locale === 'ko' ? ['굴리기', '다시 굴리기'] : ['Roll', 'Roll again'];
      for (const rollNumber of [1, 2]) {
        if (rollNumber === 2) {
          rollGate = deferred();
          rollReached = deferred();
        }
        const rollLabel = rollLabels[rollNumber - 1]!;
        await page.mouse.move(0, 0);
        const idleFilter = await visualFeedback(rollAction, 'filter');
        await rollAction.hover();
        await page.mouse.down();
        const pressedFilter = await visualFeedback(rollAction, 'filter');
        expect(brightness(pressedFilter)).toBeLessThan(brightness(idleFilter));
        await page.mouse.move(0, 0);
        await page.mouse.up();
        await expect(rollAction).toHaveCSS('filter', idleFilter);
        expect(rollCommandCount).toBe(rollNumber - 1);
        const idleRollBounds = await rollAction.boundingBox();
        const idleSurfaceShadow = await rollAction.evaluate(
          (button) => getComputedStyle(button, '::before').boxShadow,
        );
        expect(idleRollBounds).not.toBeNull();
        await rollAction.click();
        await rollReached.promise;
        await expect(rollAction).toHaveAttribute('aria-disabled', 'true');
        await expect(rollAction.locator('.ui-button__label')).toHaveText(rollLabel);
        const feedbackAtFirstPaint = await rollAction.evaluate(
          (button) =>
            new Promise<{ busy: boolean; shadow: string; spinnerVisible: boolean }>((resolve) => {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  const progress = button.querySelector('.ui-button__progress');
                  resolve({
                    busy: button.getAttribute('aria-busy') === 'true',
                    shadow: getComputedStyle(button, '::before').boxShadow,
                    spinnerVisible: progress !== null && progress.checkVisibility(),
                  });
                }),
              );
            }),
        );
        expect(feedbackAtFirstPaint.busy).toBe(true);
        expect(feedbackAtFirstPaint.shadow).not.toBe(idleSurfaceShadow);
        expect(feedbackAtFirstPaint.spinnerVisible).toBe(false);
        await expect(rollAction).toHaveAttribute('aria-busy', 'true');
        await expect(rollAction).toHaveAccessibleName(rollLabel);
        await page.screenshot({
          path: `/tmp/hanpan-roll-pending-immediate-${locale}-${rollNumber}-320-${testInfo.project.name}.png`,
        });
        await expect(rollProgress).toBeVisible();
        await expect(rollProgress).toHaveAttribute('aria-hidden', 'true');
        expect(
          await rollProgress.locator('[role="progressbar"]').evaluate((spinner) => {
            const bounds = spinner.getBoundingClientRect();
            return spinner.contains(
              document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
            );
          }),
        ).toBe(true);
        const labelBounds = await rollAction.locator('.ui-button__label').boundingBox();
        const progressBounds = await rollProgress.boundingBox();
        expect(labelBounds).not.toBeNull();
        expect(progressBounds).not.toBeNull();
        expect(progressBounds!.x + progressBounds!.width).toBeLessThan(labelBounds!.x);
        await page.screenshot({
          path: `/tmp/hanpan-roll-pending-spinner-${locale}-${rollNumber}-320-${testInfo.project.name}.png`,
        });
        const rollBounds = await rollAction.boundingBox();
        expect(rollBounds).not.toBeNull();
        expect(rollBounds!.x).toBeCloseTo(idleRollBounds!.x, 1);
        expect(rollBounds!.y).toBeCloseTo(idleRollBounds!.y, 1);
        expect(rollBounds!.width).toBeCloseTo(idleRollBounds!.width, 1);
        expect(rollBounds!.height).toBeCloseTo(idleRollBounds!.height, 1);
        await expect(rollAction).toHaveCSS('cursor', 'pointer');
        await expect(rollAction).toHaveCSS('filter', pressedFilter);
        await expectLockedPointerFeedback(page, pressedFilter);
        await page.mouse.click(
          rollBounds!.x + rollBounds!.width / 2,
          rollBounds!.y + rollBounds!.height / 2,
        );
        await nextPaint(page);
        expect(rollCommandCount).toBe(rollNumber);

        rollGate.resolve();
        await expect(presentation).toHaveAttribute('data-dice-presentation-phase', 'rolling');
        await expect(presentation).toHaveAttribute('data-dice-presentation-phase', 'settled');
        await expect(rollAction).not.toHaveAttribute('aria-busy', 'true');
      }

      // Only the final score command is gated. Prepare both value states through real turns first.
      await page.locator('[data-score-tab="upper"]').click();
      const firstScore = page.locator('button[data-score-category="ones"]');
      await expect(firstScore).toHaveAttribute('data-value-state', 'preview');
      await firstScore.click();
      await expect(guest.locator('[data-product-view="game"]')).toHaveAttribute(
        'data-viewer-turn',
        'true',
      );
      await guest.getByRole('button', { name: rollLabels[0], exact: true }).click();
      await expect(guest.locator('[data-dice-presentation-phase]')).toHaveAttribute(
        'data-dice-presentation-phase',
        'settled',
      );
      await guest.locator('[data-score-tab="upper"]').click();
      await guest.locator('button[data-score-category="ones"]').click();
      await expect(page.locator('[data-product-view="game"]')).toHaveAttribute(
        'data-viewer-turn',
        'true',
      );
      await page.getByRole('button', { name: rollLabels[0], exact: true }).click();
      await expect(presentation).toHaveAttribute('data-dice-presentation-phase', 'settled');
      await page.locator('[data-settled-slot="0"]').click();
      await expect(page.locator('[data-held-slot="0"]')).toHaveAttribute('aria-pressed', 'true');
      await page.locator('[data-score-tab="upper"]').click();
      await expect(page.locator('[data-player-summary]')).toHaveAttribute(
        'data-player-summary',
        'viewer',
      );
      await expect(page.locator('[data-score-grid]')).toHaveAttribute('data-mode', 'viewer-turn');
      const recorded = page.locator('button[data-score-category="ones"]');
      await expect(recorded).toHaveAttribute('data-value-state', 'recorded');
      const score = page.locator('button[data-score-category][data-value-state="preview"]').first();
      await expect(score).toBeEnabled();
      const category = await score.getAttribute('data-score-category');
      const preview = await score.locator('[data-score-value-kind="preview"]').textContent();
      const idleScoreBounds = await score.boundingBox();
      expect(category).not.toBeNull();
      expect(preview).toMatch(/^\d+$/u);
      expect(idleScoreBounds).not.toBeNull();
      await page.mouse.move(0, 0);
      const beforeStyles = await scoreValueStyles(page);
      const recordedStyle = beforeStyles.find(({ kind }) => kind === 'recorded');
      const previewStyle = beforeStyles.find(({ kind }) => kind === 'preview');
      expect(recordedStyle).toBeDefined();
      expect(previewStyle).toBeDefined();
      expect(Number(recordedStyle!.weight)).toBeGreaterThan(Number(previewStyle!.weight));
      expect(recordedStyle!.size).toBe(previewStyle!.size);
      expect(recordedStyle!.color).not.toBe(previewStyle!.color);
      expect(recordedStyle!.surface).toBe(previewStyle!.surface);
      expect(beforeStyles.every(({ opacity }) => opacity === '1')).toBe(true);
      observingScorePending = true;

      await score.click();
      await scoreReached.promise;
      await expect(score).toHaveAttribute('aria-disabled', 'true');
      await expect(score).toHaveAttribute('data-value-state', 'preview');
      await expect(score.locator('[data-score-value-kind="preview"]')).toHaveText(preview!);
      await expect(recorded).toHaveCSS('cursor', 'default');
      await expect(score).toHaveCSS('cursor', 'pointer');
      await expect.poll(() => scoreValueStyles(page)).toEqual(beforeStyles);
      await expectLockedPointerFeedback(page);
      expect(await scoreValueStyles(page)).toEqual(beforeStyles);
      await expect(page.locator('[data-player-summary]')).toHaveAttribute(
        'data-player-summary',
        'viewer',
      );
      const scoreBounds = await score.boundingBox();
      expect(scoreBounds).not.toBeNull();
      expect(scoreBounds!.x).toBeCloseTo(idleScoreBounds!.x, 1);
      expect(scoreBounds!.y).toBeCloseTo(idleScoreBounds!.y, 1);
      expect(scoreBounds!.width).toBeCloseTo(idleScoreBounds!.width, 1);
      expect(scoreBounds!.height).toBeCloseTo(idleScoreBounds!.height, 1);
      await page.screenshot({
        path: `/tmp/hanpan-score-pending-${locale}-320-${testInfo.project.name}.png`,
      });
      await page.mouse.click(
        scoreBounds!.x + scoreBounds!.width / 2,
        scoreBounds!.y + scoreBounds!.height / 2,
      );
      await nextPaint(page);
      expect(scoreCommandCount).toBe(2);

      scoreGate.resolve();
      await expect(guest.locator('[data-product-view="game"]')).toHaveAttribute(
        'data-viewer-turn',
        'true',
      );
      await page
        .getByRole('button', { name: locale === 'ko' ? '점수판' : 'Scoreboard', exact: true })
        .click();
      await expect(
        page.locator(`[data-score-table] tr[data-score-category="${category}"] td`).first(),
      ).toHaveText(preview!);
      await page
        .getByRole('button', { name: locale === 'ko' ? '닫기' : 'Close', exact: true })
        .click();

      creatorOffline = true;
      await page.context().setOffline(true);
      const presence = guest.locator('.game-board__presence');
      await expect(presence).toHaveText(/.+/u);
      await expect(presence).toHaveAttribute('role', 'status');
      const disconnectedPresence = await presence.textContent();
      expect(disconnectedPresence).not.toBeNull();
      await guest.screenshot({
        path: `/tmp/hanpan-presence-disconnected-${locale}-320-${testInfo.project.name}.png`,
      });

      await page.context().setOffline(false);
      creatorOffline = false;
      await expect
        .poll(async () => {
          const current = await presence.textContent();
          return current !== null && current !== '' && current !== disconnectedPresence;
        })
        .toBe(true);
      await guest.screenshot({
        path: `/tmp/hanpan-presence-reconnected-${locale}-320-${testInfo.project.name}.png`,
      });
      await expect(presence).toHaveText('');
    } finally {
      rollGate.resolve();
      scoreGate.resolve();
      if (creatorOffline) await page.context().setOffline(false);
      await guestContext.close();
    }
  });
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolveDeferred!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

async function scoreValueStyles(page: Page) {
  return page.locator('[data-score-grid] [data-score-value-kind]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const css = getComputedStyle(node);
      return {
        category: node.closest('[data-score-category]')?.getAttribute('data-score-category'),
        kind: node.getAttribute('data-score-value-kind'),
        value: node.textContent,
        color: css.color,
        surface: css.backgroundColor,
        weight: css.fontWeight,
        size: css.fontSize,
        opacity: css.opacity,
      };
    }),
  );
}

async function expectLockedPointerFeedback(page: Page, pressedRollFilter?: string): Promise<void> {
  const locked = page.locator('[data-interaction-locked="true"]');
  expect(await locked.count()).toBeGreaterThan(0);
  for (const control of await locked.all()) {
    // A busy roll keeps its deliberate pressed feedback even after the pointer leaves.
    const busyRoll = await control.evaluate((node) =>
      node.matches('.roll-action-rail .ui-button[aria-busy="true"]'),
    );
    if (busyRoll) expect(pressedRollFilter).toBeDefined();
    const expectedFilter = busyRoll ? pressedRollFilter! : 'none';
    const surface =
      (await control.getAttribute('data-score-cell')) === 'true'
        ? control.locator('[data-score-value-kind]')
        : control;
    const idleSurface = await visualFeedback(surface, 'background-color');
    const idleBackground = await visualFeedback(control, 'background-color');
    await expect(control).toHaveCSS('cursor', 'pointer');
    await page.mouse.move(0, 0);
    await expect(control).toHaveCSS('filter', expectedFilter);
    await control.hover();
    await expect(control).toHaveCSS('filter', expectedFilter);
    expect(await visualFeedback(control, 'background-color')).toBe(idleBackground);
    expect(await visualFeedback(surface, 'background-color')).toBe(idleSurface);
  }
}

function brightness(filter: string): number {
  if (filter === 'none') return 1;
  const match = /^brightness\(([\d.]+)\)$/u.exec(filter);
  expect(match, `Expected a brightness filter, got ${filter}`).not.toBeNull();
  const value = Number(match![1]);
  expect(Number.isFinite(value)).toBe(true);
  return value;
}

async function visualFeedback(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(async (node, cssProperty) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {})));
    return getComputedStyle(node).getPropertyValue(cssProperty);
  }, property);
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}
