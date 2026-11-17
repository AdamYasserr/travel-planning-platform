import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import { BOOKING_STATUS } from '../../../common/booking/booking-status';
import { PageQueryDto } from '../../../common/pagination/pagination';

const STATUSES = Object.values(BOOKING_STATUS) as string[];

export class FlightBookingsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: string;
}
