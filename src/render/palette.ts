/**
 * The board's colour, in one place.
 *
 * The palette is risograph: chalky, high-lightness inks laid on paper. That is
 * not decoration — a riso print makes new colour by overprinting two inks, which
 * is the same move the game makes when two tiles fuse. So the tiles are inks,
 * and the ramp walks the ink drawer rather than a smooth colour wheel: aqua,
 * blue, indigo, violet, orchid, fluorescent pink, red, orange, yellow.
 *
 * Hue is derived from the exponent rather than picked from a hand-written list,
 * so a 65536 tile is a natural continuation of a 2 instead of a special case
 * someone forgot to add. Inks stay pale in both themes, so one dark tint of the
 * same hue is readable on every step of the ramp; what swaps between light and
 * dark is the paper under them.
 */

export type ThemeName = 'light' | 'dark';

export interface TileColor {
  fill: string;
  edge: string;
  glow: string;
  text: string;
}

/** Wrap a hue that walked off the end of the wheel back into range. */
const wrap = (hue: number): number => ((hue % 360) + 360) % 360;

const HUE_START = 186; // aqua for a 2
const HUE_STEP = 18.5; // climbed: aqua -> violet -> fluorescent pink -> yellow

/** Where the ramp stops deepening; beyond this tiles hold their darkest wash. */
const RANK_CAP = 12;

/**
 * The active theme. The renderer draws from module state rather than being
 * handed a palette on every call, so switching themes is one assignment and
 * the next frame simply comes out in the new colours.
 */
let theme: ThemeName = 'light';

export function setPaletteTheme(next: ThemeName): void {
  theme = next;
}

export function paletteTheme(): ThemeName {
  return theme;
}

export function tileColor(value: number): TileColor {
  const exponent = Math.max(1, Math.round(Math.log2(value)));
  const hue = wrap(HUE_START + (exponent - 1) * HUE_STEP);
  const rank = Math.min(1, (exponent - 1) / RANK_CAP);

  // Saturation stays high while lightness falls: that is what separates a riso
  // ink from a dusty pastel. Dark mode lifts nothing but the floor, because a
  // fluorescent ink on a dark sheet is already doing the work.
  const light = theme === 'light';
  const saturation = (light ? 74 : 66) - rank * 6;
  const lightness = (light ? 87 : 81) - rank * 24;

  return {
    fill: `hsl(${hue} ${saturation}% ${lightness}%)`,
    edge: `hsl(${hue} ${saturation}% ${lightness - 18}%)`,
    glow: `hsl(${hue} ${saturation}% ${lightness}% / ${light ? 0.4 : 0.3})`,
    // Every ink stays pale, so one dark tint of its own hue works the ramp.
    text: `hsl(${hue} 52% 22%)`,
  };
}

/**
 * Combo colouring, from the calm ink at 1x to the alarm ink at the cap.
 *
 * It shares its endpoints with the rise meter on purpose: aqua means you have
 * room, fluorescent pink means something is about to happen to you.
 */
export function comboColor(combo: number, max: number): string {
  const t = Math.min(1, Math.max(0, (combo - 1) / Math.max(1, max - 1)));
  const lightness = theme === 'light' ? 56 - t * 4 : 70 - t * 2;
  return `hsl(${wrap(186 + t * 160)} 74% ${lightness}%)`;
}

export interface BoardPalette {
  /** An empty cell. */
  cell: string;
  /** An empty cell in the lethal top row. */
  cellDanger: string;
  /** Wash over the top row, scaled by how close the next rise is. */
  danger: (alpha: number) => string;
  /** Outline behind floating score text, so it stays legible on any tile. */
  floaterOutline: string;
  /** Rise timer track. */
  track: string;
  /** Aqua while there is room, fluorescent pink when a rise is imminent. */
  pressure: (urgency: number) => string;
  /** Charge meter: solid once a vent is actually available. */
  chargeFull: string;
  chargeIdle: string;
  /** Full-screen flashes. */
  crushFlash: string;
  ventFlash: string;
  /** Shockwave sweeps. */
  riseRipple: string;
  ventRipple: string;
}

const LIGHT: BoardPalette = {
  cell: 'rgba(34, 33, 43, 0.055)',
  cellDanger: 'rgba(255, 95, 162, 0.13)',
  danger: (alpha) => `rgba(255, 95, 162, ${alpha})`,
  floaterOutline: 'rgba(255, 255, 255, 0.95)',
  track: 'rgba(34, 33, 43, 0.12)',
  pressure: (urgency) => `hsl(${wrap(186 + urgency * 160)} 72% ${58 - urgency * 4}%)`,
  chargeFull: '#3fbfa6',
  chargeIdle: 'rgba(63, 191, 166, 0.32)',
  crushFlash: '#ff5fa2',
  ventFlash: '#6fd9ce',
  riseRipple: 'hsl(336 90% 68% / 0.5)',
  ventRipple: 'hsl(178 62% 58% / 0.7)',
};

const DARK: BoardPalette = {
  cell: 'rgba(255, 255, 255, 0.055)',
  cellDanger: 'rgba(255, 120, 176, 0.14)',
  danger: (alpha) => `rgba(255, 120, 176, ${alpha})`,
  // The sheet behind a floater is dark here, so the halo has to be too.
  floaterOutline: 'rgba(19, 18, 26, 0.88)',
  track: 'rgba(255, 255, 255, 0.1)',
  pressure: (urgency) => `hsl(${wrap(186 + urgency * 160)} 68% ${70 - urgency * 4}%)`,
  chargeFull: '#63d6bd',
  chargeIdle: 'rgba(99, 214, 189, 0.3)',
  crushFlash: '#ff78b0',
  ventFlash: '#8fe6dc',
  riseRipple: 'hsl(336 88% 76% / 0.5)',
  ventRipple: 'hsl(178 58% 72% / 0.7)',
};

/**
 * Everything the renderer paints that is not a tile.
 *
 * Kept here so the board's palette is one file rather than a dozen literals
 * scattered through the draw calls.
 */
export function board(): BoardPalette {
  return theme === 'light' ? LIGHT : DARK;
}

/** The face the board draws its numbers in. Must match what index.html loads. */
export const BOARD_FONT = '"Archivo", "Segoe UI", system-ui, sans-serif';
