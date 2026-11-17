import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private readonly stripe: Stripe | null;

  constructor(private readonly configService: ConfigService) {
    const secretKey = this.configService.get<string>('stripe.secretKey');
    this.stripe = secretKey ? new Stripe(secretKey) : null;
  }

  async createCheckoutSession(input: {
    paymentId: string;
    bookingType: string;
    bookingId: string;
    userId: string;
    productName: string;
    amountMinor: number;
    currency: string;
  }): Promise<Stripe.Checkout.Session> {
    const stripe = this.getClient();
    const successUrl = this.configService.get<string>(
      'stripe.checkoutSuccessUrl',
    );
    const cancelUrl = this.configService.get<string>(
      'stripe.checkoutCancelUrl',
    );
    if (!successUrl || !cancelUrl) {
      throw new ServiceUnavailableException(
        'Stripe Checkout return URLs are not configured',
      );
    }

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        client_reference_id: input.paymentId,
        success_url: `${successUrl}${successUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl,
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.amountMinor,
              product_data: { name: input.productName },
            },
          },
        ],
        metadata: {
          paymentId: input.paymentId,
          bookingType: input.bookingType,
          bookingId: input.bookingId,
          userId: input.userId,
        },
        payment_intent_data: {
          metadata: {
            paymentId: input.paymentId,
            bookingType: input.bookingType,
            bookingId: input.bookingId,
            userId: input.userId,
          },
        },
      },
      { idempotencyKey: `checkout-${input.paymentId}` },
    );

    if (!session.url) {
      throw new ServiceUnavailableException(
        'Stripe did not return a Checkout URL',
      );
    }
    return session;
  }

  constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
    const stripe = this.getClient();
    const webhookSecret = this.configService.get<string>(
      'stripe.webhookSecret',
    );
    if (!webhookSecret) {
      throw new ServiceUnavailableException(
        'Stripe webhook signing secret is not configured',
      );
    }
    return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  }

  async expireCheckoutSession(
    sessionId: string,
  ): Promise<Stripe.Checkout.Session> {
    return this.getClient().checkout.sessions.expire(sessionId);
  }

  async createRefund(input: {
    paymentIntentId: string;
    amountMinor: number;
    paymentId: string;
    reason: string;
  }): Promise<Stripe.Refund> {
    return this.getClient().refunds.create(
      {
        payment_intent: input.paymentIntentId,
        amount: input.amountMinor,
        reason: 'requested_by_customer',
        metadata: {
          paymentId: input.paymentId,
          reason: input.reason,
        },
      },
      { idempotencyKey: `refund-${input.paymentId}` },
    );
  }

  private getClient(): Stripe {
    if (!this.stripe) {
      throw new ServiceUnavailableException(
        'Stripe is not configured for this environment',
      );
    }
    return this.stripe;
  }
}
