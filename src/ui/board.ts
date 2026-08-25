/**
 * The paid board.
 *
 * An auction with no losing bids and no door charge. Bidding opens at $0, and
 * what you pay buys a rank rather than admission. Taking #1 means beating what
 * the leader paid, but everything below #1 is simply "whatever this much money
 * is worth today", so a bid never fails for being too small — it just seats you
 * lower. The only rejection is an amount PayPal could not capture.
 *
 * The side slots beside the game are the other half of the deal: those are won
 * by scoring, and no amount of money moves them. See `sideSlots` in the rules.
 *
 * The PayPal SDK is loaded lazily and only when the server says it is
 * configured, so a deployment without credentials degrades to a read-only board
 * rather than a broken button.
 */

import { api, type BoardInfo, type ClaimOutcome } from '../net/api.js';
import { formatNumber } from './leaderboard.js';
import {
  entryCents,
  formatCents,
  MIN_PAYABLE_CENTS,
  rankFor,
  sanitizeListingTagline,
  sanitizeListingTitle,
  sanitizeListingUrl,
  sanitizeName,
  topSpotCents,
  ValidationError,
  type Listing,
  type ScoreRow,
} from '../../shared/rules.js';

export interface BoardElements {
  /** Hero */
  heroPrice: HTMLElement;
  heroDown: HTMLButtonElement;
  heroUp: HTMLButtonElement;
  heroEntry: HTMLElement;
  heroUrl: HTMLInputElement;
  heroGo: HTMLButtonElement;

  /** The ranked list */
  list: HTMLElement;
  empty: HTMLElement;
  status: HTMLElement;
  count: HTMLElement;

  /** Earned slots */
  sideSlots: HTMLElement;

  /** Claim dialog */
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  inputTitle: HTMLInputElement;
  inputTagline: HTMLInputElement;
  inputUrl: HTMLInputElement;
  inputName: HTMLInputElement;
  inputAmount: HTMLInputElement;
  note: HTMLElement;
  claimStatus: HTMLElement;
  paypalMount: HTMLElement;
  closeButton: HTMLButtonElement;
}

interface PayPalButtonsConfig {
  style?: Record<string, string>;
  createOrder: () => Promise<string>;
  onApprove: (data: { orderID: string }) => Promise<void>;
  onError?: (error: unknown) => void;
  onCancel?: () => void;
}

interface PayPalSdk {
  Buttons(config: PayPalButtonsConfig): {
    render(target: HTMLElement): Promise<void>;
    close?(): void;
  };
}

/** The step used by the hero's -/+ buttons, in cents. */
const STEP_CENTS = 100;

export class BoardController {
  private info: BoardInfo | null = null;
  private sdkPromise: Promise<PayPalSdk | null> | null = null;
  private buttonsRendered = false;
  /** What the hero's big number currently reads, in cents. */
  private askCents = entryCents();

  constructor(private els: BoardElements) {
    els.heroDown.addEventListener('click', () => this.nudge(-STEP_CENTS));
    els.heroUp.addEventListener('click', () => this.nudge(STEP_CENTS));
    els.heroGo.addEventListener('click', () => void this.openDialog());
    els.closeButton.addEventListener('click', () => els.dialog.close());
    els.form.addEventListener('submit', (event) => event.preventDefault());
    els.inputAmount.addEventListener('input', () => this.renderNote());
  }

  async refresh(): Promise<void> {
    try {
      this.info = await api.board();
      this.askCents = this.info.topSpotCents;
      this.render();
      this.els.status.textContent = '';
    } catch {
      this.els.status.textContent = 'The board is offline right now.';
    }
  }

  /** Fold a freshly seated listing in without a round trip. */
  applyClaim(outcome: ClaimOutcome): void {
    if (!this.info) return;
    const top = outcome.listings[0]?.amountCents ?? null;
    this.info = { ...this.info, listings: outcome.listings, topSpotCents: topSpotCents(top) };
    this.askCents = this.info.topSpotCents;
    this.render();
  }

  /** The game hands us new slot holders after every posted run. */
  setSideSlots(slots: ScoreRow[]): void {
    if (this.info) this.info = { ...this.info, sideSlots: slots };
    this.renderSideSlots(slots);
  }

  private nudge(deltaCents: number): void {
    const floor = this.info?.topSpotCents ?? entryCents();
    // The hero advertises the price of #1, so it never reads below that.
    this.askCents = Math.max(floor, this.askCents + deltaCents);
    this.renderHero();
  }

