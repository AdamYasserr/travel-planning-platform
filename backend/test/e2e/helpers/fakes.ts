/**
 * The ONLY places that know Stripe details (event types, payload shapes, which call creates a payment):
 * StripeFake here and confirmBooking() / payment helpers in bookings.ts. Payments use PaymentIntents:
 * the app creates an intent, the customer pays in the browser (Stripe Elements), and Stripe's signed
 * `payment_intent.succeeded` webhook is what confirms the booking.
 */
export interface FakeIntentInput {
  paymentId: string;
  bookingType: string;
  bookingId: string;
  userId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
}

export interface FakeIntent {
  id: string;
  status: 'requires_payment_method' | 'processing' | 'succeeded' | 'canceled';
  amount: number;
  currency: string;
  client_secret: string;
  metadata: Record<string, string>;
}

export class StripeFake {
  /** What the fake "Stripe" has seen, for assertions. */
  readonly created: FakeIntentInput[] = [];
  readonly intents = new Map<string, FakeIntent>();
  readonly cancelledIntents: string[] = [];
  readonly confirmations: { paymentIntentId: string; paymentMethod: string }[] = [];
  readonly refunds: { paymentIntentId: string; amountMinor: number; paymentId: string }[] = [];
  private counter = 0;
  private readonly byKey = new Map<string, FakeIntent>();

  /** Signature value the fake accepts; anything else is rejected like a bad signature. */
  static readonly VALID_SIGNATURE = 'valid';

  async createPaymentIntent(input: FakeIntentInput): Promise<FakeIntent> {
    this.created.push(input);
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return existing;
    const id = `pi_test_${++this.counter}`;
    const intent: FakeIntent = {
      id,
      status: 'requires_payment_method',
      amount: input.amountMinor,
      currency: input.currency.toLowerCase(),
      client_secret: `${id}_secret_${this.counter}`,
      metadata: { paymentId: input.paymentId, bookingType: input.bookingType, bookingId: input.bookingId, userId: input.userId },
    };
    this.intents.set(id, intent);
    this.byKey.set(input.idempotencyKey, intent);
    return intent;
  }

  async retrievePaymentIntent(id: string): Promise<FakeIntent> {
    const intent = this.intents.get(id);
    if (!intent) throw new Error(`No such PaymentIntent: ${id}`);
    return intent;
  }

  /** Like Stripe: the decline test card throws a card error and leaves the intent usable; any other card succeeds. */
  async confirmPaymentIntent(id: string, paymentMethod: string): Promise<FakeIntent> {
    this.confirmations.push({ paymentIntentId: id, paymentMethod });
    const intent = await this.retrievePaymentIntent(id);
    if (paymentMethod === 'pm_card_chargeDeclined') {
      throw Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined' });
    }
    intent.status = 'succeeded';
    return intent;
  }

  constructWebhookEvent(payload: Buffer, signature: string) {
    if (signature !== StripeFake.VALID_SIGNATURE) throw new Error('No signatures found matching the expected signature');
    return JSON.parse(payload.toString('utf8'));
  }

  async cancelPaymentIntent(paymentIntentId: string) {
    this.cancelledIntents.push(paymentIntentId);
    const intent = this.intents.get(paymentIntentId);
    if (intent) intent.status = 'canceled';
    return { id: paymentIntentId, status: 'canceled' };
  }

  /**
   * Outcome of the next createRefund calls (FIFO); default `succeeded`. `error` throws like a network or
   * API error (the refund stays Pending for the retry job). Like Stripe, the same payment (idempotency key
   * `refund-<paymentId>`) always gets the same refund back.
   */
  readonly nextRefundOutcomes: Array<'succeeded' | 'pending' | 'failed' | 'error'> = [];
  readonly stripeRefunds = new Map<string, { id: string; payment_intent: string; amount: number; status: string; metadata: Record<string, string> }>();
  private readonly refundByPayment = new Map<string, string>();

