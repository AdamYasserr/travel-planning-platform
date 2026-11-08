import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { CreateReportDto } from './dto/create-report.dto';
import { Report, ReportDocument } from './schemas/report.schema';

@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(Report.name)
    private readonly reportModel: Model<ReportDocument>,
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

    try {
      await report.save();
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 11000
      ) {
        throw new ConflictException(
          'You have already reported this item',
        );
      }

      throw new InternalServerErrorException(
        'Could not submit report',
      );
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
}
