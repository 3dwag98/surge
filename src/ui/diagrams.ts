/**
 * Tutorial diagrams.
 *
 * Every mechanic in Surge is a thing that *moves* — tiles sliding together, a
 * row shoving in from below, a window closing, a floor blowing out — and none
 * of that survives being written down. So each tutorial step gets a small
 * looping picture of the mechanic instead of another paragraph about it.
 *
 * These are inline SVG on the same grid the board uses, coloured from the page
 * tokens so they follow the theme, and animated in CSS rather than script so
 * `prefers-reduced-motion` switches them off for free. The unanimated state of
 * every diagram is its opening frame, so switching the motion off leaves a
 * readable still rather than a half-finished pose.
 */

const NS = 'http://www.w3.org/2000/svg';

/** Diagram grid: five columns, three rows, in the same proportions as the board. */
const CELL = 16;
const GAP = 3;
const STEP = CELL + GAP;
const COLS = 5;
const ROWS = 3;
const WIDTH = COLS * CELL + (COLS - 1) * GAP;
const HEIGHT = ROWS * CELL + (ROWS - 1) * GAP;

export type DiagramName = 'slide' | 'merge' | 'combo' | 'rise' | 'vent';

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

const x = (col: number): number => col * STEP;
const y = (row: number): number => row * STEP;

/** An empty cell of the grid. */
function slot(col: number, row: number): SVGRectElement {
  return el('rect', {
    class: 'dg-slot',
    x: x(col),
    y: y(row),
    width: CELL,
    height: CELL,
    rx: 3,
  });
}

/**
 * One tile. `value` drives the label and, through a data attribute, the ink —
 * the diagrams borrow the board's own ramp rather than inventing a palette.
 */
function tile(col: number, row: number, value: number, className = ''): SVGGElement {
  const group = el('g', { class: `dg-tile ${className}`.trim(), 'data-value': value });
  group.append(
    el('rect', { x: x(col), y: y(row), width: CELL, height: CELL, rx: 3 }),
    text(x(col) + CELL / 2, y(row) + CELL / 2, String(value)),
  );
  return group;
}

function text(cx: number, cy: number, label: string, className = 'dg-label'): SVGTextElement {
  const node = el('text', { class: className, x: cx, y: cy });
  node.textContent = label;
  return node;
}

function frame(name: DiagramName): SVGSVGElement {
  const svg = el('svg', {
    class: `dg dg-${name}`,
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    role: 'img',
    focusable: 'false',
  });
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) svg.append(slot(col, row));
  }
  return svg;
}

/** Tiles shove as far as they go, all at once. */
function slideDiagram(): SVGSVGElement {
  const svg = frame('slide');
  svg.setAttribute('aria-label', 'Tiles sliding to the right edge of the board');
  // Each tile is drawn where it ends up and animated back from where it began,
  // so the still frame is the starting board.
  svg.append(
    tile(2, 1, 2, 'dg-move dg-from-2'),
    tile(3, 1, 4, 'dg-move dg-from-1'),
    tile(4, 1, 8, 'dg-move dg-from-0'),
  );
  return svg;
}

/** Two equal tiles meet and become one. */
function mergeDiagram(): SVGSVGElement {
  const svg = frame('merge');
  svg.setAttribute('aria-label', 'Two tiles of the same number merging into their sum');
  // One tile sits still and the other slides into it. Animating both onto the
  // same cell is what really happens, but at this size the overlap in flight
  // reads as a rendering fault rather than as a merge.
  svg.append(
    tile(3, 1, 2, 'dg-eater'),
    tile(3, 1, 2, 'dg-eaten dg-from-1'),
    tile(3, 1, 4, 'dg-born'),
  );
  return svg;
}

/** The window closing, and the multiplier climbing while it is open. */
function comboDiagram(): SVGSVGElement {
  const svg = frame('combo');
  svg.setAttribute('aria-label', 'A combo window draining while the multiplier climbs');
  svg.append(
    tile(0, 1, 4, 'dg-pulse dg-beat-0'),
    tile(1, 1, 8, 'dg-pulse dg-beat-1'),
    tile(2, 1, 16, 'dg-pulse dg-beat-2'),
    el('rect', { class: 'dg-track', x: 0, y: HEIGHT - 3, width: WIDTH, height: 3, rx: 1.5 }),
    el('rect', { class: 'dg-drain', x: 0, y: HEIGHT - 3, width: WIDTH, height: 3, rx: 1.5 }),
    text(WIDTH - 14, y(1) + CELL / 2, '9x', 'dg-multiplier'),
  );
  return svg;
}

/** A row shoves in from below and the ceiling takes whatever it reaches. */
function riseDiagram(): SVGSVGElement {
  const svg = frame('rise');
  svg.setAttribute('aria-label', 'A new row pushing up from below, crushing the top row');
  svg.append(
    el('rect', {
      class: 'dg-ceiling',
      x: 0,
      y: 0,
      width: WIDTH,
      height: CELL,
      rx: 3,
    }),
    tile(1, 1, 4, 'dg-lift dg-doomed'),
    tile(3, 1, 2, 'dg-lift'),
    tile(2, 2, 8, 'dg-lift'),
    tile(0, 2, 2, 'dg-fed'),
    tile(4, 2, 2, 'dg-fed'),
  );
  return svg;
}

/** The floor blows out and everything falls a row. */
function ventDiagram(): SVGSVGElement {
  const svg = frame('vent');
  svg.setAttribute('aria-label', 'The bottom row blowing out and the board dropping one row');
  svg.append(
    tile(1, 0, 4, 'dg-drop'),
    tile(3, 0, 2, 'dg-drop'),
    tile(2, 1, 8, 'dg-drop'),
    tile(0, 2, 2, 'dg-blown'),
    tile(2, 2, 4, 'dg-blown'),
    tile(4, 2, 2, 'dg-blown'),
  );
  return svg;
}

const BUILDERS: Record<DiagramName, () => SVGSVGElement> = {
  slide: slideDiagram,
  merge: mergeDiagram,
  combo: comboDiagram,
  rise: riseDiagram,
  vent: ventDiagram,
};

export function buildDiagram(name: DiagramName): SVGSVGElement {
  return BUILDERS[name]();
}
