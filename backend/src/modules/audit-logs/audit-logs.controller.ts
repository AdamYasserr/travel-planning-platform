import { Controller, Get, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AuditLogsService } from './audit-logs.service';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';

@Controller('admin/audit-logs')
@Roles(UserRole.ADMIN)
@ApiTags('Audit Logs')
@ApiCookieAuth('access_token')
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  @Get()
  @ApiOperation({ summary: 'List audit log entries with filtering and pagination' })
  @ApiResponse({ status: 200, description: 'Paginated audit log entries.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 403, description: 'Administrator role is required.' })
  list(@Query() query: QueryAuditLogsDto) {
    return this.auditLogsService.list(query);
  }
}