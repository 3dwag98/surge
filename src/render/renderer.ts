/**
 * Canvas renderer.
 *
 * Every tile keeps a visual position that eases toward wherever the engine
 * says it is, so slides, rises and vents all animate for free — the renderer
 * never needs to know *why* a tile moved, only that it did. Discrete events
 * (a merge landing, a vent firing, the run ending) come in as explicit calls
 * and spawn particles, flashes and shake on top.
 *
 * The engine holds truth; this holds only how that truth currently looks.
 */

import { CHARGE_MAX, COMBO_MAX } from '../game/engine.js';
import type { Ghost, Tile } from '../game/types.js';
import { board, BOARD_FONT, comboColor, tileColor } from './palette.js';

interface VisualTile {
  id: number;
  value: number;
  /** Interpolated board coordinates, in cells. */
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  scale: number;
  targetScale: number;
  alpha: number;
  targetAlpha: number;
  /** Extra pop applied on top of scale, decays to 0. */
  pop: number;
  dying: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

interface Ripple {
  y: number;
  life: number;
  maxLife: number;
  color: string;
}

interface FloatingText {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
}

const MAX_PARTICLES = 420;

/** Room reserved above the board for the rise timer, and below it for charge. */
const TOP_METER = 14;
const BOTTOM_METER = 10;
/** Thickness of each meter. */
const METER_H = 5;

/** Fraction of the remaining distance closed per 16.7ms frame. */
const EASE_MOVE = 0.34;
const EASE_SCALE = 0.24;
const EASE_ALPHA = 0.28;

export interface RendererOptions {
  cols: number;
  rows: number;
  reducedMotion?: boolean;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private cols: number;
  private rows: number;
  private reducedMotion: boolean;

  private visuals = new Map<number, VisualTile>();
  private particles: Particle[] = [];
  private ripples: Ripple[] = [];
  private floaters: FloatingText[] = [];

  private shake = 0;
  private flash = 0;
  private flashColor = '#ffffff';

  /** CSS pixel size of the drawing area. */
  private width = 0;
  private height = 0;
  private cell = 0;
  private gap = 0;
  private originX = 0;
  private originY = 0;

  private lastFrame = 0;

  constructor(private canvas: HTMLCanvasElement, options: RendererOptions) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
    this.cols = options.cols;
    this.rows = options.rows;
    this.reducedMotion = options.reducedMotion ?? false;
    this.resize();
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  /** Match the backing store to the element's CSS box and device pixel ratio. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.width = width;
    this.height = height;

    // Two meters bracket the board, each on the edge it is about: the rise
    // timer runs along the ceiling you are being pushed into, and the charge
    // meter along the floor the vent blows out.
    const usableW = width;
    const usableH = height - TOP_METER - BOTTOM_METER;
    this.gap = Math.max(4, Math.min(usableW, usableH) * 0.018);
    // Gaps sit only *between* cells, never around them, so the outer cells run
    // flush to the edges of the canvas. With no frame drawn any more, that flush
    // edge is what lines the board up with the HUD above it and the rule above
    // that — alignment is the only structure left.
    const cellW = (usableW - this.gap * (this.cols - 1)) / this.cols;
    const cellH = (usableH - this.gap * (this.rows - 1)) / this.rows;
    this.cell = Math.max(8, Math.min(cellW, cellH));

    const boardW = this.cell * this.cols + this.gap * (this.cols - 1);
    const boardH = this.cell * this.rows + this.gap * (this.rows - 1);
    this.originX = (width - boardW) / 2;
    this.originY = TOP_METER + (usableH - boardH) / 2;
  }

  /* ------------------------------------------------------------- geometry */

  private cellX(col: number): number {
    return this.originX + col * (this.cell + this.gap);
  }

  private cellY(row: number): number {
    return this.originY + row * (this.cell + this.gap);
  }

  private centerX(col: number): number {
    return this.cellX(col) + this.cell / 2;
  }

