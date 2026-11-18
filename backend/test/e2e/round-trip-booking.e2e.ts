import { PaymentsService } from '../../src/modules/payments/payments.service';
import { startApp, type E2EContext } from './helpers/app';
import { confirmBooking, holdFlight } from './helpers/bookings';
import { createAirlineWithFlight, createUser, day } from './helpers/factories';
import { seedReference } from './helpers/reference';

/**
 * Round-trip booking (FLT-12 / FLT-19), passenger details and infant rules (FLT-19), extra baggage (FLT-08),
 * and the departure copy kept on bookings when a flight is rescheduled.
 */
describe('round-trip booking, passengers, extra baggage and rescheduling (FLT-12, FLT-19, FLT-08)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await startApp();
    await seedReference(ctx);
  });
  afterAll(() => ctx.close());

  const model = (name: string) => ctx.conn.model(name);
  const payments = () => ctx.get(PaymentsService);
  const bookingOf = async (id: string) => (await model('FlightBooking').findById(id).lean()) as any;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  describe('rescheduling a flight updates the departure copy on its bookings', () => {
    async function confirmedOn(flightId: string) {
      const user = await createUser(ctx);
      const hold = await holdFlight(user, { flightId });
      if (hold.status !== 201) throw new Error(`hold failed: ${hold.status} ${JSON.stringify(hold.body)}`);
      await confirmBooking(ctx, user, 'flight', hold.body._id);
      return { user, bookingId: String(hold.body._id) };
    }
    const reschedule = (f: { moderator: any; flightId: string }, depart: Date) =>
      f.moderator.agent.patch(`/api/flights/${f.flightId}`).send({
        departureTime: depart.toISOString(),
        arrivalTime: new Date(depart.getTime() + 4 * 3_600_000).toISOString(),
      });

    it('copies the new departure onto Pending and Confirmed bookings, but not onto final ones', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 6, departInDays: 30 });
      const confirmed = await confirmedOn(f.flightId);
      const pending = await holdFlight(await createUser(ctx), { flightId: f.flightId });
      const cancelled = await confirmedOn(f.flightId);
      await model('FlightBooking').updateOne({ _id: cancelled.bookingId }, { $set: { status: 'Cancelled' } });

      const depart = new Date(`${day(31)}T09:15:00.000Z`);
      expect((await reschedule(f, depart)).status).toBe(200);
      expect((await bookingOf(confirmed.bookingId)).departureTime).toEqual(depart);
      expect((await bookingOf(pending.body._id)).departureTime).toEqual(depart);
      expect((await bookingOf(cancelled.bookingId)).departureTime).toEqual(new Date(`${day(30)}T08:00:00.000Z`));
    });

    it('a rescheduled flight cannot be cancelled after its NEW departure', async () => {
      const f = await createAirlineWithFlight(ctx, { seats: 4, departInDays: 30 });
      const { user, bookingId } = await confirmedOn(f.flightId);
      expect((await reschedule(f, new Date(Date.now() + 2_500))).status).toBe(200);
      await sleep(3_000);
      const res = await user.agent.post(`/api/flight-bookings/${bookingId}/cancel`);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/after departure/);
    });

    it('completes at the NEW departure: not early when moved later, not late when moved earlier', async () => {
      const later = await createAirlineWithFlight(ctx, { seats: 4, departInDays: 40 });
      const earlier = await createAirlineWithFlight(ctx, { seats: 4, departInDays: 40 });
      const a = await confirmedOn(later.flightId);
      const b = await confirmedOn(earlier.flightId);
      const laterDepart = new Date(`${day(41)}T08:00:00.000Z`);
      const earlierDepart = new Date(`${day(39)}T08:00:00.000Z`);
      expect((await reschedule(later, laterDepart)).status).toBe(200);
      expect((await reschedule(earlier, earlierDepart)).status).toBe(200);

      await payments().completeFinishedBookings(new Date(earlierDepart.getTime() + 60_000));
      expect((await bookingOf(b.bookingId)).status).toBe('Completed');
      expect((await bookingOf(a.bookingId)).status).toBe('Confirmed');

      await payments().completeFinishedBookings(new Date(`${day(40)}T09:00:00.000Z`));
      expect((await bookingOf(a.bookingId)).status).toBe('Confirmed');

      await payments().completeFinishedBookings(new Date(laterDepart.getTime() + 60_000));
      expect((await bookingOf(a.bookingId)).status).toBe('Completed');
    });
  });
});
