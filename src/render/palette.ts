/**
 * The board's colour, in one place.
 *
 * Everything is pastel: tiles are soft, high-lightness washes with dark text,
 * so the board reads as calm even when it is full. That holds in both themes —
 * the tiles barely change between light and dark, and what swaps underneath
 * them is the well, the grid and the meters.
 *
 * Tile hue is derived from the exponent rather than picked from a hand-written
 * list, so a 65536 tile looks like a natural continuation of a 2 instead of a
 * special case someone forgot to add. The walk climbs the wheel from sky blue
 * through periwinkle, orchid and rose into peach, which keeps every step on a
 * colour that survives being made pastel — the yellow-green stretch does not,
 * so the ramp is routed around it.
 */

export type ThemeName = 'light' | 'dark';

export interface TileColor {
  fill: string;
  edge: string;
  glow: string;
  text: string;
}

/** Wrap a hue that walked off the bottom of the wheel back into range. */
const wrap = (hue: number): number => ((hue % 360) + 360) % 360;

const HUE_START = 200; // sky blue for a 2
const HUE_STEP = 17.5; // climbed, so 2 -> 4 -> 8 walks toward rose and peach

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

  // Small tiles are barely tinted; big ones deepen without ever going dark
  // enough to need white text. Dark mode pulls a little saturation out so the
  // tiles glow rather than shout against the near-black well.
  const light = theme === 'light';
  const saturation = (light ? 70 : 58) - rank * 6;
  const lightness = (light ? 88 : 82) - rank * 22;

  return {
    fill: `hsl(${hue} ${saturation}% ${lightness}%)`,
    edge: `hsl(${hue} ${saturation}% ${lightness - 14}%)`,
    glow: `hsl(${hue} ${saturation + 14}% ${lightness}% / ${light ? 0.45 : 0.34})`,
    // Every tile stays pale, so one dark ink works the whole ramp.
    text: `hsl(${hue} 42% 24%)`,
  };
}

/** Combo colouring, from calm mint at 1x to hot rose at the cap. */
export function comboColor(combo: number, max: number): string {
  const t = Math.min(1, Math.max(0, (combo - 1) / Math.max(1, max - 1)));
  const hue = 168 - t * 190; // mint -> lilac (wrapping) -> rose
  const lightness = theme === 'light' ? 58 - t * 6 : 70 - t * 4;
  return `hsl(${wrap(hue)} 72% ${lightness}%)`;
}

export interface BoardPalette {
  /** The well behind the cells. */
  well: string;
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
  /** Mint when there is time, rose when a rise is imminent. */
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
  well: 'rgba(255, 255, 255, 0.7)',
  cell: 'rgba(84, 74, 122, 0.07)',
  cellDanger: 'rgba(232, 122, 148, 0.12)',
  danger: (alpha) => `rgba(232, 122, 148, ${alpha})`,
  floaterOutline: 'rgba(255, 255, 255, 0.94)',
  track: 'rgba(84, 74, 122, 0.13)',
  pressure: (urgency) => `hsl(${wrap(168 - urgency * 190)} 68% ${62 - urgency * 4}%)`,
  chargeFull: '#5fc9a8',
  chargeIdle: 'rgba(95, 201, 168, 0.34)',
  crushFlash: '#f2a0b6',
  ventFlash: '#8fe0c6',
  riseRipple: 'hsl(342 78% 70% / 0.5)',
  ventRipple: 'hsl(162 66% 62% / 0.7)',
};

const DARK: BoardPalette = {
  well: 'rgba(255, 255, 255, 0.045)',
  cell: 'rgba(255, 255, 255, 0.055)',
  cellDanger: 'rgba(240, 150, 176, 0.12)',
  danger: (alpha) => `rgba(240, 150, 176, ${alpha})`,
  // The board behind a floater is dark here, so the halo has to be too.
  floaterOutline: 'rgba(18, 18, 32, 0.86)',
  track: 'rgba(255, 255, 255, 0.1)',
  pressure: (urgency) => `hsl(${wrap(168 - urgency * 190)} 62% ${70 - urgency * 4}%)`,
  chargeFull: '#7fdcbd',
  chargeIdle: 'rgba(127, 220, 189, 0.3)',
  crushFlash: '#f0a8bd',
  ventFlash: '#9fe8d0',
  riseRipple: 'hsl(342 74% 76% / 0.5)',
  ventRipple: 'hsl(162 62% 72% / 0.7)',
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
export const BOARD_FONT = '"Inter", "Segoe UI", system-ui, sans-serif';
