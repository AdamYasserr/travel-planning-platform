import { Inject, Injectable, forwardRef } from '@nestjs/common';

import { PaymentsService } from '../../payments/payments.service';

// FLT-23 / FLT-26 / PAY-01 / PAY-03: The flight booking flow talks to payments
// only through this interface. Flight bookings never call hotel payment
// methods.

export const FLIGHT_PAYMENTS_PORT = Symbol('FLIGHT_PAYMENTS_PORT');

export interface FlightPaymentVerification {
  succeeded: boolean;
  // Stripe PaymentIntent ID
  paymentId?: string;
}

export interface FlightRefundResult {
  status: 'Refunded' | 'Pending' | 'Failed';
  refundId?: string;
}

// PAY-01 / PAY-03: What the booking shows about its payment (no secrets)
export interface FlightPaymentSummary {
  paymentIntentId: string;
  status: string;
  amount: number;
  currency: string;
  refundStatus: string | null;
  refundId: string | null;
}

export interface FlightPaymentsPort {
  // True only when a Payment for this booking is Succeeded (verified by the
  // signed Stripe webhook).
  confirmPayment(bookingId: string): Promise<FlightPaymentVerification>;

  // Creates (or reuses) a Stripe refund. Throws if Stripe cannot be reached.
  refund(bookingId: string, amount: number): Promise<FlightRefundResult>;

  // Cancels open PaymentIntents of a booking whose hold expired.
  cancelPendingPayments(bookingId: string): Promise<void>;

  getPaymentSummary(bookingId: string): Promise<FlightPaymentSummary | null>;
}

// Stripe-backed implementation through the shared PaymentsService.
@Injectable()
export class StripeFlightPaymentsAdapter implements FlightPaymentsPort {
  constructor(
    // PaymentsModule and FlightBookingsModule reference each other
    @Inject(forwardRef(() => PaymentsService))
    private readonly paymentsService: PaymentsService,
  ) {}

  confirmPayment(bookingId: string): Promise<FlightPaymentVerification> {
    return this.paymentsService.verifyFlightPayment(bookingId);
  }

  refund(bookingId: string, amount: number): Promise<FlightRefundResult> {
    return this.paymentsService.refundFlightPayment(bookingId, amount);
  }

  cancelPendingPayments(bookingId: string): Promise<void> {
    return this.paymentsService.cancelFlightPaymentIntents(bookingId);
  }

  getPaymentSummary(bookingId: string): Promise<FlightPaymentSummary | null> {
    return this.paymentsService.getFlightPaymentSummary(bookingId);
  }
}