  private render(): void {
    this.renderHero();
    this.renderList();
    this.renderSideSlots(this.info?.sideSlots ?? []);
    this.renderNote();
  }

  private renderHero(): void {
    const info = this.info;
    this.els.heroPrice.textContent = formatCents(this.askCents);
    // Two nodes rather than one string: only the lead sentence is coral, and
    // ::first-line would colour whatever happens to wrap onto line one.
    if (info) {
      const lead = document.createElement('span');
      lead.className = 'hero-lead';
      lead.textContent = `Bidding starts at ${formatCents(info.entryCents)}.`;
      this.els.heroEntry.replaceChildren(
        lead,
        document.createTextNode(
          ' There is no entry fee — pay less than the #1 price and you still land on the board, at whatever place that bid can take.',
        ),
      );
    } else {
      this.els.heroEntry.replaceChildren();
    }
    // Nobody can claim anything if the server has no PayPal credentials.
    this.els.heroGo.disabled = !info?.paypalClientId;
    this.els.heroGo.title = info?.paypalClientId
      ? ''
      : 'Payments are not configured on this deployment.';
  }

  private renderList(): void {
    const listings = this.info?.listings ?? [];
    this.els.list.replaceChildren(...listings.map((row, index) => listingRow(row, index + 1)));
    this.els.list.hidden = listings.length === 0;
    this.els.empty.hidden = listings.length > 0;
    this.els.count.textContent = `${listings.length}`;
  }

  private renderSideSlots(slots: ScoreRow[]): void {
    this.els.sideSlots.replaceChildren(...slots.map((row, index) => sideSlot(row, index + 1)));
  }

  /** Tell them exactly what the number in the box buys, as they type it. */
  private renderNote(): void {
    const info = this.info;
    if (!info) return;

    const cents = Math.round((Number(this.els.inputAmount.value) + Number.EPSILON) * 100);
    // Bidding opens at $0, so the only unusable number is one that cannot be
    // charged at all.
    if (!Number.isFinite(cents) || cents < MIN_PAYABLE_CENTS) {
      this.els.note.textContent = 'Bids start above $0.';
      this.els.note.classList.remove('is-top');
      return;
    }

    const rank = rankFor(info.listings, cents);
    this.els.note.textContent =
      rank === 1
        ? `${formatCents(cents)} takes the #1 spot.`
        : `${formatCents(cents)} seats you at #${rank}. #1 costs ${formatCents(info.topSpotCents)}.`;
    this.els.note.classList.toggle('is-top', rank === 1);
  }

  private async openDialog(): Promise<void> {
    await this.refresh();
    this.setStatus('');
    // Carry over whatever they typed in the hero rather than making them retype.
    if (this.els.heroUrl.value.trim()) this.els.inputUrl.value = this.els.heroUrl.value.trim();
    // The hero can legitimately read $0 on an empty board, but the form has to
    // open on something chargeable.
    this.els.inputAmount.value = (Math.max(this.askCents, MIN_PAYABLE_CENTS) / 100).toFixed(2);
    this.els.inputAmount.min = (MIN_PAYABLE_CENTS / 100).toFixed(2);
    this.renderNote();
    this.els.dialog.showModal();
    await this.mountPayPal();
  }

  private setStatus(message: string, isError = false): void {
    this.els.claimStatus.textContent = message;
    this.els.claimStatus.classList.toggle('is-error', isError);
  }

  /** Validate the form the same way the server will, before taking money. */
  private readClaim(): {
    title: string;
    tagline: string;
    url: string;
    name: string;
    amountUsd: number;
  } {
    const title = sanitizeListingTitle(this.els.inputTitle.value);
    const tagline = sanitizeListingTagline(this.els.inputTagline.value);
    const url = sanitizeListingUrl(this.els.inputUrl.value);
    const name = sanitizeName(this.els.inputName.value);
    const amountUsd = Number(this.els.inputAmount.value);

    if (!Number.isFinite(amountUsd)) throw new ValidationError('enter an amount');
    if (Math.round((amountUsd + Number.EPSILON) * 100) < MIN_PAYABLE_CENTS) {
      throw new ValidationError('bids start above $0');
    }
    return { title, tagline, url, name, amountUsd };
  }

