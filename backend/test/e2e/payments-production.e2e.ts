import { startApp, type E2EContext } from './helpers/app';
import { holdHotel, startPayment } from './helpers/bookings';
import { createHotelWithRooms, createUser } from './helpers/factories';
import { seedReference } from './helpers/reference';

/** Its own file: the app here boots with NODE_ENV=production (the process env is per test file). */
describe('POST /payments/:id/test-confirm in production', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await startApp({ nodeEnv: 'production' });
    await seedReference(ctx);
  });
  afterAll(() => ctx.close());

  it('does not exist (404), even with a test key and for the owner of the payment', async () => {
    const { hotelId, roomIds } = await createHotelWithRooms(ctx, { rooms: 1 });
    const user = await createUser(ctx);
    const hold = await holdHotel(user, { hotelId, roomIds });
    const pay = await startPayment(user, 'hotel', hold.body._id);
    expect(pay.status).toBe(201);

    const res = await user.agent.post(`/api/payments/${pay.body.paymentId}/test-confirm`);
    expect(res.status).toBe(404);
    expect(ctx.stripe.confirmations).toHaveLength(0);
  });
});
