/**
 * The paid banner.
 *
 * One slot, held by whoever paid the most. To take it you pay more than the
 * standing bid through PayPal; the moment the capture clears, the banner is
 * yours and the page swaps to it. The leaderboard beside it stays free — money
 * buys the billboard, not the ranking.
 *
 * The PayPal SDK is loaded lazily and only when the server says it is
 * configured, so a deployment without credentials degrades to a read-only
 * banner rather than a broken button.
 */

import { api, type BannerInfo, type BannerState } from '../net/api.js';
import {
  formatCents,
  minimumClaimCents,
  sanitizeBannerText,
  sanitizeBannerUrl,
  sanitizeName,
  ValidationError,
} from '../../shared/rules.js';

export interface BannerElements {
  slot: HTMLElement;
  link: HTMLAnchorElement;
  text: HTMLElement;
  holder: HTMLElement;
  amount: HTMLElement;
  empty: HTMLElement;
  claimButton: HTMLButtonElement;
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  inputText: HTMLInputElement;
  inputUrl: HTMLInputElement;
  inputName: HTMLInputElement;
  inputAmount: HTMLInputElement;
  minimumNote: HTMLElement;
  status: HTMLElement;
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
  Buttons(config: PayPalButtonsConfig): { render(target: HTMLElement): Promise<void>; close?(): void };
}

export class BannerController {
  private info: BannerInfo | null = null;
  private sdkPromise: Promise<PayPalSdk | null> | null = null;
  private buttonsRendered = false;

  constructor(private els: BannerElements) {
    els.claimButton.addEventListener('click', () => void this.openDialog());
    els.closeButton.addEventListener('click', () => els.dialog.close());
    els.form.addEventListener('submit', (event) => event.preventDefault());

    // Keep the minimum note honest as they type.
    els.inputAmount.addEventListener('input', () => this.renderMinimumNote());
  }

  async refresh(): Promise<void> {
    try {
      this.info = await api.banner();
      this.render();
    } catch {
      // Leave whatever is on screen; the banner is not worth an error state.
    }
  }

  private render(): void {
    const info = this.info;
    if (!info) return;
    const banner = info.banner;

    if (banner) {
      this.els.link.href = banner.url;
      this.els.link.rel = 'nofollow noopener sponsored';
      this.els.link.target = '_blank';
      this.els.text.textContent = banner.text;
      this.els.holder.textContent = banner.name;
      this.els.amount.textContent = formatCents(banner.amountCents);
      this.els.slot.hidden = false;
      this.els.empty.hidden = true;
    } else {
      this.els.slot.hidden = true;
      this.els.empty.hidden = false;
    }

    // No PayPal credentials on the server means nobody can claim it.
    this.els.claimButton.hidden = !info.paypalClientId;
    this.els.claimButton.textContent = banner ? 'Outbid' : 'Claim this space';
    this.renderMinimumNote();
  }

  private get minimumCents(): number {
    return this.info?.minimumCents ?? minimumClaimCents(this.info?.banner?.amountCents ?? null);
  }

  private renderMinimumNote(): void {
    const minimum = this.minimumCents;
    const held = this.info?.banner;
    this.els.minimumNote.textContent = held
      ? `${held.name} holds it at ${formatCents(held.amountCents)}. You need at least ${formatCents(minimum)}.`
      : `The slot is open. Minimum bid ${formatCents(minimum)}.`;
    this.els.inputAmount.min = (minimum / 100).toFixed(2);
  }

  private async openDialog(): Promise<void> {
    await this.refresh();
    this.setStatus('');
    this.els.inputAmount.value = (this.minimumCents / 100).toFixed(2);
    this.renderMinimumNote();
    this.els.dialog.showModal();
    await this.mountPayPal();
  }

  private setStatus(message: string, isError = false): void {
    this.els.status.textContent = message;
    this.els.status.classList.toggle('is-error', isError);
  }

  /** Validate the form the same way the server will, before taking money. */
  private readClaim(): { text: string; url: string; name: string; amountUsd: number } {
    const text = sanitizeBannerText(this.els.inputText.value);
    const url = sanitizeBannerUrl(this.els.inputUrl.value);
    const name = sanitizeName(this.els.inputName.value);
    const amountUsd = Number(this.els.inputAmount.value);

    if (!Number.isFinite(amountUsd)) throw new ValidationError('enter an amount');
    if (Math.round(amountUsd * 100) < this.minimumCents) {
      throw new ValidationError(`bid at least ${formatCents(this.minimumCents)}`);
    }
    return { text, url, name, amountUsd };
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
        const { orderId } = await api.createBannerOrder(claim);
        this.setStatus('Approve the payment in the PayPal window.');
        return orderId;
      },

      onApprove: async ({ orderID }) => {
        this.setStatus('Confirming payment…');
        const { banner } = await api.captureBannerOrder(orderID);
        this.onClaimed(banner);
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

  private onClaimed(banner: BannerState): void {
    if (this.info) this.info = { ...this.info, banner, minimumCents: minimumClaimCents(banner.amountCents) };
    this.render();
    this.setStatus('The banner is yours. Thanks!');
    setTimeout(() => this.els.dialog.close(), 1400);
  }
}
