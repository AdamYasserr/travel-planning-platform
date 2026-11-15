import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { FlightBookingsService } from './flight-bookings.service';

// FLT-22 / GEN-11: Flight booking lifecycle job (separate from hotel expiry).
@Injectable()
export class FlightBookingExpiryService {
  private readonly logger = new Logger(FlightBookingExpiryService.name);
  private running = false;

  constructor(private readonly bookingsService: FlightBookingsService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    // Skip if the previous run in this process is still going. Correctness
    // across processes comes from the status-guarded updates, not this flag.
    if (this.running) return;
    this.running = true;

    try {
      const now = new Date();

      // Pending Payment with holdExpiresAt <= now -> Expired, seats back once
      const expired = await this.bookingsService.expireDueHolds(now);

      // Confirmed -> Completed once the outbound departure time has passed
      const completed =
        await this.bookingsService.completeDepartedBookings(now);

      if (expired > 0 || completed > 0) {
        this.logger.log(
          `Flight bookings: ${expired} hold(s) expired, ${completed} completed`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Flight booking lifecycle job failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }
}
