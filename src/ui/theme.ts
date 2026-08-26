/**
 * Light and dark, in one place.
 *
 * The choice lives on `<html data-theme>` so CSS can switch on it, and it is
 * mirrored into the canvas palette, which cannot read CSS variables. A visitor
 * who has never picked follows the system setting and keeps following it; the
 * moment they use the toggle their choice is stored and system changes stop
 * moving the page under them.
 *
 * index.html applies the stored value in a blocking inline script before first
 * paint. This module takes over from there — it must agree with that script on
 * both the storage key and the attribute.
 */

import { setPaletteTheme, type ThemeName } from '../render/palette.js';

const STORAGE_KEY = 'surge.theme';

export interface ThemeElements {
  toggle: HTMLButtonElement;
  /** <meta name="theme-color">, so the browser chrome matches the page. */
  meta: HTMLMetaElement | null;
}

/** The colour the browser paints around the page, per theme. */
const META_COLOR: Record<ThemeName, string> = {
  light: '#f7f4fb',
  dark: '#16151f',
};

function stored(): ThemeName | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): ThemeName {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export class ThemeController {
  private current: ThemeName;
  /** True until the visitor picks a side, while we still follow the system. */
  private following: boolean;

  constructor(private els: ThemeElements) {
    const saved = stored();
    this.following = saved === null;
    this.current = saved ?? systemTheme();
    this.apply();

    els.toggle.addEventListener('click', () => {
      this.set(this.current === 'dark' ? 'light' : 'dark', true);
    });

    globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
      if (this.following) this.set(event.matches ? 'dark' : 'light', false);
    });
  }

  get theme(): ThemeName {
    return this.current;
  }

  private set(next: ThemeName, explicit: boolean): void {
    this.current = next;
    if (explicit) {
      this.following = false;
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* storage disabled; the theme still applies for this visit */
      }
    }
    this.apply();
  }

  private apply(): void {
    document.documentElement.dataset.theme = this.current;
    setPaletteTheme(this.current);
    if (this.els.meta) this.els.meta.content = META_COLOR[this.current];

    const goingDark = this.current === 'light';
    this.els.toggle.setAttribute('aria-pressed', String(this.current === 'dark'));
    this.els.toggle.title = goingDark ? 'Switch to dark' : 'Switch to light';
    this.els.toggle.setAttribute('aria-label', this.els.toggle.title);
  }
}
