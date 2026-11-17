import { Controller, Get, Param, Req, StreamableFile } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { ETicketService } from './e-ticket.service';

type AuthenticatedRequest = Request & { user: { userId: string; role?: string } };

@ApiTags('Flight Bookings')
@ApiCookieAuth('access_token')
// FLT-23: main path GET /bookings/:id/e-ticket; GET /flight-bookings/:id/e-ticket is an alias (same handler).
@Controller(['bookings', 'flight-bookings'])
export class ETicketController {
  constructor(private readonly tickets: ETicketService) {}

  @Get(':id/e-ticket')
  @ApiProduces('application/pdf')
  @ApiOperation({
    summary: 'Download the e-ticket PDF of a flight booking (owner or admin)',
    description:
      'FLT-23. Also served at GET /flight-bookings/:id/e-ticket (alias, identical behaviour). Booking reference, passengers, flight number, airline, airports with local times, cabin, baggage and total paid. Only for a Confirmed or Completed flight booking (409 otherwise). Hotel booking ids and other users\' bookings are 404.',
  })
  @ApiResponse({ status: 200, description: 'application/pdf, sent as an attachment' })
  async download(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    const { filename, pdf } = await this.tickets.render(request.user, id);
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: `attachment; filename="${filename}"`, length: pdf.length });
  }
}