  async createRefund(input: { paymentIntentId: string; amountMinor: number; paymentId: string; refundId?: string; reason?: string }) {
    this.refunds.push({ paymentIntentId: input.paymentIntentId, amountMinor: input.amountMinor, paymentId: input.paymentId });
    const outcome = this.nextRefundOutcomes.shift() ?? 'succeeded';
    if (outcome === 'error') throw new Error('Stripe is unreachable');
    const known = this.refundByPayment.get(input.paymentId);
    if (known) return this.stripeRefunds.get(known)!;
    const refund = {
      id: `re_test_${++this.counter}`,
      payment_intent: input.paymentIntentId,
      amount: input.amountMinor,
      status: outcome,
      metadata: { paymentId: input.paymentId, refundId: input.refundId ?? '' },
      ...(outcome === 'failed' ? { failure_reason: 'expired_or_canceled_card' } : {}),
    };
    this.stripeRefunds.set(refund.id, refund);
    this.refundByPayment.set(input.paymentId, refund.id);
    return refund;
  }

  /** The Stripe refund created for a payment (by our payment id). */
  stripeRefundFor(paymentId: string) {
    const id = this.refundByPayment.get(paymentId);
    return id ? this.stripeRefunds.get(id) : undefined;
  }

  /** `refund.updated` (or `refund.failed`) for a refund Stripe created; it moves to `status`. */
  refundEvent(stripeRefundId: string, status: 'succeeded' | 'failed' | 'pending', options: { type?: 'refund.updated' | 'refund.failed'; eventId?: string } = {}) {
    const refund = this.stripeRefunds.get(stripeRefundId);
    if (!refund) throw new Error(`No such refund: ${stripeRefundId}`);
    refund.status = status;
    return {
      id: options.eventId ?? `evt_test_${++this.counter}`,
      object: 'event',
      type: options.type ?? (status === 'failed' ? 'refund.failed' : 'refund.updated'),
      data: { object: { ...refund, object: 'refund', ...(status === 'failed' ? { failure_reason: 'expired_or_canceled_card' } : {}) } },
    };
  }

  /** `charge.refunded` for the charge of a PaymentIntent. */
  chargeRefundedEvent(paymentIntentId: string, amountRefunded: number, stripeRefundId?: string) {
    return {
      id: `evt_test_${++this.counter}`,
      object: 'event',
      type: 'charge.refunded',
      data: { object: { id: `ch_test_${++this.counter}`, object: 'charge', payment_intent: paymentIntentId, amount_refunded: amountRefunded, refunds: { data: stripeRefundId ? [{ id: stripeRefundId }] : [] } } },
    };
  }

  /** The PaymentIntent id inside a client secret (`pi_xxx_secret_yyy`), as Stripe Elements would derive it. */
  intentIdFromSecret(clientSecret: string): string {
    return clientSecret.split('_secret_')[0];
  }

  /** Body of the webhook event that means "this PaymentIntent succeeded". Overrides model tampering or odd amounts. */
  succeededEvent(intentId: string, override: Partial<Pick<FakeIntent, 'amount' | 'currency'>> & { eventId?: string } = {}) {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error(`No such PaymentIntent: ${intentId}`);
    const amount = override.amount ?? intent.amount;
    return {
      id: override.eventId ?? `evt_test_${++this.counter}`,
      object: 'event',
      type: 'payment_intent.succeeded',
      data: { object: { id: intent.id, object: 'payment_intent', status: 'succeeded', amount, amount_received: amount, currency: override.currency ?? intent.currency, metadata: intent.metadata } },
    };
  }

  /** Body of the webhook event that means "this payment attempt failed" (the intent stays usable). */
  failedEvent(intentId: string, code = 'card_declined', eventId?: string) {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error(`No such PaymentIntent: ${intentId}`);
    return {
      id: eventId ?? `evt_test_${++this.counter}`,
      object: 'event',
      type: 'payment_intent.payment_failed',
      data: { object: { id: intent.id, object: 'payment_intent', status: 'requires_payment_method', amount: intent.amount, currency: intent.currency, metadata: intent.metadata, last_payment_error: { code } } },
    };
  }
}

export class FxFake {
  /** 1 unit of the key currency in USD. Unknown currencies get 1. */
  private readonly usd: Record<string, number> = { USD: 1, EUR: 1.1, EGP: 0.02, GBP: 1.3, AED: 0.27, SAR: 0.27, JPY: 0.0067 };

  async getRate(from: string, to: string) {
    const a = from.toUpperCase(), b = to.toUpperCase();
    return { from: a, to: b, rate: (this.usd[a] ?? 1) / (this.usd[b] ?? 1), stale: false };
  }

  async convert(amount: number, from: string, to: string) {
    const quote = await this.getRate(from, to);
    return { amount, from: quote.from, to: quote.to, rate: quote.rate, convertedAmount: Number((amount * quote.rate).toFixed(2)), stale: false };
  }
}
