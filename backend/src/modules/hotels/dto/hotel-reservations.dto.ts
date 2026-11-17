import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import { BOOKING_STATUS } from '../../../common/booking/booking-status';
import { PageQueryDto } from '../../../common/pagination/pagination';
import { IsCalendarDate } from '../../../common/validators/calendar-date.decorator';

const STATUSES = Object.values(BOOKING_STATUS) as string[];

/** HTL-22: a hotel's reservations. `from`/`to` keep stays that overlap the range (both days included). */
export class HotelReservationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: string;

  @ApiPropertyOptional({ example: '2026-12-01', description: 'YYYY-MM-DD: stays still in the hotel on or after this day' })
  @IsOptional()
  @IsCalendarDate()
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31', description: 'YYYY-MM-DD: stays that start on or before this day' })
  @IsOptional()
  @IsCalendarDate()
  to?: string;
}
