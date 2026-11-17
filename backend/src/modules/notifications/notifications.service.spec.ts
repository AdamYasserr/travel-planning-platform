import { jest } from '@jest/globals';
import { Types } from 'mongoose';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  it('lists a user inbox with unread count and pagination', async () => {
    const notifications: any = {
      find: (jest.fn as any)().mockReturnValue({ sort: (jest.fn as any)().mockReturnValue({ skip: (jest.fn as any)().mockReturnValue({ limit: (jest.fn as any)().mockReturnValue({ lean: (jest.fn as any)().mockReturnValue({ exec: (jest.fn as any)().mockResolvedValue([{ title: 'notice' }]) }) }) }) }) }),
      countDocuments: (jest.fn as any)().mockReturnValueOnce({ exec: (jest.fn as any)().mockResolvedValue(1) }).mockReturnValueOnce({ exec: (jest.fn as any)().mockResolvedValue(1) }),
      findOneAndUpdate: (jest.fn as any)(),
    };
    const service = new NotificationsService(notifications);
    const result = await service.listForUser(new Types.ObjectId().toString());
    expect(result).toMatchObject({ total: 1, unread: 1, page: 1, limit: 20 });
  });

  it('only marks a notification belonging to the requesting user as read', async () => {
    const notification = { _id: new Types.ObjectId(), isRead: true };
    const exec = (jest.fn as any)().mockResolvedValue(notification);
    const notifications: any = { findOneAndUpdate: (jest.fn as any)().mockReturnValue({ lean: (jest.fn as any)().mockReturnValue({ exec }) }) };
    const service = new NotificationsService(notifications);
    const userId = new Types.ObjectId().toString();
    await service.markRead(userId, notification._id.toString());
    expect(notifications.findOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({ userId: expect.any(Types.ObjectId) }), { $set: { isRead: true } }, { new: true });
  });
});
