import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

import { ItinerariesService } from './itineraries.service';
import { ItineraryVisibility } from './enums/itinerary-visibility.enum';

describe('ItinerariesService public author query', () => {
  const authorId = '507f1f77bcf86cd799439011';

  it('returns only public itineraries for the requested owner', async () => {
    const result = [
      {
        _id: new Types.ObjectId(),
        title: 'Public trip',
        countryIds: [],
        startDate: new Date('2026-06-01T00:00:00.000Z'),
        visibility: ItineraryVisibility.PUBLIC,
        days: [],
      },
    ];
    const query: Record<string, any> = {};
    for (const method of ['select', 'sort', 'lean']) {
      query[method] = jest.fn(() => query);
    }
    query.exec = jest.fn().mockResolvedValue(result);
    const itineraryModel = { find: jest.fn(() => query) };
    const service = new ItinerariesService(
      itineraryModel as never,
      {} as never,
      {} as never,
    );

    const itineraries = await service.findPublicByOwnerId(authorId);

    expect(itineraryModel.find).toHaveBeenCalledWith({
      ownerId: new Types.ObjectId(authorId),
      visibility: ItineraryVisibility.PUBLIC,
    });
    expect(query.sort).toHaveBeenCalledWith({ updatedAt: -1, _id: -1 });
    expect(itineraries[0]).toMatchObject({
      title: 'Public trip',
      cityGroups: [],
    });
  });

  it('rejects malformed author IDs before querying', async () => {
    const itineraryModel = { find: jest.fn() };
    const service = new ItinerariesService(
      itineraryModel as never,
      {} as never,
      {} as never,
    );

    await expect(service.findPublicByOwnerId('invalid')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(itineraryModel.find).not.toHaveBeenCalled();
  });
});
