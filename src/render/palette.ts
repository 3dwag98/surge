/**
 * The board's colour, in one place.
 *
 * The well is light now, so everything here is tuned for dark-on-pale rather
 * than neon-on-black: tiles carry the saturation and the board stays quiet
 * behind them.
 *
 * Tile hue is derived from the exponent rather than picked from a hand-written
 * list, so a 65536 tile looks like a natural continuation of a 2 instead of a
 * special case someone forgot to add. The walk runs *down* the wheel — fresh
 * green, through citrus, into coral and pink — so a bigger tile reads as hotter
 * without ever landing on a muddy colour.
 */

export interface TileColor {
  fill: string;
  edge: string;
  glow: string;
  text: string;
}

const HUE_START = 158; // fresh green for a 2
const HUE_STEP = 22; // walked downward, so 2 -> 4 -> 8 warms up

/** Where the ramp stops getting lighter; beyond this tiles are fully saturated. */
const RANK_CAP = 11;

export function tileColor(value: number): TileColor {
  const exponent = Math.max(1, Math.round(Math.log2(value)));
  // Subtracting can go negative, so wrap into range the long way round.
  const hue = (((HUE_START - (exponent - 1) * HUE_STEP) % 360) + 360) % 360;

  const rank = Math.min(1, (exponent - 1) / RANK_CAP);
  // Small tiles are pale and calm; big ones are dense and loud.
  const saturation = 62 + rank * 30;
  const lightness = 78 - rank * 26;

  return {
    fill: `hsl(${hue} ${saturation}% ${lightness}%)`,
    edge: `hsl(${hue} ${saturation}% ${Math.max(30, lightness - 14)}%)`,
    glow: `hsl(${hue} 92% ${Math.min(72, lightness + 8)}% / 0.5)`,
    // Pale tiles need dark text; saturated ones need white.
    text: lightness > 60 ? `hsl(${hue} 62% 20%)` : '#ffffff',
  };
}

/** Combo colouring, from calm green at 1x to hot pink at the cap. */
export function comboColor(combo: number, max: number): string {
  const t = Math.min(1, Math.max(0, (combo - 1) / Math.max(1, max - 1)));
  const hue = 158 - t * 180; // green -> citrus -> coral -> pink
  return `hsl(${((hue % 360) + 360) % 360} 88% ${52 - t * 6}%)`;
}

/**
 * Everything the renderer paints that is not a tile.
 *
 * Kept here so the board's palette is one file rather than a dozen literals
 * scattered through the draw calls.
 */
export const BOARD = {
  /** The well behind the cells. */
  well: 'rgba(255, 255, 255, 0.62)',
  /** An empty cell. */
  cell: 'rgba(16, 94, 74, 0.07)',
  /** An empty cell in the lethal top row. */
  cellDanger: 'rgba(255, 122, 89, 0.11)',
  /** Wash over the top row, scaled by how close the next rise is. */
  danger: (alpha: number) => `rgba(255, 122, 89, ${alpha})`,

  /** Outline behind floating score text, so it stays legible on any tile. */
  floaterOutline: 'rgba(255, 255, 255, 0.94)',

  /** Rise timer track and fill. */
  track: 'rgba(16, 94, 74, 0.12)',
  /** Green when there is time, coral when a rise is imminent. */
  pressure: (urgency: number) => `hsl(${158 - urgency * 148} 82% ${46 + urgency * 6}%)`,

  /** Charge meter: solid once a vent is actually available. */
  chargeFull: '#0fbf85',
  chargeIdle: 'rgba(15, 191, 133, 0.38)',

  /** Full-screen flashes. */
  crushFlash: '#ff7a59',
  ventFlash: '#0fd9a3',

  /** Shockwave sweeps. */
  riseRipple: 'hsl(14 92% 62% / 0.5)',
  ventRipple: 'hsl(162 90% 46% / 0.7)',
} as const;

/** The face the board draws its numbers in. Must match what index.html loads. */
export const BOARD_FONT = '"Inter", "Segoe UI", system-ui, sans-serif';
