/**
 * PayPal Orders v2, the parts we need: mint an access token, create an order,
 * capture it, and verify a webhook signature.
 *
 * Everything that touches the secret happens here on the Worker. The browser
 * only ever sees an order id, which is useless without the credentials.
 *
 * Note for anyone running this: the amount is decided server-side from the
 * claim the client submitted *and re-checked at capture*, because the PayPal
 * approval window is a place a determined user can meddle. Capture confirms
 * the amount that actually cleared before the banner changes hands.
 */

export type PayPalEnvironment = 'sandbox' | 'live';

const API_BASE: Record<PayPalEnvironment, string> = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  environment: PayPalEnvironment;
  webhookId?: string;
}

export class PayPalError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: unknown) {
    super(message);
    this.name = 'PayPalError';
  }
}

export interface CapturedOrder {
  orderId: string;
  status: string;
  /** Amount that actually cleared, in cents. */
  amountCents: number;
  currency: string;
  captureId: string | null;
  payerEmail: string | null;
}

export class PayPalClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private config: PayPalConfig, private fetchImpl: typeof fetch = fetch) {}

  private get base(): string {
    return API_BASE[this.config.environment];
  }

  /** Cached client-credentials token. PayPal tokens last ~9 hours. */
  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 60_000) return this.token.value;

    const credentials = btoa(`${this.config.clientId}:${this.config.clientSecret}`);
    const response = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${credentials}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const body = (await safeJson(response)) as { access_token?: string; expires_in?: number } | null;
    if (!response.ok || !body?.access_token) {
      throw new PayPalError('could not authenticate with PayPal', 502, body);
    }

    this.token = {
      value: body.access_token,
      expiresAt: now + (body.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  private async call<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
    const token = await this.accessToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (init.idempotencyKey) headers['paypal-request-id'] = init.idempotencyKey;

    const response = await this.fetchImpl(`${this.base}${path}`, { ...init, headers });
    const body = await safeJson(response);
    if (!response.ok) {
      const detail = (body as { message?: string } | null)?.message ?? `PayPal returned ${response.status}`;
      throw new PayPalError(detail, response.status === 422 ? 400 : 502, body);
    }
    return body as T;
  }

  /**
   * Create an order for a banner claim.
   * @param amountCents Server-decided amount; never taken from the client verbatim.
   */
  async createOrder(options: {
    amountCents: number;
    currency: string;
    description: string;
    referenceId: string;
    returnUrl?: string;
    cancelUrl?: string;
  }): Promise<{ id: string; status: string }> {
    const value = (options.amountCents / 100).toFixed(2);
    return this.call<{ id: string; status: string }>('/v2/checkout/orders', {
      method: 'POST',
      idempotencyKey: options.referenceId,
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: options.referenceId,
            description: options.description.slice(0, 127),
            amount: { currency_code: options.currency, value },
          },
        ],
        application_context: {
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          brand_name: 'SURGE',
          ...(options.returnUrl ? { return_url: options.returnUrl } : {}),
          ...(options.cancelUrl ? { cancel_url: options.cancelUrl } : {}),
        },
      }),
    });
  }

  /** Capture an approved order and report what actually cleared. */
  async captureOrder(orderId: string): Promise<CapturedOrder> {
    const body = await this.call<PayPalOrderResponse>(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      { method: 'POST', body: '{}', idempotencyKey: `capture-${orderId}` },
    );
    return readOrder(orderId, body);
  }

  /** Read an order back, e.g. when a webhook tells us about one. */
  async getOrder(orderId: string): Promise<CapturedOrder> {
    const body = await this.call<PayPalOrderResponse>(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    );
    return readOrder(orderId, body);
  }

  /**
   * Ask PayPal whether a webhook really came from them.
   *
   * Verifying server-side rather than checking a shared secret is the
   * documented approach, and it means a forged webhook cannot move the banner.
   */
  async verifyWebhook(headers: Headers, rawBody: string): Promise<boolean> {
    if (!this.config.webhookId) return false;

    const required = [
      'paypal-auth-algo',
      'paypal-cert-url',
      'paypal-transmission-id',
      'paypal-transmission-sig',
      'paypal-transmission-time',
    ] as const;
    const values: Record<string, string> = {};
    for (const name of required) {
      const value = headers.get(name);
      if (!value) return false;
      values[name] = value;
    }

    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return false;
    }

    try {
      const result = await this.call<{ verification_status?: string }>(
        '/v1/notifications/verify-webhook-signature',
        {
          method: 'POST',
          body: JSON.stringify({
            auth_algo: values['paypal-auth-algo'],
            cert_url: values['paypal-cert-url'],
            transmission_id: values['paypal-transmission-id'],
            transmission_sig: values['paypal-transmission-sig'],
            transmission_time: values['paypal-transmission-time'],
            webhook_id: this.config.webhookId,
            webhook_event: event,
          }),
        },
      );
      return result.verification_status === 'SUCCESS';
    } catch {
      return false;
    }
  }
}

interface PayPalOrderResponse {
  id?: string;
  status?: string;
  purchase_units?: {
    reference_id?: string;
    amount?: { currency_code?: string; value?: string };
    payments?: {
      captures?: {
        id?: string;
        status?: string;
        amount?: { currency_code?: string; value?: string };
      }[];
    };
  }[];
  payer?: { email_address?: string };
}

function readOrder(orderId: string, body: PayPalOrderResponse): CapturedOrder {
  const unit = body.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  // Prefer the captured amount: it is what actually moved.
  const amount = capture?.amount ?? unit?.amount;
  const value = Number(amount?.value ?? '0');

  return {
    orderId: body.id ?? orderId,
    status: capture?.status ?? body.status ?? 'UNKNOWN',
    amountCents: Number.isFinite(value) ? Math.round(value * 100) : 0,
    currency: amount?.currency_code ?? 'USD',
    captureId: capture?.id ?? null,
    payerEmail: body.payer?.email_address ?? null,
  };
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

/** Read PayPal config from the environment, or null when it is not set up. */
export function readPayPalConfig(env: Record<string, unknown>): PayPalConfig | null {
  const clientId = typeof env.PAYPAL_CLIENT_ID === 'string' ? env.PAYPAL_CLIENT_ID : '';
  const clientSecret = typeof env.PAYPAL_CLIENT_SECRET === 'string' ? env.PAYPAL_CLIENT_SECRET : '';
  if (!clientId || !clientSecret) return null;

  const environment: PayPalEnvironment = env.PAYPAL_ENVIRONMENT === 'live' ? 'live' : 'sandbox';
  const webhookId = typeof env.PAYPAL_WEBHOOK_ID === 'string' ? env.PAYPAL_WEBHOOK_ID : undefined;
  return { clientId, clientSecret, environment, ...(webhookId ? { webhookId } : {}) };
}
