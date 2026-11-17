import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditLog, AuditLogDocument } from './schemas/audit-log.schema';

@Injectable()
export class AuditLogsService {
  constructor(
    @InjectModel(AuditLog.name) private readonly logs: Model<AuditLogDocument>,
  ) {}

  async record(
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    details: Record<string, unknown> = {},
  ) {
    await this.logs.create({
      actorId: new Types.ObjectId(actorId),
      action,
      targetType,
      targetId: new Types.ObjectId(targetId),
      details,
    });
  }

  async list(query: {
    page?: number;
    limit?: number;
    action?: string;
    targetType?: string;
  }) {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 20)));
    const filter: Record<string, string> = {};
    if (query.action) filter.action = query.action;
    if (query.targetType) filter.targetType = query.targetType;
    const [items, total] = await Promise.all([
      this.logs
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.logs.countDocuments(filter).exec(),
    ]);
    return { items, page, limit, total, pages: Math.ceil(total / limit) };
  }
}