  private centerY(row: number): number {
    return this.cellY(row) + this.cell / 2;
  }

  /* --------------------------------------------------------------- events */

  /**
   * Reconcile against the engine's tiles. New tiles animate in according to
   * where they came from; tiles that vanished without a ghost just fade.
   */
  sync(tiles: readonly Tile[]): void {
    const seen = new Set<number>();

    for (const tile of tiles) {
      seen.add(tile.id);
      const existing = this.visuals.get(tile.id);
      if (existing) {
        existing.value = tile.value;
        existing.targetX = tile.col;
        existing.targetY = tile.row;
        existing.targetAlpha = 1;
        existing.targetScale = 1;
        continue;
      }

      const visual: VisualTile = {
        id: tile.id,
        value: tile.value,
        x: tile.col,
        y: tile.row,
        targetX: tile.col,
        targetY: tile.row,
        scale: 1,
        targetScale: 1,
        alpha: 1,
        targetAlpha: 1,
        pop: 0,
        dying: false,
      };

      if (tile.origin === 'merge') {
        // Merged tiles punch outward from nothing.
        visual.scale = 0.1;
        visual.pop = 0.42;
      } else if (tile.origin === 'rise') {
        // Rising tiles slide up from below the floor.
        visual.y = this.rows + 0.15;
        visual.alpha = 0.2;
      } else if (tile.origin === 'spawn') {
        // Fed in after a move: a quick fade-up in place.
        visual.y = tile.row + 0.3;
        visual.scale = 0.55;
        visual.alpha = 0;
      } else {
        visual.scale = 0.35;
        visual.alpha = 0;
      }

      if (this.reducedMotion) {
        visual.x = tile.col;
        visual.y = tile.row;
        visual.scale = 1;
        visual.alpha = 1;
        visual.pop = 0;
      }

      this.visuals.set(tile.id, visual);
    }

    for (const [id, visual] of this.visuals) {
      if (!seen.has(id) && !visual.dying) {
        visual.dying = true;
        visual.targetAlpha = 0;
        visual.targetScale = 0.6;
      }
    }
  }

  /**
   * Tiles the engine removed. Merge sources travel into the merge cell before
   * disappearing; vented and crushed tiles burst where they stood.
   */
  applyGhosts(ghosts: readonly Ghost[]): void {
    for (const ghost of ghosts) {
      const visual = this.visuals.get(ghost.id);
      if (visual) {
        visual.dying = true;
        visual.targetX = ghost.col;
        visual.targetY = ghost.row;
        visual.targetAlpha = 0;
        visual.targetScale = ghost.reason === 'merge' ? 0.75 : 0.2;
      }
      if (ghost.reason !== 'merge') {
        this.burst(ghost.row, ghost.col, ghost.value, ghost.reason === 'crush' ? 22 : 12);
      }
    }
  }

  /** A merge landed: pop particles and float the points won. */
  onMerge(row: number, col: number, value: number, combo: number, points: number): void {
    this.burst(row, col, value, 10 + Math.min(14, combo * 2));
    if (points > 0) {
      let y = this.centerY(row) - this.cell * 0.28;
      // Quick chains would otherwise stack unreadable text on the same spot;
      // nudge each new label clear of whatever is still on screen.
      for (let guard = 0; guard < 6; guard += 1) {
        const clash = this.floaters.find(
          (f) => Math.abs(f.x - this.centerX(col)) < this.cell * 0.9 && Math.abs(f.y - y) < this.cell * 0.4,
        );
        if (!clash) break;
        y = clash.y - this.cell * 0.45;
      }

      this.floaters.push({
        x: this.centerX(col),
        y,
        text: combo > 1 ? `+${points} x${combo}` : `+${points}`,
        color: comboColor(combo, COMBO_MAX),
        life: 560,
        maxLife: 560,
      });
      // Never let a long chain bury the board it is reporting on. A fast bot
      // merges several times a second, and six labels at once is unreadable.
      if (this.floaters.length > 4) this.floaters.splice(0, this.floaters.length - 4);
    }
    if (combo >= 4) this.addShake(Math.min(6, combo * 0.6));
  }