  private loadSdk(): Promise<PayPalSdk | null> {
    if (this.sdkPromise) return this.sdkPromise;
    const info = this.info;
    if (!info?.paypalClientId) return Promise.resolve(null);

    this.sdkPromise = new Promise<PayPalSdk | null>((resolve) => {
      const existing = (globalThis as { paypal?: PayPalSdk }).paypal;
      if (existing) {
        resolve(existing);
        return;
      }
      const script = document.createElement('script');
      const params = new URLSearchParams({
        'client-id': info.paypalClientId!,
        currency: info.currency || 'USD',
        intent: 'capture',
        components: 'buttons',
      });
      script.src = `https://www.paypal.com/sdk/js?${params.toString()}`;
      script.async = true;
      script.onload = () => resolve((globalThis as { paypal?: PayPalSdk }).paypal ?? null);
      script.onerror = () => resolve(null);
      document.head.append(script);
    });
    return this.sdkPromise;
  }

  private async mountPayPal(): Promise<void> {
    if (this.buttonsRendered) return;
    const sdk = await this.loadSdk();
    if (!sdk) {
      this.setStatus('PayPal is not available right now.', true);
      return;
    }

    const buttons = sdk.Buttons({
      style: { layout: 'horizontal', height: '42', color: 'gold', shape: 'pill', tagline: 'false' },

      createOrder: async () => {
        // Throwing here aborts the PayPal flow before any money moves.
        const claim = this.readClaim();
        this.setStatus('Creating order…');
        const { orderId } = await api.createListingOrder(claim);
        this.setStatus('Approve the payment in the PayPal window.');
        return orderId;
      },

      onApprove: async ({ orderID }) => {
        this.setStatus('Confirming payment…');
        const outcome = await api.captureListingOrder(orderID);
        this.applyClaim(outcome);
        this.setStatus(
          outcome.rank ? `You are on the board at #${outcome.rank}. Thanks!` : 'You are on the board. Thanks!',
        );
        setTimeout(() => this.els.dialog.close(), 1600);
      },

      onCancel: () => this.setStatus('Payment cancelled.'),

      onError: (error: unknown) => {
        const message = error instanceof Error ? error.message : 'Payment failed.';
        this.setStatus(message, true);
      },
    });

    try {
      await buttons.render(this.els.paypalMount);
      this.buttonsRendered = true;
    } catch {
      this.setStatus('Could not load the PayPal button.', true);
    }
  }
}

/** One paid row. Everything player-supplied goes in as a text node. */
function listingRow(row: Listing, rank: number): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'listing';
  if (rank === 1) li.classList.add('is-top');

  const badge = document.createElement('span');
  badge.className = 'listing-rank';
  badge.textContent = `#${rank}`;

  const body = document.createElement('div');
  body.className = 'listing-body';

  const link = document.createElement('a');
  link.className = 'listing-title';
  link.href = row.url;
  link.rel = 'nofollow noopener sponsored';
  link.target = '_blank';
  link.textContent = row.title;
  body.append(link);

  if (row.tagline) {
    const tagline = document.createElement('p');
    tagline.className = 'listing-tagline';
    tagline.textContent = row.tagline;
    body.append(tagline);
  }

  const meta = document.createElement('p');
  meta.className = 'listing-meta';
  meta.append(
    tag('listing-host', hostOf(row.url)),
    tag('listing-by', `by ${row.name}`),
  );
  body.append(meta);

  const price = document.createElement('span');
  price.className = 'listing-price';
  price.textContent = formatCents(row.amountCents);

  li.append(badge, body, price);
  return li;
}

/** One earned slot. No link unless the player attached one. */
function sideSlot(row: ScoreRow, rank: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'slot';
  wrap.dataset.rank = String(rank);

  const head = document.createElement('span');
  head.className = 'slot-rank';
  head.textContent = `#${rank} · earned`;

  const name = document.createElement('span');
  name.className = 'slot-name';
  if (row.url) {
    const link = document.createElement('a');
    link.href = row.url;
    link.rel = 'nofollow noopener';
    link.target = '_blank';
    link.textContent = row.name;
    name.append(link);
  } else {
    name.textContent = row.name;
  }

  const score = document.createElement('span');
  score.className = 'slot-score';
  score.textContent = `${formatNumber(row.score)} pts`;

  wrap.append(head, name, score);
  return wrap;
}

function tag(className: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
