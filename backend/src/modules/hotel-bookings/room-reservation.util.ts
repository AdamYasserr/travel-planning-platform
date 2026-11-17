import { HotelBookingStatus } from './schemas/hotel-booking.schema';

/** Reservations that currently occupy a room: Confirmed, or Pending Payment with an unexpired hold. */
export function activeReservationClause(now: Date) {
  return [
    { status: HotelBookingStatus.CONFIRMED },
    { status: HotelBookingStatus.PENDING_PAYMENT, holdExpiresAt: { $gt: now } },
    { status: HotelBookingStatus.PENDING_PAYMENT, holdExpiresAt: null },
  ];
}
