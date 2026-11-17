import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { Types } from 'mongoose';

import { UserRole } from '../../common/enums/user-role.enum';
import { StripeService } from '../../integrations/stripe/stripe.service';
import { nextRefundStatus, paymentStatusForRefund, refundAmountFor, refundStatusFromStripe } from './refund-state';
import { Payment } from './schemas/payment.schema';
import { Refund, RefundDocument, RefundReason, RefundRecordStatus } from './schemas/refund.schema';

const STRIPE_LEASE_MS = 60_000;
const RETRY_BATCH_SIZE = 100;

/** A refund that reached a final state, for the caller to notify the user about after its commit. */
export interface RefundOutcome {
  refundId: string;
  userId: string;
  paymentId: string;
  bookingType: string;
  bookingId: string;
  status: RefundRecordStatus;
  amountMinor: number;
  currency: string;
}

type PaymentRef = Pick<Payment, 'userId' | 'bookingType' | 'bookingId' | 'currency' | 'amountMinor' | 'status'> & {
  _id: Types.ObjectId;
  refundId?: Types.ObjectId | null;
};

/**
 * PAY-03. One Refund record per payment (unique `paymentId`), created inside the caller's transaction.
 * The Stripe Refunds API is called AFTER that commit, on the original PaymentIntent, with the idempotency
 * key `refund-<paymentId>`; a short lease on the record keeps two concurrent callers (e.g. two job runs)
 * from calling Stripe for the same refund. Stripe webhooks then move it to Refunded or Failed (final).
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @InjectModel(Refund.name) private readonly refundModel: Model<Refund>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    private readonly stripe: StripeService,
  ) {}

  /**
   * Opens the refund of a payment inside the caller's transaction (idempotent: an existing refund
   * for the payment is returned unchanged). Amount = percentage of `paidMinor`, never more than it.
   * Returns null when there is nothing to refund (0%).
   */
  async createInTransaction(
    payment: PaymentRef,
    input: { paidMinor: number; percentage: number; reason: RefundReason },
    session: ClientSession,
  ): Promise<RefundDocument | null> {
    const existing = await this.refundModel.findOne({ paymentId: payment._id }).session(session).exec();
    if (existing) return existing;
    const amountMinor = refundAmountFor(input.paidMinor, input.percentage);
    if (amountMinor <= 0) return null;
    const [refund] = await this.refundModel.create(
      [
        {
          paymentId: payment._id,
          userId: payment.userId,
          bookingType: payment.bookingType,
          bookingId: payment.bookingId,
          amountMinor,
          currency: payment.currency.toLowerCase(),
          percentage: input.percentage,
          reason: input.reason,
          status: RefundRecordStatus.PENDING,
        },
      ],
      { session },
    );
    await this.paymentModel
      .updateOne({ _id: payment._id }, { $set: { refundId: refund._id, status: paymentStatusForRefund(RefundRecordStatus.PENDING, amountMinor, input.paidMinor) } }, { session })
      .exec();
    payment.refundId = refund._id;
    payment.status = paymentStatusForRefund(RefundRecordStatus.PENDING, amountMinor, input.paidMinor);
    return refund;
  }

  /**
   * Asks Stripe for the refund. Safe to call twice at once: only the caller that takes the lease calls
   * Stripe, and only for a Pending refund Stripe has not accepted yet. A Stripe error leaves it Pending
   * for the retry job. Returns the outcome when the refund reached a final state.
   */
  async process(refundId: Types.ObjectId | string): Promise<RefundOutcome | null> {
    const now = new Date();
    const claimed = await this.refundModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(String(refundId)),
          status: RefundRecordStatus.PENDING,
          stripeRefundId: { $exists: false },
          $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
        },
        { $set: { lockedUntil: new Date(now.getTime() + STRIPE_LEASE_MS) } },
        { new: true },
      )
      .exec();
    if (!claimed) return null;

    const payment = await this.paymentModel.findById(claimed.paymentId).lean().exec();
    if (!payment?.stripePaymentIntentId) {
      return this.finish(claimed, RefundRecordStatus.FAILED, { failureCode: 'missing_payment_intent' });
    }
    try {
      const stripeRefund = await this.stripe.createRefund({
        paymentIntentId: payment.stripePaymentIntentId,
        amountMinor: claimed.amountMinor,
        paymentId: String(claimed.paymentId),
        refundId: String(claimed._id),
        reason: claimed.reason,
      });
      const status = refundStatusFromStripe(stripeRefund.status);
      return this.finish(claimed, status, {
        stripeRefundId: stripeRefund.id,
        failureCode: status === RefundRecordStatus.FAILED ? (stripeRefund.failure_reason ?? 'refund_failed') : null,
      });
    } catch {
      this.logger.warn(`Stripe refund request for refund ${String(claimed._id)} failed; it stays Pending for the retry job`);
      await this.refundModel
        .updateOne({ _id: claimed._id }, { $set: { lockedUntil: null, failureCode: 'stripe_refund_request_failed' } })
        .exec();
      return null;
    }
  }

  /** Processes the open refund of a payment, if any (after a webhook or a cancellation commit). */
  async processForPayment(paymentId: Types.ObjectId | string): Promise<RefundOutcome | null> {
    const refund = await this.refundModel
      .findOne({ paymentId: new Types.ObjectId(String(paymentId)), status: RefundRecordStatus.PENDING, stripeRefundId: { $exists: false } })
      .select({ _id: 1 })
      .lean()
      .exec();
    return refund ? this.process(refund._id) : null;
  }

  /** Job body: refunds Stripe never accepted (request failed or the process stopped). */
  async retryPending(): Promise<RefundOutcome[]> {
    const now = new Date();
    const due = await this.refundModel
      .find({
        status: RefundRecordStatus.PENDING,
        stripeRefundId: { $exists: false },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
      })
      .select({ _id: 1 })
      .limit(RETRY_BATCH_SIZE)
      .lean()
      .exec();
    const outcomes: RefundOutcome[] = [];
    for (const refund of due) {
      const outcome = await this.process(refund._id);
      if (outcome) outcomes.push(outcome);
    }
    return outcomes;
  }

  /** Webhook `refund.updated` / `refund.failed`, inside the webhook transaction. */
  async applyStripeRefund(stripeRefund: Record<string, any>, paymentId: Types.ObjectId, session: ClientSession): Promise<RefundOutcome | null> {
    if (typeof stripeRefund.id !== 'string') return null;
    const refund = await this.refundModel.findOne({ paymentId }).session(session).exec();
    if (!refund) return null;
    if (refund.stripeRefundId && refund.stripeRefundId !== stripeRefund.id) {
      this.logger.error(`Ignored Stripe refund ${stripeRefund.id}: refund ${String(refund._id)} belongs to ${refund.stripeRefundId}`);
      return null;
    }
    const status = refundStatusFromStripe(stripeRefund.status);
    return this.finish(refund, status, {
      stripeRefundId: stripeRefund.id,
      failureCode: status === RefundRecordStatus.FAILED ? (stripeRefund.failure_reason ?? 'refund_failed') : null,
      session,
    });
  }

  /** Webhook `charge.refunded`: Refunded once Stripe has refunded at least the refund amount. */
  async applyChargeRefunded(charge: Record<string, any>, paymentId: Types.ObjectId, session: ClientSession): Promise<RefundOutcome | null> {
    const refund = await this.refundModel.findOne({ paymentId }).session(session).exec();
    if (!refund) return null;
    const refunded = Number(charge.amount_refunded);
    if (!Number.isFinite(refunded) || refunded < refund.amountMinor) return null;
    const stripeRefundId = refund.stripeRefundId ?? (typeof charge.refunds?.data?.[0]?.id === 'string' ? charge.refunds.data[0].id : undefined);
    return this.finish(refund, RefundRecordStatus.REFUNDED, { stripeRefundId, session });
  }

  /** GET /refunds/:id: the owner, or an admin. Anyone else gets 404 (existence is not revealed). */
  async getForViewer(viewer: { userId: string; role?: string }, refundId: string) {
    if (!Types.ObjectId.isValid(refundId)) throw new BadRequestException('Invalid refund ID');
    const refund = await this.refundModel.findById(refundId).lean().exec();
    if (!refund || (viewer.role !== UserRole.ADMIN && String(refund.userId) !== viewer.userId)) {
      throw new NotFoundException('Refund not found');
    }
    return this.view(refund);
  }

  /** The refund of a payment, for GET /payments/:id and the cancellation response. */
  async findForPayment(paymentId: Types.ObjectId | string) {
    return this.refundModel.findOne({ paymentId: new Types.ObjectId(String(paymentId)) }).lean().exec();
  }

  view(refund: Refund & { _id: Types.ObjectId }) {
    return {
      id: String(refund._id),
      refundId: String(refund._id),
      paymentId: String(refund.paymentId),
      bookingType: refund.bookingType,
      bookingId: String(refund.bookingId),
      status: refund.status,
      reason: refund.reason,
      percentage: refund.percentage,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
      failureCode: refund.failureCode ?? null,
      createdAt: refund.createdAt,
      refundedAt: refund.refundedAt ?? null,
      failedAt: refund.failedAt ?? null,
    };
  }

  /** Records a Stripe answer; moves Pending to a final state at most once and mirrors it on the payment. */
  private async finish(
    refund: RefundDocument,
    status: RefundRecordStatus,
    extra: { stripeRefundId?: string; failureCode?: string | null; session?: ClientSession },
  ): Promise<RefundOutcome | null> {
    const next = nextRefundStatus(refund.status, status);
    const now = new Date();
    const set: Record<string, unknown> = { lockedUntil: null };
    if (extra.stripeRefundId && !refund.stripeRefundId) set.stripeRefundId = extra.stripeRefundId;
    if (next) {
      set.status = next;
      if (next === RefundRecordStatus.REFUNDED) set.refundedAt = now;
      if (next === RefundRecordStatus.FAILED) {
        set.failedAt = now;
        set.failureCode = extra.failureCode ?? 'refund_failed';
      }
    }
    const opts = extra.session ? { session: extra.session, new: true } : { new: true };
    const updated = await this.refundModel
      .findOneAndUpdate({ _id: refund._id, status: RefundRecordStatus.PENDING }, { $set: set }, opts)
      .exec();
    if (!updated || !next) return null;

    const payment = await this.paymentModel.findById(updated.paymentId).session(extra.session ?? null).lean().exec();
    if (payment) {
      await this.paymentModel
        .updateOne(
          { _id: payment._id },
          { $set: { status: paymentStatusForRefund(next, updated.amountMinor, payment.amountMinor) } },
          extra.session ? { session: extra.session } : {},
        )
        .exec();
    }
    if (next === RefundRecordStatus.FAILED) {
      this.logger.error(`Refund ${String(updated._id)} of payment ${String(updated.paymentId)} failed (${String(set.failureCode)}); manual handling in the Stripe dashboard`);
    }
    return {
      refundId: String(updated._id),
      userId: String(updated.userId),
      paymentId: String(updated.paymentId),
      bookingType: updated.bookingType,
      bookingId: String(updated.bookingId),
      status: next,
      amountMinor: updated.amountMinor,
      currency: updated.currency,
    };
  }
}
