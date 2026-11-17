import { jest } from '@jest/globals';
import { Types } from 'mongoose';

import { NotificationType } from './enums/notification-type.enum';
import { renderNotification } from './notification-templates';
import { NotificationsService } from './notifications.service';

describe('GEN-01 notifications', () => {
  it.each(Object.values(NotificationType))('%s has a title and a message', (type) => {
    const { title, message } = renderNotification(type, { bookingType: 'flight', amountMinor: 12345, currency: 'egp', refundPercentage: 50 });
    expect(title.length).toBeGreaterThan(0);
    expect(message.length).toBeGreaterThan(0);
  });

  it('shows money from minor units with the currency', () => {
    expect(renderNotification(NotificationType.REFUND_REFUNDED, { bookingType: 'hotel', amountMinor: 450000, currency: 'egp' }).message).toContain('4500.00 EGP');
  });

  it('notify stores one notification per distinct valid user, with the type, payload and resource', async () => {
    const insertMany = jest.fn(async (docs: unknown[]) => docs);
    const service = new NotificationsService({ insertMany } as never);
    const user = new Types.ObjectId().toString();
    const bookingId = new Types.ObjectId().toString();
    const count = await service.notifyMany([user, user, 'not-an-id'], NotificationType.BOOKING_CONFIRMED, { bookingType: 'hotel', bookingId });
    expect(count).toBe(1);
    const [[docs]] = insertMany.mock.calls as unknown as [[Record<string, unknown>[]]];
    expect(docs[0]).toMatchObject({ type: 'booking_confirmed', title: 'Booking confirmed', resourceType: 'booking', payload: { bookingType: 'hotel', bookingId } });
  });

  it('never throws: a storage failure is logged and swallowed', async () => {
    const service = new NotificationsService({ insertMany: jest.fn(async () => { throw new Error('db down'); }) } as never);
    await expect(service.notify(new Types.ObjectId().toString(), NotificationType.ACCOUNT_SUSPENDED)).resolves.toBeUndefined();
  });
});
