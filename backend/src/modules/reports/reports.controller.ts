import {
  Body,
  Delete,
  Get,
  Controller,
  Param,
  Post,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { CreateReportDto } from './dto/create-report.dto';
import { ReportsService } from './reports.service';
import {
  AdminReportQueryDto,
  ModerateReportDto,
} from './dto/create-report.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { ReportStatus } from './schemas/report.schema';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    role: string;
  };
}

type AdminRequest = Request & { user: { userId: string } };

@Controller('admin')
@ApiTags('Community Moderation')
@ApiCookieAuth('access_token')
@Roles(UserRole.ADMIN)
export class AdminCommunityController {
  constructor(private readonly reports: ReportsService) {}

  @Get('reports')
  @ApiOperation({
    summary: 'List content reports for administrator review (GEN-09/10)',
  })
  listReports(@Query() query: AdminReportQueryDto) {
    return this.reports.listReports(
      query.status as ReportStatus | undefined,
      query.page,
      query.limit,
    );
  }

  @Patch('reports/:id')
  @ApiOperation({
    summary: 'Dismiss a report or hide/delete its post or comment (GEN-10)',
  })
  moderateReport(
    @Param('id') id: string,
    @Body() dto: ModerateReportDto,
    @Req() req: AdminRequest,
  ) {
    return this.reports.moderateReport(req.user.userId, id, dto);
  }

  @Delete('content/:type/:id')
  @ApiOperation({ summary: 'Soft-delete a community post or comment (GEN-10)' })
  deleteContent(
    @Param('type') type: string,
    @Param('id') id: string,
    @Req() req: AdminRequest,
  ) {
    return this.reports.deleteContent(req.user.userId, type, id);
  }
}

@Controller('reports')
@ApiTags('Reports')
@ApiCookieAuth('access_token')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a report about supported content' })
  @ApiBody({ type: CreateReportDto })
  @ApiResponse({ status: 201, description: 'Report submitted successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid report target or input.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({
    status: 409,
    description: 'The authenticated user already reported this target.',
  })
  createReport(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateReportDto,
  ) {
    return this.reportsService.createReport(request.user.userId, dto);
  }
}
