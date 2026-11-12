import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { AuditLog, AuditLogDocument } from './schemas/audit-log.schema';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto';

export interface AuditEntry {
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

@Injectable()
export class AuditLogsService {
  constructor(
    @InjectModel(AuditLog.name)
    private readonly auditLogModel: Model<AuditLogDocument>,
  ) {}

  async record(entry: AuditEntry) {
    await this.auditLogModel.create({
      actorId: new Types.ObjectId(entry.actorId),
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      details: entry.details ?? {},
    });
  }

  async list(query: QueryAuditLogsDto) {
    const { action, actorId, targetType, from, to, page = 1, limit = 20 } = query;
    const filter: Record<string, any> = {};

    if (action) filter.action = action;
    if (actorId) filter.actorId = new Types.ObjectId(actorId);
    if (targetType) filter.targetType = targetType;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    const [items, total] = await Promise.all([
      this.auditLogModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.auditLogModel.countDocuments(filter),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}