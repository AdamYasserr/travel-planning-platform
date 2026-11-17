import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { HotelsService } from './hotels.service';
import { ReferenceValidationService } from '../reference-data/reference-validation.service';

const lean = (value: unknown) => ({ select: () => ({ lean: () => ({ exec: async () => value }) }) });

describe('HotelsService reference validation (GEN-12)', () => {
  let hotelModel: Record<string, jest.Mock>;
  let service: HotelsService;
  const countries = { find: jest.fn() };
  const cities = { find: jest.fn(), findOne: jest.fn() };
  const airports = { find: jest.fn() };
  const currencies = { resolve: jest.fn((c?: string) => (c ?? 'EGP').toUpperCase()) };

  beforeEach(() => {
    jest.clearAllMocks();
    countries.find.mockImplementation((q: any) => lean(q.code.$in.filter((c: string) => c === 'EG').map((code: string) => ({ code }))));
    cities.find.mockImplementation((q: any) => lean(q.cityId.$in.filter((c: string) => c === 'cairo').map((cityId: string) => ({ cityId }))));
    cities.findOne.mockImplementation(() => lean({ countryCode: 'EG' }));
    hotelModel = { create: jest.fn(async (d: any) => d) };
    const refs = new ReferenceValidationService(countries as never, cities as never, airports as never);
    service = new HotelsService(hotelModel as never, {} as never, {} as never, {} as never, {} as never, refs, currencies as never, {} as never);
  });

  const dto = { name: 'Nile Hotel', address: '1 Corniche', cityId: 'cairo', countryId: 'EG', description: '' } as any;

  it('stores dataset identifiers for a valid city and country', async () => {
    await service.create({ ...dto, countryId: 'eg' });
    expect(hotelModel.create).toHaveBeenCalledWith(expect.objectContaining({ cityId: 'cairo', countryId: 'EG', isActive: true }));
  });

  it('rejects an unknown city with a clear 400', async () => {
    await expect(service.create({ ...dto, cityId: 'atlantis' })).rejects.toThrow(
      new BadRequestException('Unknown city identifier(s) for cityId: atlantis. Use an identifier from the reference dataset.'),
    );
    expect(hotelModel.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown country with a clear 400', async () => {
    await expect(service.create({ ...dto, countryId: 'ZZ' })).rejects.toThrow(/Unknown country identifier\(s\) for countryId: ZZ/);
  });

  it('rejects a city that belongs to a different country', async () => {
    cities.findOne.mockImplementation(() => lean({ countryCode: 'FR' }));
    await expect(service.create(dto)).rejects.toThrow(/does not belong to country "EG"/);
  });

  describe('refreshRating (HTL-23): a full recount of visible reviews, never an increment', () => {
    const make = (rows: unknown[]) => {
      const aggregate = { session: jest.fn(), exec: jest.fn(async () => rows) };
      const reviews = { aggregate: jest.fn(() => aggregate) };
      const hotels = { updateOne: jest.fn(() => ({ exec: async () => ({}) })) };
      const svc = new HotelsService(hotels as never, {} as never, {} as never, {} as never, reviews as never, {} as never, {} as never, {} as never);
      return { svc, reviews, hotels, aggregate };
    };
    const id = '507f1f77bcf86cd799439011';

    it('stores the rounded average and the count of visible reviews', async () => {
      const { svc, reviews, hotels } = make([{ average: 13 / 3, count: 3 }]);
      expect(await svc.refreshRating(id)).toEqual({ averageRating: 4.33, ratingCount: 3 });
      const [[pipeline]] = (reviews.aggregate as any).mock.calls;
      expect(pipeline[0].$match).toMatchObject({ isHidden: { $ne: true } });
      expect((hotels.updateOne as any).mock.calls[0][1]).toEqual({ $set: { averageRating: 4.33, ratingCount: 3 } });
    });

    it('no visible review resets the hotel to unrated', async () => {
      const { svc } = make([]);
      expect(await svc.refreshRating(id)).toEqual({ averageRating: null, ratingCount: 0 });
    });

    it('runs inside the caller\'s transaction when given a session', async () => {
      const { svc, aggregate, hotels } = make([{ average: 5, count: 1 }]);
      const session = {} as never;
      await svc.refreshRating(id, session);
      expect(aggregate.session).toHaveBeenCalledWith(session);
      expect((hotels.updateOne as any).mock.calls[0][2]).toEqual({ session });
    });
  });
});

