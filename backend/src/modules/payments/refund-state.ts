import { PaymentStatus } from './enums/payment-status.enum';
import { RefundRecordStatus } from './schemas/refund.schema';

/**
 * PAY-03 refund state machine (pure):
 *   Pending -> Refunded   (Stripe refund `succeeded`)
 *   Pending -> Failed     (Stripe refund `failed` or `canceled`)
 *   Pending -> Pending    (Stripe `pending` / `requires_action`: wait for the webhook)
 * Refunded and Failed are final: no later event moves them, and a failed refund is never retried
 * automatically (Stripe would replay the same failed refund for the same idempotency key).
 */
export function refundStatusFromStripe(stripeStatus: string | null | undefined): RefundRecordStatus {
  if (stripeStatus === 'succeeded') return RefundRecordStatus.REFUNDED;
  if (stripeStatus === 'failed' || stripeStatus === 'canceled') return RefundRecordStatus.FAILED;
  return RefundRecordStatus.PENDING;
}

export function isFinalRefundStatus(status: RefundRecordStatus): boolean {
  return status !== RefundRecordStatus.PENDING;
}

/** The status to move to, or null when nothing changes. */
export function nextRefundStatus(current: RefundRecordStatus, incoming: RefundRecordStatus): RefundRecordStatus | null {
  if (isFinalRefundStatus(current) || incoming === RefundRecordStatus.PENDING) return null;
  return incoming;
}

/** The payment status that mirrors a refund. */
export function paymentStatusForRefund(status: RefundRecordStatus, refundMinor: number, paidMinor: number): PaymentStatus {
  if (status === RefundRecordStatus.REFUNDED) {
    return refundMinor >= paidMinor ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
  }
  if (status === RefundRecordStatus.FAILED) return PaymentStatus.REFUND_FAILED;
  return PaymentStatus.REFUND_PENDING;
}

/** The refund for a percentage of what was paid: rounded, and never more than was paid. */
export function refundAmountFor(paidMinor: number, percentage: number): number {
  if (!Number.isFinite(paidMinor) || paidMinor <= 0 || !Number.isFinite(percentage)) return 0;
  const pct = Math.min(100, Math.max(0, percentage));
  return Math.min(paidMinor, Math.round((paidMinor * pct) / 100));
}
