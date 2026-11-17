import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Notification, NotificationDocument } from './schemas/notification.schema';
@Injectable()
export class NotificationsService {
  constructor(@InjectModel(Notification.name) private readonly notifications: Model<NotificationDocument>) {}
  async createForUsers(userIds: string[], data: { title: string; message: string; resourceType?: string; resourceId?: string }) {
    const ids = [...new Set(userIds.filter((id) => Types.ObjectId.isValid(id)))];
    if (!ids.length) return { acknowledged: true, insertedCount: 0 };
    const result = await this.notifications.insertMany(ids.map((id) => ({ userId: new Types.ObjectId(id), ...data, ...(data.resourceId ? { resourceId: new Types.ObjectId(data.resourceId) } : {}) })), { ordered: false });
    return { acknowledged: true, insertedCount: result.length };
  }
  async listForUser(userId: string, page = 1, limit = 20) {
    const [items, total, unread] = await Promise.all([
      this.notifications.find({ userId: new Types.ObjectId(userId) }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.notifications.countDocuments({ userId: new Types.ObjectId(userId) }).exec(),
      this.notifications.countDocuments({ userId: new Types.ObjectId(userId), isRead: false }).exec(),
    ]);
    return { items, page, limit, total, unread, pages: Math.ceil(total / limit) };
  }
  async markRead(userId: string, notificationId: string) {
    if (!Types.ObjectId.isValid(notificationId)) throw new BadRequestException('Invalid notification ID');
    const notification = await this.notifications.findOneAndUpdate(
      { _id: new Types.ObjectId(notificationId), userId: new Types.ObjectId(userId) },
      { $set: { isRead: true } },
      { new: true },
    ).lean().exec();
    if (!notification) throw new NotFoundException('Notification not found');
    return notification;
  }

}
