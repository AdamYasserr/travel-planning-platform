import { jest } from '@jest/globals';
import { Types } from 'mongoose';
import { AuditLogsService } from './audit-logs.service';

describe('AuditLogsService', () => {
  const actorId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  let service: AuditLogsService;
  let model: any;

  beforeEach(() => {
    model = {
      create: jest.fn(async () => undefined),
      find: jest.fn(() => ({
        sort: () => ({
          skip: () => ({
            limit: () => ({ lean: () => ({ exec: async () => [] }) }),
          }),
        }),
      })),
      countDocuments: jest.fn(() => ({ exec: async () => 0 })),
    };
    service = new AuditLogsService(model as never);
  });

  it('records an actor, action, target, and details', async () => {
    await service.record(actorId, 'community.post.hidden', 'post', targetId, {
      reportId: targetId,
    });
    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: new Types.ObjectId(actorId),
        action: 'community.post.hidden',
        targetType: 'post',
        targetId: new Types.ObjectId(targetId),
        details: { reportId: targetId },
      }),
    );
  });

  it('returns newest-first paginated audit records with supplied filters', async () => {
    const result = await service.list({
      page: 2,
      limit: 10,
      action: 'community.post.hidden',
      targetType: 'post',
    });
    expect(result).toEqual({
      items: [],
      page: 2,
      limit: 10,
      total: 0,
      pages: 0,
    });
    expect(model.find).toHaveBeenCalledWith({
      action: 'community.post.hidden',
      targetType: 'post',
    });
  });
});
