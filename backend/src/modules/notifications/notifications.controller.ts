import { Controller, Get, Param, Patch, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { NotificationsService } from './notifications.service';
class NotificationQueryDto {
  @Type(() => Number) @IsInt() @Min(1) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 10;
}
type AuthRequest = Request & { user: { userId: string } };
@Controller('notifications')
@ApiTags('Notifications')
@ApiCookieAuth('access_token')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}
  @Get()
  @ApiOperation({ summary: 'List the authenticated user’s in-app notifications', description: 'Newest first, 10 per page by default (GEN-05); `limit` up to 100.' })
  list(@Req() req: AuthRequest, @Query() query: NotificationQueryDto) {
    return this.notifications.listForUser(req.user.userId, query.page, query.limit);
  }
  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all of the authenticated user’s notifications as read' })
  markAllRead(@Req() req: AuthRequest) {
    return this.notifications.markAllRead(req.user.userId);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one of the authenticated user’s notifications as read' })
  markRead(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.notifications.markRead(req.user.userId, id);
  }

}
