import { jest } from '@jest/globals';
import { Types } from 'mongoose';
import { ReportsService } from './reports.service';
import { ReportStatus } from './schemas/report.schema';

describe('ReportsService', () => {
  const reporterId = new Types.ObjectId().toString();
  const adminId = new Types.ObjectId().toString();
  const reportId = new Types.ObjectId().toString();
  const postId = new Types.ObjectId().toString();
  let service: ReportsService;
  let reportModel: any;
  let postModel: any;
  let commentModel: any;
  let reviewModel: any;
  let itineraryModel: any;
  let blog: any;
  let audit: any;
  let duplicateSave = false;

  const execQuery = (result: any) => ({
    select: () => ({ exec: async () => result }),
    exec: async () => result,
  });
  const reportDoc = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(reportId),
    reporterId: new Types.ObjectId(reporterId),
    targetType: 'post',
    targetId: new Types.ObjectId(postId),
    reason: 'Spam',
    status: ReportStatus.OPEN,
    save: jest.fn(async function (this: any) {
      return this;
    }),
    ...overrides,
  });

  beforeEach(() => {
    duplicateSave = false;
    const ReportConstructor: any = function (this: any, data: any) {
      Object.assign(this, data);
      this._id = new Types.ObjectId(reportId);
      this.status = ReportStatus.OPEN;
      this.createdAt = new Date('2099-01-01T00:00:00Z');
      this.save = jest.fn(async function (this: any) {
        if (duplicateSave) throw { code: 11000 };
        return this;
      });
    };
    ReportConstructor.findById = jest.fn(() => ({
      exec: async () => reportDoc(),
    }));
    ReportConstructor.find = jest.fn(() => ({
      sort: () => ({
        skip: () => ({
          limit: () => ({ lean: () => ({ exec: async () => [] }) }),
        }),
      }),
    }));
    ReportConstructor.countDocuments = jest.fn(() => ({ exec: async () => 0 }));
    reportModel = ReportConstructor;
    postModel = {
      findOne: jest.fn(() => execQuery({ _id: new Types.ObjectId(postId) })),
    };
    commentModel = { findOne: jest.fn(() => execQuery(null)) };
    reviewModel = {
      findOne: jest.fn(() => execQuery(null)),
      findByIdAndUpdate: jest.fn(() => execQuery({})),
      findByIdAndDelete: jest.fn(() => execQuery({})),
    };
    itineraryModel = {
      findOne: jest.fn(() => execQuery(null)),
      findOneAndUpdate: jest.fn(() => execQuery({})),
      findByIdAndDelete: jest.fn(() => execQuery({})),
    };
    blog = {
      moderatePost: jest.fn(async () => ({ status: 'hidden' })),
      moderateComment: jest.fn(async () => ({ status: 'hidden' })),
    };
    audit = { record: jest.fn(async () => undefined) };
    service = new ReportsService(
      reportModel as never,
      postModel as never,
      commentModel as never,
      reviewModel as never,
      itineraryModel as never,
      blog as never,
      audit as never,
      { refreshRating: jest.fn(async () => undefined) } as never,
    );
  });

  it('creates a report only for an existing published post', async () => {
    await expect(
      service.createReport(reporterId, {
        targetType: 'post',
        targetId: postId,
        reason: 'Spam',
      } as any),
    ).resolves.toMatchObject({
      report: { targetType: 'post', targetId: postId, status: 'open' },
    });
    expect(postModel.findOne).toHaveBeenCalledWith({
      _id: postId,
      status: 'published',
    });
  });

  it('rejects reports for unavailable targets', async () => {
    postModel.findOne.mockImplementation(() => execQuery(null));
    await expect(
      service.createReport(reporterId, {
        targetType: 'post',
        targetId: postId,
        reason: 'Spam',
      } as any),
    ).rejects.toThrow('not found or unavailable');
  });

  it('converts a duplicate reporter/target index conflict to HTTP 409', async () => {
    duplicateSave = true;
    await expect(
      service.createReport(reporterId, {
        targetType: 'post',
        targetId: postId,
        reason: 'Repeated',
      } as any),
    ).rejects.toThrow('already reported');
  });

  it('lists reports with pagination', async () => {
    const result = await service.listReports(ReportStatus.OPEN, 2, 10);
    expect(result).toEqual({
      items: [],
      page: 2,
      limit: 10,
      total: 0,
      pages: 0,
    });
    expect(reportModel.find).toHaveBeenCalledWith({
      status: ReportStatus.OPEN,
    });
  });

  it('hides reported content and records moderator and action', async () => {
    const report: any = reportDoc();
    reportModel.findById.mockImplementation(() => ({
      exec: async () => report,
    }));
    await expect(
      service.moderateReport(adminId, reportId, {
        action: 'hide',
        note: 'Reviewed',
      }),
    ).resolves.toMatchObject({
      id: reportId,
      status: ReportStatus.RESOLVED,
      action: 'hide',
    });
    expect(blog.moderatePost).toHaveBeenCalledWith(
      postId,
      'hide',
      adminId,
      reportId,
    );
    expect(report.moderatedBy).toEqual(new Types.ObjectId(adminId));
    expect(report.moderationNote).toBe('Reviewed');
    expect(audit.record).toHaveBeenCalledWith(
      adminId,
      'community.report.resolved',
      'report',
      reportId,
      expect.objectContaining({ action: 'hide' }),
    );
  });

  it('dismisses reports without modifying their content', async () => {
    const report = reportDoc();
    reportModel.findById.mockImplementation(() => ({
      exec: async () => report,
    }));
    await service.moderateReport(adminId, reportId, { action: 'dismiss' });
    expect(blog.moderatePost).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      adminId,
      'community.report.dismissed',
      'report',
      reportId,
      expect.any(Object),
    );
  });
});
