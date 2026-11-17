import { Injectable, Logger } from '@nestjs/common';

// FLT-23 / FLT-26 / PAY-01 / PAY-03: The flight booking flow talks to payments
// only through this interface, so the Stripe integration can be plugged in
// later without changing booking logic. Flight bookings never call hotel
// payment methods.

export const FLIGHT_PAYMENTS_PORT = Symbol('FLIGHT_PAYMENTS_PORT');

export interface FlightPaymentVerification {
  succeeded: boolean;
  paymentId?: string;
}

export interface FlightRefundResult {
  status: 'Processed' | 'Pending';
  refundId?: string;
}

export interface FlightPaymentsPort {
  // Must return succeeded: true only after the payment provider has verified
  // a successful payment for this booking.
  confirmPayment(bookingId: string): Promise<FlightPaymentVerification>;

  refund(bookingId: string, amount: number): Promise<FlightRefundResult>;
}

// Placeholder until the PaymentsModule supports flights. It FAILS CLOSED:
// no payment is ever reported as verified, so no booking can be confirmed
// without a real payment.
@Injectable()
export class PendingFlightPaymentsAdapter implements FlightPaymentsPort {
  private readonly logger = new Logger(PendingFlightPaymentsAdapter.name);

  async confirmPayment(bookingId: string): Promise<FlightPaymentVerification> {
    // TODO(PAY-01): Replace with a call to the Stripe-backed PaymentsModule
    // (verify the PaymentIntent for this flight booking in Stripe test mode).
    this.logger.warn(
      `Flight payments are not integrated yet; booking ${bookingId} not verified`,
    );
    return { succeeded: false };
  }

  async refund(bookingId: string, amount: number): Promise<FlightRefundResult> {
    // TODO(PAY-03): Replace with a Stripe refund through the PaymentsModule.
    // Until then the refund stays Pending on the booking.
    this.logger.warn(
      `Flight refunds are not integrated yet; refund of ${amount} for booking ${bookingId} left Pending`,
    );
    return { status: 'Pending' };
  }
}
