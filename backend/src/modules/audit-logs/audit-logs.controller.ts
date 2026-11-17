import { Controller, Get, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';
import { AuditLogsService } from './audit-logs.service';

@Controller('admin/audit-logs')
@ApiTags('Audit Logs')
@ApiCookieAuth('access_token')
@Roles(UserRole.ADMIN)
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Review administrative and community moderation audit records (GEN-07)',
  })
  list(@Query() query: AuditLogQueryDto) {
    return this.auditLogs.list(query);
  }
}
