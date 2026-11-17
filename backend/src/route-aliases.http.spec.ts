import { jest } from '@jest/globals';
import {
  CanActivate, ExecutionContext, ForbiddenException, INestApplication, Injectable, NotFoundException, UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { IS_PUBLIC_KEY } from './common/decorators/public.decorator';
import { createValidationPipe } from './common/pipes/validation.pipe';
import { RolesGuard } from './common/guards/roles.guard';
import { StripeWebhookController } from './integrations/stripe/stripe-webhook.controller';
import { FlightBookingsController } from './modules/flight-bookings/flight-bookings.controller';
import { FlightBookingsService } from './modules/flight-bookings/flight-bookings.service';
import { HotelBookingsController } from './modules/hotel-bookings/hotel-bookings.controller';
import { HotelBookingsService } from './modules/hotel-bookings/hotel-bookings.service';
import { HotelsController } from './modules/hotels/hotels.controller';
import { HotelsService } from './modules/hotels/hotels.service';
import { HotelSearchService } from './modules/hotels/hotel-search.service';
import { ItinerariesController } from './modules/itineraries/itineraries.controller';
import { ItineraryItemsController } from './modules/itineraries/itinerary-items.controller';
import { ItinerariesService } from './modules/itineraries/itineraries.service';
import { PaymentsController } from './modules/payments/payments.controller';
import { RefundsController } from './modules/payments/refunds.controller';
import { PaymentsService } from './modules/payments/payments.service';
import { RefundsService } from './modules/payments/refunds.service';

/** Stands in for the real JWT guard: `x-test-user: <id>:<role>` authenticates, no header = 401. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest();
    const header = request.headers['x-test-user'] as string | undefined;
    if (!header) throw new UnauthorizedException();
    const [userId, role] = header.split(':');
    request.user = { userId, role, mustChangePassword: false };
    return true;
  }
}

const user = 'user-1:user';
const moderator = 'mod-1:moderator';
const mock = (names: string[]) => Object.fromEntries(names.map((n) => [n, jest.fn(async (..._args: unknown[]) => ({ method: n }))]));

describe('route aliases (PDF Section 8) behave exactly like the original routes', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const flightBookings = mock(['create', 'cancel', 'getForUser', 'listForUser']);
  const hotelBookings = mock(['create', 'cancel', 'getForUser', 'listForUser']);
  const itineraries = mock([
    'reorderDays', 'updateDay', 'addBudgetEntry', 'budgetSummary', 'updateActivityById', 'removeActivityById',
    'updateBudgetEntryById', 'removeBudgetEntryById', 'updateTransportCostById', 'removeTransportCostById',
    'updateActivity', 'removeActivity', 'updateBudgetEntry', 'removeBudgetEntry', 'updateTransportCost', 'removeTransportCost',
  ]);
  const payments = mock(['getForUser', 'handleStripeWebhook']);
  const refunds = mock(['getForViewer']);
  const hotels = mock(['update', 'getRoomStatuses']);
  const auth = mock(['changePassword']);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        FlightBookingsController, HotelBookingsController, ItinerariesController, ItineraryItemsController,
        PaymentsController, RefundsController, StripeWebhookController, HotelsController, AuthController,
      ],
      providers: [
        { provide: FlightBookingsService, useValue: flightBookings },
        { provide: HotelBookingsService, useValue: hotelBookings },
        { provide: ItinerariesService, useValue: itineraries },
        { provide: PaymentsService, useValue: payments },
        { provide: RefundsService, useValue: refunds },
        { provide: HotelsService, useValue: hotels },
        { provide: HotelSearchService, useValue: {} },
        { provide: AuthService, useValue: auth },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createValidationPipe());
    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(() => app?.close());
  beforeEach(() => {
    for (const group of [flightBookings, hotelBookings, itineraries, payments, hotels, auth]) {
      for (const fn of Object.values(group)) (fn as jest.Mock).mockClear();
    }
  });

  /** Calls both routes and asserts identical status, body and identical service invocation. */
  async function expectSame(service: Record<string, any>, method: string, main: [string, string], legacy: [string, string], headers = user, body?: object) {
    const call = async ([verb, path]: [string, string]) => {
      service[method].mockClear();
      let r = (http as any)[verb.toLowerCase()](`/api${path}`).set('x-test-user', headers);
      if (body) r = r.send(body);
      const res = await r;
      return { status: res.status, body: res.body, args: [...service[method].mock.calls[0] ?? []] };
    };
    const a = await call(main);
    const b = await call(legacy);
    expect(a.status).toBeLessThan(300);
    expect(b.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
    expect(b.args).toEqual(a.args);
    return a;
  }

  describe('cancellation: POST /:id/cancel === DELETE /:id', () => {
    it('flight bookings', async () => {
      const r = await expectSame(flightBookings, 'cancel', ['POST', '/flight-bookings/f1/cancel'], ['DELETE', '/flight-bookings/f1']);
      expect(r.status).toBe(200);
      expect(r.args).toEqual(['user-1', 'f1']);
    });
    it('hotel bookings', async () => {
      const r = await expectSame(hotelBookings, 'cancel', ['POST', '/hotel-bookings/h1/cancel'], ['DELETE', '/hotel-bookings/h1']);
      expect(r.status).toBe(200);
      expect(r.args).toEqual(['user-1', 'h1']);
    });
    it('unauthenticated access fails on both', async () => {
      for (const [verb, path] of [['post', '/flight-bookings/f1/cancel'], ['delete', '/flight-bookings/f1'], ['post', '/hotel-bookings/h1/cancel'], ['delete', '/hotel-bookings/h1']]) {
        expect((await (http as any)[verb](`/api${path}`)).status).toBe(401);
      }
      expect(flightBookings.cancel).not.toHaveBeenCalled();
      expect(hotelBookings.cancel).not.toHaveBeenCalled();
    });
    it("someone else's booking is rejected identically by the service on both routes", async () => {
      flightBookings.cancel.mockRejectedValue(new NotFoundException('Booking not found') as never);
      const a = await http.post('/api/flight-bookings/f9/cancel').set('x-test-user', user);
      const b = await http.delete('/api/flight-bookings/f9').set('x-test-user', user);
      expect([a.status, b.status]).toEqual([404, 404]);
      expect(a.body).toEqual(b.body);
      flightBookings.cancel.mockResolvedValue({ method: 'cancel' } as never);
    });
  });

  describe('POST /flight-bookings/hold === POST /flight-bookings (creating the booking IS the hold)', () => {
    const dto = { flightId: '507f1f77bcf86cd799439011', cabinClass: 'Economy', policiesAccepted: true, passengers: [{ fullName: 'A B', dateOfBirth: '1990-01-01' }] };
    it('creates through the same service method with the same arguments and status', async () => {
      const r = await expectSame(flightBookings, 'create', ['POST', '/flight-bookings/hold'], ['POST', '/flight-bookings'], user, dto);
      expect(r.status).toBe(201);
      expect(r.args[0]).toBe('user-1');
    });
    it('requires authentication and validates the body on both', async () => {
      expect((await http.post('/api/flight-bookings/hold').send(dto)).status).toBe(401);
      expect((await http.post('/api/flight-bookings').send(dto)).status).toBe(401);
      const bad = await http.post('/api/flight-bookings/hold').set('x-test-user', user).send({ ...dto, passengers: 'x' });
      expect(bad.status).toBe(400);
      expect(bad.body.errors).toBeDefined();
    });
  });

  describe('itineraries', () => {
    it('PATCH days/reorder === days/order and is not captured by :dayId', async () => {
      const r = await expectSame(itineraries, 'reorderDays', ['PATCH', '/itineraries/i1/days/reorder'], ['PATCH', '/itineraries/i1/days/order'], user, { dayIds: ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'] });
      expect(r.args.slice(0, 2)).toEqual(['user-1', 'i1']);
      expect(itineraries.updateDay).not.toHaveBeenCalled();
    });
    it('POST days/:dayId/budgets === budget-entries', async () => {
      const dto = { description: 'Museum tickets', category: 'food', amount: 10, currency: 'EGP' };
      const r = await expectSame(itineraries, 'addBudgetEntry', ['POST', '/itineraries/i1/days/d1/budgets'], ['POST', '/itineraries/i1/days/d1/budget-entries'], user, dto);
      expect(r.status).toBe(201);
      expect(r.args.slice(0, 3)).toEqual(['user-1', 'i1', 'd1']);
    });
    it('GET budget-summary passes the owner, id and currency through', async () => {
      const res = await http.get('/api/itineraries/i1/budget-summary?currency=EUR').set('x-test-user', user);
      expect(res.status).toBe(200);
      expect(itineraries.budgetSummary).toHaveBeenCalledWith('user-1', 'i1', 'EUR');
      expect((await http.get('/api/itineraries/i1/budget-summary')).status).toBe(401);
    });
    it.each([
      ['PATCH', '/activities/a1', 'updateActivityById', 'updateActivity', '/itineraries/i1/days/d1/activities/a1', { name: 'Updated' }],
      ['DELETE', '/activities/a1', 'removeActivityById', 'removeActivity', '/itineraries/i1/days/d1/activities/a1', undefined],
      ['PATCH', '/budgets/b1', 'updateBudgetEntryById', 'updateBudgetEntry', '/itineraries/i1/days/d1/budget-entries/b1', { amount: 5 }],
      ['DELETE', '/budgets/b1', 'removeBudgetEntryById', 'removeBudgetEntry', '/itineraries/i1/days/d1/budget-entries/b1', undefined],
      ['PATCH', '/transport-costs/c1', 'updateTransportCostById', 'updateTransportCost', '/itineraries/i1/transport-costs/c1', { amount: 5 }],
      ['DELETE', '/transport-costs/c1', 'removeTransportCostById', 'removeTransportCost', '/itineraries/i1/transport-costs/c1', undefined],
    ])('%s %s uses the owner-scoped service lookup; unauthenticated is 401 on alias and nested route', async (verb, path, aliasMethod, nestedMethod, nestedPath, body) => {
      let req = (http as any)[verb.toLowerCase()](`/api${path}`).set('x-test-user', user);
      if (body) req = req.send(body);
      const res = await req;
      expect(res.status).toBe(200);
      expect(itineraries[aliasMethod]).toHaveBeenCalledTimes(1);
      expect((itineraries[aliasMethod].mock.calls[0] as unknown[])[0]).toBe('user-1');
      expect(itineraries[nestedMethod]).not.toHaveBeenCalled();
      for (const p of [path, nestedPath]) {
        expect((await (http as any)[verb.toLowerCase()](`/api${p}`).send(body ?? {})).status).toBe(401);
      }
    });
  });

  describe('payments and refunds', () => {
    const payload = '{"id":"evt_1",  "type":"payment_intent.succeeded"}\n';
    it.each(['/payments/webhook', '/stripe/webhook'])('POST %s verifies the signature against the exact raw bytes without auth', async (path) => {
      payments.handleStripeWebhook.mockClear();
      const res = await http.post(`/api${path}`).set('stripe-signature', 't=1,v1=abc').set('content-type', 'application/json').send(payload);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ received: true });
      const [raw, signature] = payments.handleStripeWebhook.mock.calls[0] as [Buffer, string];
      expect(Buffer.isBuffer(raw)).toBe(true);
      expect(raw.toString('utf8')).toBe(payload); // byte-for-byte, including the odd spacing
      expect(signature).toBe('t=1,v1=abc');
    });
    it.each(['/payments/webhook', '/stripe/webhook'])('POST %s without a signature is 400', async (path) => {
      expect((await http.post(`/api${path}`).set('content-type', 'application/json').send(payload)).status).toBe(400);
    });
    it('GET /payments/:id is still routed to the payment lookup, not the webhook', async () => {
      expect((await http.get('/api/payments/p1').set('x-test-user', user)).status).toBe(200);
      expect(payments.getForUser).toHaveBeenCalledWith('user-1', 'p1');
    });
    it('GET /refunds/:id is owner-scoped and requires authentication', async () => {
      expect((await http.get('/api/refunds/p1').set('x-test-user', user)).status).toBe(200);
      expect(refunds.getForViewer).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', role: 'user' }), 'p1');
      expect((await http.get('/api/refunds/p1')).status).toBe(401);
      refunds.getForViewer.mockRejectedValueOnce(new NotFoundException('Refund not found') as never);
      expect((await http.get('/api/refunds/p2').set('x-test-user', user)).status).toBe(404);
    });
  });

  describe('hotels (moderator, own hotel only)', () => {
    const dates = '?startDate=2099-03-01&endDate=2099-03-05';
    it('GET /hotels/:id/availability === GET /hotels/:id/rooms/status', async () => {
      const r = await expectSame(hotels, 'getRoomStatuses', ['GET', `/hotels/h1/availability${dates}`], ['GET', `/hotels/h1/rooms/status${dates}`], moderator);
      expect(r.args).toEqual(['h1', { startDate: '2099-03-01', endDate: '2099-03-05' }, 'mod-1']);
    });
    it('availability requires the date range', async () => {
      const res = await http.get('/api/hotels/h1/availability').set('x-test-user', moderator);
      expect(res.status).toBe(400);
      expect(res.body.errors.map((e: any) => e.field).sort()).toEqual(['endDate', 'startDate']);
      expect(hotels.getRoomStatuses).not.toHaveBeenCalled();
    });
    it('availability and rooms/status reject customers (403) and anonymous users (401)', async () => {
      for (const path of ['availability', 'rooms/status']) {
        expect((await http.get(`/api/hotels/h1/${path}${dates}`).set('x-test-user', user)).status).toBe(403);
        expect((await http.get(`/api/hotels/h1/${path}${dates}`)).status).toBe(401);
      }
      expect(hotels.getRoomStatuses).not.toHaveBeenCalled();
    });
    it("another moderator's hotel is refused by the service identically on both routes", async () => {
      hotels.getRoomStatuses.mockRejectedValue(new ForbiddenException('You can only view room statuses for the hotel assigned to your account') as never);
      const a = await http.get(`/api/hotels/h2/availability${dates}`).set('x-test-user', moderator);
      const b = await http.get(`/api/hotels/h2/rooms/status${dates}`).set('x-test-user', moderator);
      expect([a.status, b.status]).toEqual([403, 403]);
      expect(a.body.message).toBe(b.body.message);
      hotels.getRoomStatuses.mockResolvedValue({ method: 'getRoomStatuses' } as never);
    });
    it('PUT /hotels/:id/policies runs the same update as PATCH /hotels/:id with the same checks', async () => {
      const policies = { checkInTime: '14:00', checkOutTime: '11:00', cancellationTiers: [{ daysBeforeCheckIn: 7, refundPercentage: 100 }] };
      hotels.update.mockClear();
      const put = await http.put('/api/hotels/h1/policies').set('x-test-user', moderator).send(policies);
      const patch = await http.patch('/api/hotels/h1').set('x-test-user', moderator).send(policies);
      expect([put.status, patch.status]).toEqual([200, 200]);
      expect(put.body).toEqual(patch.body);
      expect(hotels.update.mock.calls[0]).toEqual(hotels.update.mock.calls[1]);
      expect(hotels.update.mock.calls[0]).toEqual(['h1', policies, 'mod-1']);
    });
    it('PUT policies rejects customers, anonymous users and non-policy fields', async () => {
      hotels.update.mockClear();
      const body = { checkInTime: '14:00', checkOutTime: '11:00' };
      expect((await http.put('/api/hotels/h1/policies').set('x-test-user', user).send(body)).status).toBe(403);
      expect((await http.put('/api/hotels/h1/policies').send(body)).status).toBe(401);
      const extra = await http.put('/api/hotels/h1/policies').set('x-test-user', moderator).send({ ...body, name: 'Hacked' });
      expect(extra.status).toBe(400);
      expect(hotels.update).not.toHaveBeenCalled();
    });
  });

  describe('auth: PATCH /auth/change-password is a real route next to POST', () => {
    const dto = { currentPassword: 'old-pass-1', newPassword: 'New-pass-123' };
    it('both run the same handler logic', async () => {
      const post = await http.post('/api/auth/change-password').set('x-test-user', user).send(dto);
      const patch = await http.patch('/api/auth/change-password').set('x-test-user', user).send(dto);
      expect([post.status, patch.status]).toEqual([201, 200]);
      expect(post.body).toEqual(patch.body);
      expect(auth.changePassword.mock.calls[0]).toEqual(auth.changePassword.mock.calls[1]);
      expect(auth.changePassword.mock.calls[0]).toEqual(['user-1', dto]);
    });
    it('both enforce the password rules and authentication', async () => {
      for (const verb of ['post', 'patch']) {
        const weak = await (http as any)[verb]('/api/auth/change-password').set('x-test-user', user).send({ currentPassword: 'x', newPassword: 'short' });
        expect(weak.status).toBe(400);
        expect(weak.body.errors[0].field).toBe('newPassword');
        expect((await (http as any)[verb]('/api/auth/change-password').send(dto)).status).toBe(401);
      }
    });
  });

  describe('Swagger: PDF routes are the main ones, legacy routes say so', () => {
    let paths: Record<string, any>;
    beforeAll(() => {
      paths = SwaggerModule.createDocument(app, new DocumentBuilder().build()).paths;
    });

    it('lists every new route and every legacy route', () => {
      const expected: Array<[string, string]> = [
        ['/api/flight-bookings/{id}/cancel', 'post'], ['/api/flight-bookings/{id}', 'delete'],
        ['/api/hotel-bookings/{id}/cancel', 'post'], ['/api/hotel-bookings/{id}', 'delete'],
        ['/api/flight-bookings/hold', 'post'], ['/api/flight-bookings', 'post'],
        ['/api/itineraries/{id}/days/reorder', 'patch'], ['/api/itineraries/{id}/days/order', 'patch'],
        ['/api/payments/webhook', 'post'], ['/api/stripe/webhook', 'post'],
        ['/api/activities/{id}', 'patch'], ['/api/activities/{id}', 'delete'],
        ['/api/budgets/{id}', 'patch'], ['/api/budgets/{id}', 'delete'],
        ['/api/itineraries/{id}/days/{dayId}/budgets', 'post'], ['/api/itineraries/{id}/days/{dayId}/budget-entries', 'post'],
        ['/api/transport-costs/{id}', 'patch'], ['/api/transport-costs/{id}', 'delete'],
        ['/api/itineraries/{id}/budget-summary', 'get'], ['/api/refunds/{id}', 'get'],
        ['/api/hotels/{hotelId}/policies', 'put'], ['/api/hotels/{hotelId}/availability', 'get'],
        ['/api/auth/change-password', 'post'], ['/api/auth/change-password', 'patch'],
      ];
      for (const [path, verb] of expected) expect(paths[path]?.[verb]).toBeDefined();
    });

    it('legacy routes are described as legacy aliases (not flagged deprecated)', () => {
      const legacy: Array<[string, string]> = [
        ['/api/flight-bookings/{id}', 'delete'], ['/api/hotel-bookings/{id}', 'delete'],
        ['/api/itineraries/{id}/days/order', 'patch'], ['/api/itineraries/{id}/days/{dayId}/budget-entries', 'post'],
        ['/api/hotels/{hotelId}/rooms/status', 'get'], ['/api/itineraries/{id}/days/{dayId}/activities/{activityId}', 'patch'],
        ['/api/itineraries/{id}/transport-costs/{costId}', 'delete'],
      ];
      for (const [path, verb] of legacy) {
        const op = paths[path][verb];
        expect(op.description).toMatch(/legacy alias/i);
        expect(op.deprecated).toBeUndefined();
      }
      expect(paths['/api/stripe/webhook'].post.description).toMatch(/legacy alias/i);
    });

    it('both flight hold routes carry the "creating the booking IS the hold; do not call both" warning', () => {
      for (const path of ['/api/flight-bookings/hold', '/api/flight-bookings']) {
        const description: string = paths[path].post.description;
        expect(description).toMatch(/Creating the booking IS the hold/);
        expect(description).toMatch(/Do not call both/);
        expect(description).toMatch(/TWO pending bookings/);
      }
    });

    it('main routes come first in the document order', () => {
      const keys = Object.keys(paths);
      expect(keys.indexOf('/api/flight-bookings/hold')).toBeLessThan(keys.indexOf('/api/flight-bookings'));
    });
  });
});
