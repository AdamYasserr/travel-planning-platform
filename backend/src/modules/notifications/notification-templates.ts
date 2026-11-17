import { NotificationType as T } from './enums/notification-type.enum';

/** Payload of a notification: ids, statuses, amounts and times only (never secrets or card data). */
export type NotificationPayload = Record<string, string | number | boolean | null | undefined>;

const money = (p: NotificationPayload) =>
  typeof p.amountMinor === 'number' && typeof p.currency === 'string'
    ? ` (${(p.amountMinor / 100).toFixed(2)} ${p.currency.toUpperCase()})`
    : '';
const booking = (p: NotificationPayload) => (p.bookingType === 'flight' ? 'flight booking' : p.bookingType === 'hotel' ? 'hotel booking' : 'booking');

/** GEN-01: the title and message shown for each event type. Pure, so it is unit-tested. */
export function renderNotification(type: T, p: NotificationPayload): { title: string; message: string } {
  switch (type) {
    case T.BOOKING_CONFIRMED:
      return { title: 'Booking confirmed', message: `Your payment was received and your ${booking(p)} is confirmed${money(p)}.` };
    case T.BOOKING_CANCELLED:
      return { title: 'Booking cancelled', message: `Your ${booking(p)} was cancelled. Refund: ${p.refundPercentage ?? 0}% of what you paid.` };
    case T.REFUND_CREATED:
      return { title: 'Refund started', message: `A refund${money(p)} for your ${booking(p)} has been started.` };
    case T.REFUND_REFUNDED:
      return { title: 'Refund completed', message: `Your refund${money(p)} for your ${booking(p)} has been completed.` };
    case T.REFUND_FAILED:
      return { title: 'Refund failed', message: `Your refund${money(p)} for your ${booking(p)} could not be completed. Our team will handle it; please contact support.` };
    case T.FLIGHT_SCHEDULE_CHANGED:
      return { title: 'Flight schedule changed', message: 'The departure or arrival time of your flight has changed. Please review your booking.' };
    case T.FLIGHT_CANCELLED:
      return { title: 'Flight cancelled', message: 'The airline cancelled your flight. Confirmed bookings are cancelled and refunded in full.' };
    case T.ACCOUNT_SUSPENDED:
      return { title: 'Account suspended', message: 'Your account has been suspended by an administrator.' };
    case T.ACCOUNT_REACTIVATED:
      return { title: 'Account reactivated', message: 'Your account has been reactivated. You can sign in again.' };
    case T.PROVIDER_SUSPENDED:
      return {
        title: 'Travel provider unavailable',
        message: 'A travel provider for one of your upcoming bookings is no longer accepting new bookings. Your existing reservation remains on file. Please review its details.',
      };
  }
}
