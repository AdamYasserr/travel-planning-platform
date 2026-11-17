import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { CreateReportDto } from './dto/create-report.dto';
import { Report, ReportDocument } from './schemas/report.schema';
import { Post } from '../blog/schemas/post.schema';
import { Comment } from '../blog/schemas/comment.schema';
import { Review } from '../hotels/schemas/review.schema';
import { HotelsService } from '../hotels/hotels.service';
import { Itinerary } from '../itineraries/schemas/itinerary.schema';
import { BlogService } from '../blog/blog.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ModerateReportDto } from './dto/create-report.dto';
import { ReportModerationAction, ReportStatus } from './schemas/report.schema';
import { CommentStatus, PostStatus } from '../blog/enums/post-status.enum';
import { ItineraryVisibility } from '../itineraries/enums/itinerary-visibility.enum';

@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(Report.name)
    private readonly reportModel: Model<ReportDocument>,
    @InjectModel(Post.name) private readonly postModel: Model<any>,
    @InjectModel(Comment.name) private readonly commentModel: Model<any>,
    @InjectModel(Review.name) private readonly reviewModel: Model<any>,
    @InjectModel(Itinerary.name) private readonly itineraryModel: Model<any>,
    private readonly blog: BlogService,
    private readonly auditLogs: AuditLogsService,
    private readonly hotels: HotelsService,
  ) {}

  async createReport(reporterId: string, dto: CreateReportDto) {
    if (
      !Types.ObjectId.isValid(reporterId) ||
      !Types.ObjectId.isValid(dto.targetId)
    ) {
      throw new BadRequestException('Invalid report target');
    }

    const report = new this.reportModel({
      reporterId: new Types.ObjectId(reporterId),
      targetType: dto.targetType,
      targetId: new Types.ObjectId(dto.targetId),
      reason: dto.reason,
    });

    await this.assertTargetExists(dto.targetType, dto.targetId);

    try {
      await report.save();
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 11000
      ) {
        throw new ConflictException('You have already reported this item');
      }

      throw new InternalServerErrorException('Could not submit report');
    }

    return {
      message: 'Report submitted successfully',
      report: {
        id: report._id.toString(),
        targetType: report.targetType,
        targetId: report.targetId.toString(),
        status: report.status,
        createdAt: report.createdAt,
      },
    };
  }

  async listReports(status?: ReportStatus, page = 1, limit = 10) {
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const filter = status ? { status } : {};
    const [items, total] = await Promise.all([
      this.reportModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .lean()
        .exec(),
      this.reportModel.countDocuments(filter).exec(),
    ]);
    return {
      items,
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit),
    };
  }

  async moderateReport(
    actorId: string,
    reportId: string,
    dto: ModerateReportDto,
  ) {
    if (!Types.ObjectId.isValid(reportId))
      throw new BadRequestException('Invalid report ID');
    const report = await this.reportModel.findById(reportId).exec();
    if (!report) throw new NotFoundException('Report not found');
    if (report.status !== ReportStatus.OPEN)
      throw new ConflictException('Report has already been reviewed');

    if (dto.action !== 'dismiss') {
      await this.moderateTarget(
        report.targetType,
        report.targetId.toString(),
        dto.action,
        actorId,
        reportId,
      );
    }

    report.status = ReportStatus.RESOLVED;
    report.moderatedBy = new Types.ObjectId(actorId);
    report.moderatedAt = new Date();
    report.moderationAction = dto.action as ReportModerationAction;
    report.moderationNote = dto.note ?? '';
    await report.save();
    if (dto.action === 'dismiss') {
      await this.auditLogs.record(
        actorId,
        'community.report.dismissed',
        'report',
        reportId,
        {
          targetType: report.targetType,
          targetId: report.targetId.toString(),
          note: dto.note ?? '',
        },
      );
    } else {
      await this.auditLogs.record(
        actorId,
        'community.report.resolved',
        'report',
        reportId,
        {
          action: dto.action,
          targetType: report.targetType,
          targetId: report.targetId.toString(),
          note: dto.note ?? '',
        },
      );
    }
    return {
      id: reportId,
      status: report.status,
      action: report.moderationAction,
      moderatedAt: report.moderatedAt,
    };
  }

  async deleteContent(actorId: string, targetType: string, targetId: string) {
    if (!['post', 'comment', 'review', 'itinerary'].includes(targetType)) {
      throw new BadRequestException('Unsupported content type');
    }
    await this.moderateTarget(targetType, targetId, 'delete', actorId);
    return { id: targetId, targetType, deleted: true };
  }

  private async moderateTarget(
    targetType: string,
    targetId: string,
    action: 'hide' | 'delete',
    actorId: string,
    reportId?: string,
  ) {
    if (!Types.ObjectId.isValid(targetId))
      throw new BadRequestException('Invalid content ID');
    if (targetType === 'post')
      return this.blog.moderatePost(targetId, action, actorId, reportId);
    if (targetType === 'comment')
      return this.blog.moderateComment(targetId, action, actorId, reportId);

    const targetObjectId = new Types.ObjectId(targetId);
    if (targetType === 'review') {
      const target =
        action === 'hide'
          ? await this.reviewModel
              .findByIdAndUpdate(
                targetObjectId,
                { $set: { isHidden: true } },
                { new: true },
              )
              .exec()
          : await this.reviewModel.findByIdAndDelete(targetObjectId).exec();
      if (!target) throw new NotFoundException('Review not found');
      // HTL-23: a hidden or deleted review no longer counts towards the hotel's rating.
      await this.hotels.refreshRating(target.hotelId);
      await this.auditLogs.record(
        actorId,
        `community.review.${action === 'hide' ? 'hidden' : 'deleted'}`,
        'review',
        targetId,
        reportId ? { reportId } : {},
      );
      return { id: targetId, status: action === 'hide' ? 'hidden' : 'deleted' };
    }

    if (targetType === 'itinerary') {
      const target =
        action === 'hide'
          ? await this.itineraryModel
              .findOneAndUpdate(
                { _id: targetObjectId, visibility: ItineraryVisibility.PUBLIC },
                { $set: { visibility: ItineraryVisibility.PRIVATE } },
                { new: true },
              )
              .exec()
          : await this.itineraryModel.findByIdAndDelete(targetObjectId).exec();
      if (!target) throw new NotFoundException('Public itinerary not found');
      await this.auditLogs.record(
        actorId,
        `community.itinerary.${action === 'hide' ? 'hidden' : 'deleted'}`,
        'itinerary',
        targetId,
        reportId ? { reportId } : {},
      );
      return { id: targetId, status: action === 'hide' ? 'hidden' : 'deleted' };
    }

    throw new BadRequestException('Unsupported content type');
  }

  private async assertTargetExists(targetType: string, targetId: string) {
    let target: unknown = null;
    if (targetType === 'post') {
      target = await this.postModel
        .findOne({ _id: targetId, status: PostStatus.PUBLISHED })
        .select('_id')
        .exec();
    } else if (targetType === 'comment') {
      const comment = await this.commentModel
        .findOne({ _id: targetId, status: CommentStatus.VISIBLE })
        .select('postId')
        .exec();
      if (comment)
        target = await this.postModel
          .findOne({ _id: comment.postId, status: PostStatus.PUBLISHED })
          .select('_id')
          .exec();
    } else if (targetType === 'review') {
      target = await this.reviewModel
        .findOne({ _id: targetId, isHidden: { $ne: true } })
        .select('_id')
        .exec();
    } else if (targetType === 'itinerary') {
      target = await this.itineraryModel
        .findOne({ _id: targetId, visibility: ItineraryVisibility.PUBLIC })
        .select('_id')
        .exec();
    }
    if (!target)
      throw new NotFoundException('Report target not found or unavailable');
  }
}
