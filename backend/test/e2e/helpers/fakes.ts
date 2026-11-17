/**
 * The ONLY places that know Stripe details (event types, payload shapes, which call creates a payment).
 * When payments move from Checkout Sessions to PaymentIntents, change StripeFake and
 * confirmBooking() in bookings.ts; the tests should not need to change.
 */
export interface FakeCheckoutInput {
  paymentId: string;
  bookingType: string;
  bookingId: string;
  userId: string;
  amountMinor: number;
  currency: string;
}

export class StripeFake {
  /** What the fake "Stripe" has seen, for assertions. */
  readonly created: FakeCheckoutInput[] = [];
  readonly expiredSessions: string[] = [];
  readonly cancelledIntents: string[] = [];
  readonly refunds: { paymentIntentId: string; amountMinor: number; paymentId: string }[] = [];
  private counter = 0;

  /** Signature value the fake accepts; anything else is rejected like a bad signature. */
  static readonly VALID_SIGNATURE = 'valid';

  async createCheckoutSession(input: FakeCheckoutInput) {
    this.created.push(input);
    const id = `cs_test_${++this.counter}_${input.paymentId}`;
    return { id, url: `https://checkout.stripe.test/${id}` };
  }

  constructWebhookEvent(payload: Buffer, signature: string) {
    if (signature !== StripeFake.VALID_SIGNATURE) throw new Error('No signatures found matching the expected signature');
    return JSON.parse(payload.toString('utf8'));
  }

  async expireCheckoutSession(sessionId: string) {
    this.expiredSessions.push(sessionId);
    return { id: sessionId, status: 'expired' };
  }

  async cancelPaymentIntent(paymentIntentId: string) {
    this.cancelledIntents.push(paymentIntentId);
    return { id: paymentIntentId, status: 'canceled' };
  }

  async createRefund(input: { paymentIntentId: string; amountMinor: number; paymentId: string }) {
    this.refunds.push({ paymentIntentId: input.paymentIntentId, amountMinor: input.amountMinor, paymentId: input.paymentId });
    return { id: `re_test_${++this.counter}`, status: 'succeeded' };
  }

  /** Body of the webhook event that means "this payment succeeded". */
  successEvent(payment: { paymentId: string; checkoutSessionId: string; bookingType: string; bookingId: string; userId: string; amountMinor: number; currency: string }) {
    return {
      id: `evt_test_${++this.counter}`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: payment.checkoutSessionId,
          object: 'checkout.session',
          mode: 'payment',
          payment_status: 'paid',
          payment_intent: `pi_test_${payment.paymentId}`,
          amount_total: payment.amountMinor,
          currency: payment.currency,
          metadata: {
            paymentId: payment.paymentId,
            bookingType: payment.bookingType,
            bookingId: payment.bookingId,
            userId: payment.userId,
          },
        },
      },
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
