/**
 * Tile colouring.
 *
 * Rather than a hand-picked list that runs out, hue is derived from the tile's
 * exponent and walks the spectrum, so a 65536 tile looks like a natural
 * continuation of a 2 rather than a special case someone forgot to add.
 */

export interface TileColor {
  fill: string;
  edge: string;
  glow: string;
  text: string;
}

const HUE_START = 186; // cyan for a 2
const HUE_STEP = 26;

export function tileColor(value: number): TileColor {
  const exponent = Math.max(1, Math.round(Math.log2(value)));
  const hue = (HUE_START + (exponent - 1) * HUE_STEP) % 360;

  // Bigger tiles read as hotter: more saturated, slightly brighter.
  const rank = Math.min(1, (exponent - 1) / 11);
  const saturation = 68 + rank * 24;
  const lightness = 52 + rank * 8;

  return {
    fill: `hsl(${hue} ${saturation}% ${lightness}%)`,
    edge: `hsl(${hue} ${saturation}% ${Math.min(92, lightness + 22)}%)`,
    glow: `hsl(${hue} 100% ${Math.min(80, lightness + 12)}% / 0.55)`,
    // Light tiles need dark text to stay legible.
    text: lightness > 62 ? `hsl(${hue} 60% 12%)` : '#f7feff',
  };
}

/** Combo colouring, from cool at 1x to hot at the cap. */
export function comboColor(combo: number, max: number): string {
  const t = Math.min(1, Math.max(0, (combo - 1) / Math.max(1, max - 1)));
  const hue = 186 - t * 186; // cyan -> red
  return `hsl(${hue} 100% ${58 + t * 8}%)`;
}
