import type { INestApplicationContext } from '@nestjs/common';

import { StripeService } from '../../../integrations/stripe/stripe.service';

/**
 * The demo seed never calls Stripe. It replaces the methods of the app's StripeService with these
 * local ones, so a seeded payment follows the real payment code (PaymentIntent, signed-webhook handling,
 * refund) without any network call. The ids start with `pi_seed_` / `re_seed_`: they do not exist in Stripe.
 */
export class LocalStripe {
  async createPaymentIntent(input: {
    paymentId: string;
    bookingType: string;
    bookingId: string;
    userId: string;
    amountMinor: number;
    currency: string;
  }) {
    return this.intent(`pi_seed_${input.paymentId}`, input.amountMinor, input.currency, {
      paymentId: input.paymentId,
      bookingType: input.bookingType,
      bookingId: input.bookingId,
      userId: input.userId,
    });
  }

  async retrievePaymentIntent(id: string) {
    return this.intent(id, 0, 'usd', {});
  }

  async cancelPaymentIntent(id: string) {
    return { id, status: 'canceled' };
  }

  async createRefund(input: { paymentIntentId: string; amountMinor: number; paymentId: string; refundId: string }) {
    return {
      id: `re_seed_${input.paymentId}`,
      payment_intent: input.paymentIntentId,
      amount: input.amountMinor,
      status: 'succeeded',
      metadata: { paymentId: input.paymentId, refundId: input.refundId },
    };
  }

  /** The "signature" is not checked: the payload comes from this process. */
  constructWebhookEvent(payload: Buffer) {
    return JSON.parse(payload.toString('utf8'));
  }

  async confirmPaymentIntent(): Promise<never> {
    throw new Error('The demo seed never confirms a card payment');
  }

  private intent(id: string, amount: number, currency: string, metadata: Record<string, string>) {
    return {
      id,
      status: 'requires_payment_method',
      amount,
      currency: currency.toLowerCase(),
      client_secret: `${id}_secret_seed`,
      metadata,
    };
  }
}

/** Replaces the Stripe calls of the running app context. Returns the local replacement. */
export function installLocalStripe(app: INestApplicationContext): LocalStripe {
  const stripe = app.get(StripeService, { strict: false }) as unknown as Record<string, unknown>;
  const local = new LocalStripe();
  for (const method of ['createPaymentIntent', 'retrievePaymentIntent', 'cancelPaymentIntent', 'createRefund', 'constructWebhookEvent', 'confirmPaymentIntent'] as const) {
    stripe[method] = (local[method] as (...args: never[]) => unknown).bind(local);
  }
  return local;
}

/** Body of Stripe's `payment_intent.succeeded` webhook for a payment of the seed. */
export function succeededEvent(payment: {
  _id: unknown;
  stripePaymentIntentId?: string;
  amountMinor: number;
  currency: string;
  bookingType: string;
  bookingId: unknown;
  userId: unknown;
}) {
  const intentId = payment.stripePaymentIntentId as string;
  return {
    id: `evt_seed_${String(payment._id)}`,
    object: 'event',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: intentId,
        object: 'payment_intent',
        status: 'succeeded',
        amount: payment.amountMinor,
        amount_received: payment.amountMinor,
        currency: payment.currency,
        metadata: {
          paymentId: String(payment._id),
          bookingType: payment.bookingType,
          bookingId: String(payment.bookingId),
          userId: String(payment.userId),
        },
      },
    },
  };
}
