import type { Locator, Page } from '@playwright/test';

/** Inspect text only: image/decorative boxes do not count as rendered lines. */
export async function visibleTextIssues(
  locator: Locator,
  neighborSelector: string = '',
  options: Readonly<{ allowWrapping?: boolean }> = {},
): Promise<string[]> {
  const observation = {
    neighbors: neighborSelector,
    allowWrapping: options.allowWrapping ?? false,
  };
  return locator.evaluate((node, { neighbors, allowWrapping }) => {
    const issues: string[] = [];
    const tolerance = 0.5; // Viewport CSS pixels, including the frame transform.
    const textRects: DOMRect[] = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      const value = text.textContent ?? '';
      if (!value.trim()) continue;
      const range = document.createRange();
      range.setStart(text, value.length - value.trimStart().length);
      range.setEnd(text, value.trimEnd().length);
      textRects.push(
        ...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0),
      );
    }
    if (textRects.length === 0) issues.push('no rendered text');
    const lines: { top: number; bottom: number }[] = [];
    for (const rect of textRects) {
      const line = lines.find(
        (candidate) => rect.top < candidate.bottom && candidate.top < rect.bottom,
      );
      if (line) {
        line.top = Math.min(line.top, rect.top);
        line.bottom = Math.max(line.bottom, rect.bottom);
      } else lines.push({ top: rect.top, bottom: rect.bottom });
    }
    if (!allowWrapping && lines.length !== 1) issues.push(`rendered ${lines.length} text lines`);
    if (node.scrollWidth > node.clientWidth + 1) issues.push('scroll width exceeds text box');
    const bounds = node.getBoundingClientRect();
    for (const rect of textRects) {
      if (rect.left < bounds.left - tolerance || rect.right > bounds.right + tolerance) {
        issues.push(
          `text exceeds element bounds: ${JSON.stringify({ text: rect.toJSON(), bounds: bounds.toJSON() })}`,
        );
      }
      // Glyphs may extend vertically beyond a tight line-height when overflow is visible;
      // the text element, clipping ancestors and frame constrain actual visible bounds.
      for (let parent: Element | null = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const clipX = style.overflowX !== 'visible';
        const clipY = style.overflowY !== 'visible';
        const frame = parent.hasAttribute('data-game-logical-canvas');
        const parentBounds = parent.getBoundingClientRect();
        if (
          ((clipX || frame) &&
            (rect.left < parentBounds.left - tolerance ||
              rect.right > parentBounds.right + tolerance)) ||
          ((clipY || frame) &&
            (rect.top < parentBounds.top - tolerance ||
              rect.bottom > parentBounds.bottom + tolerance))
        ) {
          issues.push(
            `text clipped by ${parent.className}: ${JSON.stringify({ text: rect.toJSON(), bounds: parentBounds.toJSON() })}`,
          );
        }
      }
      if (!neighbors) continue;
      for (const neighbor of document.querySelectorAll(neighbors)) {
        if (neighbor === node || node.contains(neighbor) || neighbor.contains(node)) continue;
        const other = neighbor.getBoundingClientRect();
        if (
          rect.left < other.right - tolerance &&
          other.left < rect.right - tolerance &&
          rect.top < other.bottom - tolerance &&
          other.top < rect.bottom - tolerance
        ) {
          issues.push(
            `text overlaps ${neighbor.className}: ${JSON.stringify({ text: rect.toJSON(), neighbor: other.toJSON() })}`,
          );
        }
      }
    }
    return issues;
  }, observation);
}

export async function frameFit(page: Page, locator: Locator) {
  const [frame, action] = await Promise.all([
    page.locator('[data-game-logical-canvas]').boundingBox(),
    locator.boundingBox(),
  ]);
  if (frame === null || action === null) throw new Error('Missing anchor geometry');
  return {
    inside:
      action.x >= frame.x - 0.5 &&
      action.y >= frame.y - 0.5 &&
      action.x + action.width <= frame.x + frame.width + 0.5 &&
      action.y + action.height <= frame.y + frame.height + 0.5,
    logicalHeight: action.height / (frame.width / 360),
  };
}
