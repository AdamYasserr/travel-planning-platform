export enum PaymentStatus {
  PENDING = 'Pending',
  SUCCEEDED = 'Succeeded',
  FAILED = 'Failed',
  EXPIRED = 'Expired',
  REFUND_PENDING = 'Refund Pending',
  REFUNDED = 'Refunded',
  PARTIALLY_REFUNDED = 'Partially Refunded',
  REFUND_FAILED = 'Refund Failed',
}

export enum PaymentBookingType {
  HOTEL = 'hotel',
  FLIGHT = 'flight',
}
