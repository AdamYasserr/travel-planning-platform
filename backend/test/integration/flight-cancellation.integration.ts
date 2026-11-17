import { jest } from '@jest/globals';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Connection, Types } from 'mongoose';

import { FlightBooking, FlightBookingSchema } from '../../src/modules/flight-bookings/schemas/flight-booking.schema';
import { FlightBookingStatus } from '../../src/modules/flight-bookings/enums/flight-booking-status.enum';
import { CabinInventory, CabinInventorySchema } from '../../src/modules/flights/schemas/cabin-inventory.schema';
import { Flight, FlightSchema, FlightStatus } from '../../src/modules/flights/schemas/flight.schema';
import { HotelBooking, HotelBookingSchema } from '../../src/modules/hotel-bookings/schemas/hotel-booking.schema';
import { PaymentStatus } from '../../src/modules/payments/enums/payment-status.enum';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { RefundsService } from '../../src/modules/payments/refunds.service';
import { Payment, PaymentSchema, StripeWebhookEvent, StripeWebhookEventSchema } from '../../src/modules/payments/schemas/payment.schema';
import { Refund, RefundSchema } from '../../src/modules/payments/schemas/refund.schema';

/** FLT-06 is all or nothing: a failure part-way leaves the flight, bookings, seats, payments and refunds untouched. */
describe('flight cancellation is atomic (FLT-06) on a real replica set', () => {
  let replSet: MongoMemoryReplSet;
  let conn: Connection;
  let flightModel: any, bookingModel: any, inventoryModel: any, paymentModel: any, refundModel: any;
  let refunds: RefundsService;
  let payments: PaymentsService;
  const stripe = { createRefund: jest.fn(async (input: any) => ({ id: `re_${input.refundId}`, status: 'succeeded' })), cancelPaymentIntent: jest.fn(async () => undefined) };

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    conn = await mongoose.createConnection(replSet.getUri()).asPromise();
    flightModel = conn.model(Flight.name, FlightSchema);
    bookingModel = conn.model(FlightBooking.name, FlightBookingSchema);
    inventoryModel = conn.model(CabinInventory.name, CabinInventorySchema);
    paymentModel = conn.model(Payment.name, PaymentSchema);
    refundModel = conn.model(Refund.name, RefundSchema);
    const hotelBookingModel = conn.model(HotelBooking.name, HotelBookingSchema);
    const webhookModel = conn.model(StripeWebhookEvent.name, StripeWebhookEventSchema);
    for (const m of [flightModel, bookingModel, inventoryModel, paymentModel, refundModel, hotelBookingModel, webhookModel]) {
      await m.createCollection();
      await m.createIndexes();
    }
    const notifications = { deliver: jest.fn(async () => undefined), notify: jest.fn(async () => undefined) };
    refunds = new RefundsService(refundModel, paymentModel, stripe as never, notifications as never);
    payments = new PaymentsService(paymentModel, webhookModel, hotelBookingModel, bookingModel, inventoryModel, conn as never, stripe as never, { code: 'EGP' } as never, { get: () => undefined } as never, refunds, notifications as never);
  });

  afterAll(async () => {
    await conn?.close();
    await replSet?.stop();
  });

  async function seed() {
    const flight = await flightModel.create({
      flightNumber: `XY${Math.floor(Math.random() * 9000) + 1000}`, airlineId: new Types.ObjectId(), departureAirport: 'CAI', arrivalAirport: 'DXB',
      departureTime: new Date(Date.now() + 30 * 86_400_000), arrivalTime: new Date(Date.now() + 30 * 86_400_000 + 4 * 3_600_000), status: FlightStatus.SCHEDULED,
    });
    const inventory = await inventoryModel.create({ flightId: flight._id, cabinClass: 'Economy', totalSeats: 10, availableSeats: 7, price: 100, currency: 'EGP', freeBagsCount: 1, maxWeightPerBagKg: 23 });
    const bookingIds: Types.ObjectId[] = [];
    for (let i = 0; i < 3; i++) {
      const userId = new Types.ObjectId();
      const booking = await bookingModel.create({
        userId, flightId: flight._id, departureTime: flight.departureTime, cabinInventoryId: inventory._id, cabinClass: 'Economy',
        passengers: [{ fullName: `P ${i}`, dateOfBirth: new Date('1990-01-01') }], pricePerSeat: 100, totalPrice: 100, currency: 'EGP',
        status: FlightBookingStatus.CONFIRMED, holdExpiresAt: null, reference: `FLT-${new Types.ObjectId()}`, policiesAcceptedAt: new Date(),
      });
      await paymentModel.create({ userId, bookingType: 'flight', bookingId: booking._id, amountMinor: 10000, currency: 'egp', status: PaymentStatus.SUCCEEDED, holdExpiresAt: new Date(), stripePaymentIntentId: `pi_${booking._id}` });
      bookingIds.push(booking._id);
    }
    return { flight, inventory, bookingIds };
  }

  const markCancelled = (flightId: Types.ObjectId) => async (session: any) =>
    !!(await flightModel.findOneAndUpdate({ _id: flightId, status: FlightStatus.SCHEDULED }, { $set: { status: FlightStatus.CANCELLED } }, { session, new: true }).exec());

  it('a failure on the third booking rolls everything back', async () => {
    const { flight, inventory, bookingIds } = await seed();
    const original = refunds.createInTransaction.bind(refunds);
    let calls = 0;
    const spy = jest.spyOn(refunds, 'createInTransaction').mockImplementation(async (...args: Parameters<RefundsService['createInTransaction']>) => {
      if (++calls === 3) throw new Error('simulated failure part-way through');
      return original(...args);
    });

    await expect(payments.cancelFlight(flight._id, markCancelled(flight._id))).rejects.toThrow('simulated failure');
    spy.mockRestore();

    expect((await flightModel.findById(flight._id).lean()).status).toBe(FlightStatus.SCHEDULED);
    const bookings = await bookingModel.find({ _id: { $in: bookingIds } }).lean();
    expect(bookings.map((b: any) => b.status)).toEqual([FlightBookingStatus.CONFIRMED, FlightBookingStatus.CONFIRMED, FlightBookingStatus.CONFIRMED]);
    expect((await inventoryModel.findById(inventory._id).lean()).availableSeats).toBe(7);
    expect(await refundModel.countDocuments({ bookingId: { $in: bookingIds } })).toBe(0);
    const statuses = (await paymentModel.find({ bookingId: { $in: bookingIds } }).lean()).map((p: any) => p.status);
    expect(statuses).toEqual([PaymentStatus.SUCCEEDED, PaymentStatus.SUCCEEDED, PaymentStatus.SUCCEEDED]);
    expect(stripe.createRefund).not.toHaveBeenCalled();
  });

  it('without a failure, it commits all of it and refunds each booking once', async () => {
    const { flight, bookingIds } = await seed();
    const result = await payments.cancelFlight(flight._id, markCancelled(flight._id));
    expect(result.cancelledBookings).toHaveLength(3);
    expect((await flightModel.findById(flight._id).lean()).status).toBe(FlightStatus.CANCELLED);
    expect(await refundModel.countDocuments({ bookingId: { $in: bookingIds }, percentage: 100 })).toBe(3);
    await expect(payments.cancelFlight(flight._id, markCancelled(flight._id))).rejects.toThrow(/already cancelled/);
  });
  it('a payment can never have a second refund (PAY-03): opening it again returns the first one', async () => {
    const { bookingIds } = await seed();
    const payment = await paymentModel.findOne({ bookingId: bookingIds[0] }).exec();
    const open = async (percentage: number) => {
      const session = await conn.startSession();
      try {
        let id = '';
        await session.withTransaction(async () => {
          const refund = await refunds.createInTransaction(payment, { paidMinor: payment.amountMinor, percentage, reason: 'booking_cancelled' as never }, session);
          id = String(refund!._id);
        });
        return id;
      } finally {
        await session.endSession();
      }
    };
    const first = await open(100);
    const second = await open(50);
    expect(second).toBe(first);
    expect(await refundModel.countDocuments({ paymentId: payment._id })).toBe(1);
    expect((await refundModel.findById(first).lean()).amountMinor).toBe(10000);
  });
});
