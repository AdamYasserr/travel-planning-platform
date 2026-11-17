import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { NotificationType } from './enums/notification-type.enum';
import { NotificationPayload, renderNotification } from './notification-templates';
import { Notification, NotificationDocument } from './schemas/notification.schema';

/** A notification decided inside a transaction, delivered after its commit. */
export interface PendingNotification {
  userId: string;
  type: NotificationType;
  payload: NotificationPayload;
}

/** Payload keys that point at the resource the notification is about, in order of preference. */
const RESOURCE_KEYS: [string, string][] = [
  ['refundId', 'refund'],
  ['bookingId', 'booking'],
  ['flightId', 'flight'],
  ['providerId', 'provider'],
];

/**
 * GEN-01: the ONE way to notify users. Best effort: it is called after the business change has been
 * committed and never throws, so a lost notification can never undo (or block) a booking or a refund.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(@InjectModel(Notification.name) private readonly notifications: Model<NotificationDocument>) {}

  async notify(userId: string, type: NotificationType, payload: NotificationPayload = {}): Promise<void> {
    await this.notifyMany([userId], type, payload);
  }

  async notifyMany(userIds: string[], type: NotificationType, payload: NotificationPayload = {}): Promise<number> {
    const ids = [...new Set(userIds.map(String).filter((id) => Types.ObjectId.isValid(id)))];
    if (!ids.length) return 0;
    const { title, message } = renderNotification(type, payload);
    const resource = this.resourceOf(payload);
    try {
      const inserted = await this.notifications.insertMany(
        ids.map((id) => ({ userId: new Types.ObjectId(id), type, title, message, payload, ...resource })),
        { ordered: false },
      );
      return inserted.length;
    } catch (error) {
      this.logger.error(`Could not store ${type} notification for ${ids.length} user(s): ${(error as Error).message}`);
      return 0;
    }
  }

  /** Delivers notifications collected during a committed transaction, in order. */
  async deliver(notes: PendingNotification[]): Promise<void> {
    for (const note of notes) await this.notify(note.userId, note.type, note.payload);
  }

  async listForUser(userId: string, page = 1, limit = 10) {
    const owner = new Types.ObjectId(userId);
    const [items, total, unread] = await Promise.all([
      this.notifications.find({ userId: owner }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.notifications.countDocuments({ userId: owner }).exec(),
      this.notifications.countDocuments({ userId: owner, isRead: false }).exec(),
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

  async markAllRead(userId: string) {
    const result = await this.notifications
      .updateMany({ userId: new Types.ObjectId(userId), isRead: false }, { $set: { isRead: true } })
      .exec();
    return { updated: result.modifiedCount };
  }

  private resourceOf(payload: NotificationPayload) {
    const providerType = typeof payload.providerType === 'string' ? payload.providerType : null;
    for (const [key, type] of RESOURCE_KEYS) {
      const value = payload[key];
      if (typeof value === 'string' && Types.ObjectId.isValid(value)) {
        return { resourceType: key === 'providerId' && providerType ? providerType : type, resourceId: new Types.ObjectId(value) };
      }
    }
    return {};
  }
}
