/** Logical product dimensions; independent of viewport scale and simulation world units. */
export const DICE_BOARD_LAYOUT = Object.freeze({
  width: 340,
  height: 204,
  left: 10,
  top: 42,
  rackHeight: 72,
  settledHeight: 66,
  railHeight: 66,
  borderInset: 4,
  cornerRadius: 12,
});

// Installed on the persistent logical frame so the board and sibling Canvas share it.
export const DICE_BOARD_CSS = Object.freeze({
  '--dice-board-width': `${DICE_BOARD_LAYOUT.width}px`,
  '--dice-board-height': `${DICE_BOARD_LAYOUT.height}px`,
  '--dice-board-left': `${DICE_BOARD_LAYOUT.left}px`,
  '--dice-board-top': `${DICE_BOARD_LAYOUT.top}px`,
  '--dice-rack-height': `${DICE_BOARD_LAYOUT.rackHeight}px`,
  '--dice-settled-height': `${DICE_BOARD_LAYOUT.settledHeight}px`,
  '--dice-rail-height': `${DICE_BOARD_LAYOUT.railHeight}px`,
  '--dice-board-radius': `${DICE_BOARD_LAYOUT.cornerRadius}px`,
});
