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

  /**
   * PAY-01: the card is collected by Stripe Elements in the browser, so card data never reaches us.
   * Metadata carries ids only. The idempotency key makes a repeated call return the same intent.
   */
  async createPaymentIntent(input: {
    paymentId: string;
    bookingType: string;
    bookingId: string;
    userId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
  }): Promise<Stripe.PaymentIntent> {
    return this.getClient().paymentIntents.create(
      {
        amount: input.amountMinor,
        currency: input.currency.toLowerCase(),
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: {
          paymentId: input.paymentId,
          bookingType: input.bookingType,
          bookingId: input.bookingId,
          userId: input.userId,
        },
      },
      { idempotencyKey: input.idempotencyKey },
    );
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    return this.getClient().paymentIntents.retrieve(paymentIntentId);
  }

  /** Test-mode helper only (see PaymentsService.testConfirm). */
  async confirmPaymentIntent(
    paymentIntentId: string,
    paymentMethod: string,
  ): Promise<Stripe.PaymentIntent> {
    return this.getClient().paymentIntents.confirm(paymentIntentId, {
      payment_method: paymentMethod,
    });
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

  async cancelPaymentIntent(
    paymentIntentId: string,
  ): Promise<Stripe.PaymentIntent> {
    return this.getClient().paymentIntents.cancel(paymentIntentId);
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
