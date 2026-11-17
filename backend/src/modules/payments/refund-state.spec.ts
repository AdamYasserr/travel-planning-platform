import { PaymentStatus } from './enums/payment-status.enum';
import { isFinalRefundStatus, nextRefundStatus, paymentStatusForRefund, refundAmountFor, refundStatusFromStripe } from './refund-state';
import { RefundRecordStatus as S } from './schemas/refund.schema';

describe('refund state machine (PAY-03)', () => {
  it.each([
    ['succeeded', S.REFUNDED],
    ['failed', S.FAILED],
    ['canceled', S.FAILED],
    ['pending', S.PENDING],
    ['requires_action', S.PENDING],
    [undefined, S.PENDING],
  ])('Stripe %p maps to %s', (stripe, expected) => {
    expect(refundStatusFromStripe(stripe as string | undefined)).toBe(expected);
  });

  it('Refunded and Failed are final; Pending is not', () => {
    expect(isFinalRefundStatus(S.PENDING)).toBe(false);
    expect(isFinalRefundStatus(S.REFUNDED)).toBe(true);
    expect(isFinalRefundStatus(S.FAILED)).toBe(true);
  });

  it('only Pending moves, and only to a final state', () => {
    expect(nextRefundStatus(S.PENDING, S.REFUNDED)).toBe(S.REFUNDED);
    expect(nextRefundStatus(S.PENDING, S.FAILED)).toBe(S.FAILED);
    expect(nextRefundStatus(S.PENDING, S.PENDING)).toBeNull();
    expect(nextRefundStatus(S.REFUNDED, S.FAILED)).toBeNull();
    expect(nextRefundStatus(S.FAILED, S.REFUNDED)).toBeNull();
  });

  it('mirrors the refund on the payment', () => {
    expect(paymentStatusForRefund(S.REFUNDED, 1000, 1000)).toBe(PaymentStatus.REFUNDED);
    expect(paymentStatusForRefund(S.REFUNDED, 500, 1000)).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    expect(paymentStatusForRefund(S.FAILED, 500, 1000)).toBe(PaymentStatus.REFUND_FAILED);
    expect(paymentStatusForRefund(S.PENDING, 500, 1000)).toBe(PaymentStatus.REFUND_PENDING);
  });

  it('never refunds more than was paid', () => {
    expect(refundAmountFor(1000, 50)).toBe(500);
    expect(refundAmountFor(1000, 100)).toBe(1000);
    expect(refundAmountFor(1000, 150)).toBe(1000);
    expect(refundAmountFor(1000, -5)).toBe(0);
    expect(refundAmountFor(999, 50)).toBe(500);
    expect(refundAmountFor(0, 100)).toBe(0);
    expect(refundAmountFor(1000, Number.NaN)).toBe(0);
  });
});