  /** A row pushed in from the bottom. */
  onRise(crushed: boolean): void {
    if (crushed) {
      this.addShake(16);
      this.flashWith(board().crushFlash, 1);
    } else {
      this.addShake(2.5);
      this.ripples.push({ y: this.rows - 0.5, life: 520, maxLife: 520, color: board().riseRipple });
    }
  }

  /** A vent fired: shockwave from the floor and a cool flash. */
  onVent(): void {
    this.addShake(9);
    this.flashWith(board().ventFlash, 0.55);
    this.ripples.push({ y: this.rows - 0.5, life: 720, maxLife: 720, color: board().ventRipple });
  }

  /* ---------------------------------------------------------------- frame */

  /**
   * Advance the animation and draw.
   *
   * @param now High-resolution timestamp from requestAnimationFrame.
   * @param hud Live values the board itself displays.
   */
  draw(
    now: number,
    hud: {
      risePressure: number;
      combo: number;
      comboRemaining: number;
      charge: number;
      ventArmed: boolean;
      over: boolean;
    },
  ): void {
    const dt = this.lastFrame === 0 ? 16.7 : Math.min(64, now - this.lastFrame);
    this.lastFrame = now;
    const step = dt / 16.7;

    this.advance(step, dt);

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    ctx.save();
    if (this.shake > 0.1) {
      const angle = Math.random() * Math.PI * 2;
      ctx.translate(Math.cos(angle) * this.shake, Math.sin(angle) * this.shake);
    }

    this.drawWell(hud);
    this.drawTiles();
    this.drawRipples();
    this.drawParticles();
    this.drawFloaters();

    ctx.restore();

    this.drawMeters(hud.risePressure, hud.charge, hud.ventArmed);
    this.drawFlash();
  }

  private advance(step: number, dt: number): void {
    const snap = this.reducedMotion;

    for (const [id, visual] of this.visuals) {
      if (snap) {
        visual.x = visual.targetX;
        visual.y = visual.targetY;
        visual.scale = visual.targetScale;
        visual.alpha = visual.targetAlpha;
        visual.pop = 0;
      } else {
        visual.x += (visual.targetX - visual.x) * Math.min(1, EASE_MOVE * step);
        visual.y += (visual.targetY - visual.y) * Math.min(1, EASE_MOVE * step);
        visual.scale += (visual.targetScale - visual.scale) * Math.min(1, EASE_SCALE * step);
        visual.alpha += (visual.targetAlpha - visual.alpha) * Math.min(1, EASE_ALPHA * step);
        visual.pop *= Math.pow(0.86, step);
      }

      if (visual.dying && visual.alpha < 0.02) this.visuals.delete(id);
    }

    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const p = this.particles[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * step;
      p.y += p.vy * step;
      p.vy += 0.16 * step; // a little gravity so bursts arc
      p.vx *= Math.pow(0.97, step);
    }

    for (let i = this.ripples.length - 1; i >= 0; i -= 1) {
      const r = this.ripples[i]!;
      r.life -= dt;
      if (r.life <= 0) this.ripples.splice(i, 1);
    }

    for (let i = this.floaters.length - 1; i >= 0; i -= 1) {
      const f = this.floaters[i]!;
      f.life -= dt;
      if (f.life <= 0) this.floaters.splice(i, 1);
      else f.y -= 0.6 * step;
    }

    this.shake *= Math.pow(0.86, step);
    this.flash *= Math.pow(0.9, step);
  }

  /**
   * The field: empty cells, and the lit band along the row that kills you.
   *
   * There is no container drawn behind them. The cells sit straight on the
   * page, and a climbing combo is shown by warming those cells rather than by
   * ruling a rectangle around the board — the tiles are drawn over the top, so
   * the tint only ever shows in the space you have left.
   */
  private drawWell(hud: { risePressure: number; combo: number; over: boolean }): void {
    const ctx = this.ctx;
    const palette = board();
    const boardW = this.cell * this.cols + this.gap * (this.cols - 1);

    // The top row is where you lose, so it stays lit as a warning.
    const danger = 0.1 + hud.risePressure * 0.5;
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, this.originX, this.originY, boardW, this.cell, this.cell * 0.16);
    ctx.fillStyle = palette.danger(danger * 0.2);
    ctx.fill();
    ctx.restore();

    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        ctx.beginPath();
        roundRect(ctx, this.cellX(col), this.cellY(row), this.cell, this.cell, this.cell * 0.16);
        ctx.fillStyle = row === 0 ? palette.cellDanger : palette.cell;
        ctx.fill();
      }
    }

    // The top row is left out of the combo tint on purpose: at a high combo the
    // tint is nearly the same ink as the danger wash, and letting it reach row 0
    // would erase the one band the player has to keep reading.
    if (hud.combo > 1 && !this.reducedMotion) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.1, 0.014 * hud.combo);
      ctx.fillStyle = comboColor(hud.combo, COMBO_MAX);
      for (let row = 1; row < this.rows; row += 1) {
        for (let col = 0; col < this.cols; col += 1) {
          ctx.beginPath();
          roundRect(ctx, this.cellX(col), this.cellY(row), this.cell, this.cell, this.cell * 0.16);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  private drawTiles(): void {
    const ctx = this.ctx;
    // Draw dying tiles first so live ones sit on top.
    const ordered = [...this.visuals.values()].sort(
      (a, b) => Number(b.dying) - Number(a.dying),
    );

    for (const visual of ordered) {
      if (visual.alpha <= 0.01) continue;
      const color = tileColor(visual.value);
      const scale = Math.max(0.02, visual.scale + visual.pop);
      const size = this.cell * scale;
      const cx = this.cellX(visual.x) + this.cell / 2;
      const cy = this.cellY(visual.y) + this.cell / 2;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, visual.alpha));

      if (!this.reducedMotion) {
        ctx.shadowColor = color.glow;
        ctx.shadowBlur = this.cell * 0.28;
      }
      ctx.beginPath();
      roundRect(ctx, cx - size / 2, cy - size / 2, size, size, size * 0.18);
      ctx.fillStyle = color.fill;
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.lineWidth = Math.max(1, size * 0.035);
      ctx.strokeStyle = color.edge;
      ctx.globalAlpha *= 0.7;
      ctx.stroke();

      ctx.globalAlpha = Math.max(0, Math.min(1, visual.alpha));
      const label = String(visual.value);
      ctx.fillStyle = color.text;
      ctx.font = `700 ${this.fontSizeFor(label, size)}px ${BOARD_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, cy + size * 0.02);
      ctx.restore();
    }
  }

  private fontSizeFor(label: string, size: number): number {
    const base = size * 0.42;
    if (label.length <= 2) return base;
    if (label.length === 3) return base * 0.82;
    if (label.length === 4) return base * 0.66;
    return base * 0.52;
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    ctx.save();
    for (const p of this.particles) {
      const t = p.life / p.maxLife;
      ctx.globalAlpha = Math.max(0, t);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.4 + t * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawRipples(): void {
    const ctx = this.ctx;
    const boardW = this.cell * this.cols + this.gap * (this.cols - 1);
    ctx.save();
    for (const r of this.ripples) {
      const t = 1 - r.life / r.maxLife;
      ctx.globalAlpha = Math.max(0, 1 - t) * 0.8;
      // Fade the sweep out at both ends so it reads as a shockwave rather than
      // a hard rule drawn across the board.
      const gradient = ctx.createLinearGradient(this.originX, 0, this.originX + boardW, 0);
      gradient.addColorStop(0, 'transparent');
      gradient.addColorStop(0.5, r.color);
      gradient.addColorStop(1, 'transparent');
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 2;
      const y = this.cellY(r.y) + this.cell / 2 - t * this.cell * this.rows;
      ctx.beginPath();
      ctx.moveTo(this.originX, y);
      ctx.lineTo(this.originX + boardW, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawFloaters(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of this.floaters) {
      const t = f.life / f.maxLife;
      ctx.globalAlpha = Math.max(0, Math.min(1, t * 1.6));
      ctx.font = `800 ${Math.max(12, this.cell * 0.26)}px ${BOARD_FONT}`;
      // These land on top of bright tiles, so outline them rather than relying
      // on the fill colour alone to stay readable.
      ctx.lineWidth = Math.max(2, this.cell * 0.05);
      ctx.strokeStyle = board().floaterOutline;
      ctx.lineJoin = 'round';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.restore();
  }

  /**
   * The two meters.
   *
   * The rise timer sits on the ceiling, directly above the row that kills you,
   * because that is what it is counting down to. The charge meter sits on the
   * floor, because a vent blows the floor out. Neither is a decoration on the
   * edge of a chart — each is drawn on the edge it describes.
   */
  private drawMeters(pressure: number, charge: number, ventArmed: boolean): void {
    const ctx = this.ctx;
    const palette = board();
    const boardW = this.cell * this.cols + this.gap * (this.cols - 1);

    ctx.save();

    const riseY = Math.max(2, TOP_METER / 2 - METER_H / 2);
    ctx.beginPath();
    roundRect(ctx, this.originX, riseY, boardW, METER_H, METER_H / 2);
    ctx.fillStyle = palette.track;
    ctx.fill();

    const urgency = Math.min(1, pressure);
    ctx.beginPath();
    roundRect(ctx, this.originX, riseY, Math.max(2, boardW * urgency), METER_H, METER_H / 2);
    ctx.fillStyle = palette.pressure(urgency);
    ctx.fill();

    // Charge along the floor. A full meter that is not yet re-armed is drawn
    // hollow rather than solid: it is charged, but it is not a vent yet.
    const chargeRatio = Math.min(1, charge / CHARGE_MAX);
    const chargeY = this.height - BOTTOM_METER / 2 - 1.5;
    ctx.beginPath();
    roundRect(ctx, this.originX, chargeY, Math.max(0, boardW * chargeRatio), 3, 1.5);
    ctx.fillStyle = chargeRatio >= 1 && ventArmed ? palette.chargeFull : palette.chargeIdle;
    ctx.fill();
    ctx.restore();
  }

  private drawFlash(): void {
    if (this.flash <= 0.01) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = Math.min(0.55, this.flash * 0.5);
    ctx.fillStyle = this.flashColor;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  /* --------------------------------------------------------------- effects */

  private burst(row: number, col: number, value: number, count: number): void {
    if (this.reducedMotion) return;
    const color = tileColor(value);
    const cx = this.centerX(col);
    const cy = this.centerY(row);
    const budget = Math.min(count, MAX_PARTICLES - this.particles.length);

    for (let i = 0; i < budget; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 3.4;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1,
        life: 420 + Math.random() * 420,
        maxLife: 840,
        size: this.cell * (0.03 + Math.random() * 0.05),
        color: Math.random() > 0.35 ? color.fill : color.edge,
      });
    }
  }

  private addShake(amount: number): void {
    if (this.reducedMotion) return;
    this.shake = Math.min(24, this.shake + amount);
  }

  private flashWith(color: string, strength: number): void {
    if (this.reducedMotion) return;
    this.flashColor = color;
    this.flash = Math.max(this.flash, strength);
  }

  /** Drop all visual state, e.g. when a new run starts. */
  clear(): void {
    this.visuals.clear();
    this.particles.length = 0;
    this.ripples.length = 0;
    this.floaters.length = 0;
    this.shake = 0;
    this.flash = 0;
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
