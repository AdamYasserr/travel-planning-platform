
import { jest } from '@jest/globals';
import sharp from 'sharp';

jest.mock('@nestjs/swagger', () => ({
  ApiProperty: () => () => undefined,
  ApiPropertyOptional: () => () => undefined,
}));

jest.mock('@nestjs/common', () => {
  class TestHttpError extends Error {}

  return {
    BadRequestException: TestHttpError,
    ConflictException: TestHttpError,
    ForbiddenException: TestHttpError,
    InternalServerErrorException: TestHttpError,
    Injectable: () => () => undefined,
    Logger: class {
      warn() {}
      error() {}
    },
    NotFoundException: TestHttpError,
    UnauthorizedException: TestHttpError,
  };
});

jest.mock('@nestjs/mongoose', () => ({
  InjectModel: () => () => undefined,
  Prop: () => () => undefined,
  Schema: () => () => undefined,
  SchemaFactory: {
    createForClass: () => ({ index: () => undefined }),
  },
}));

jest.mock('@nestjs/config', () => ({
  ConfigService: class {},
}));

import { MediaTargetType } from './dto/upload-media.dto';
import { MediaService } from './media.service';

describe('MediaService GEN-08 validation', () => {
  const ownerId = '507f1f77bcf86cd799439011';

  let service: MediaService;
  let mediaModel: any;
  let postModel: any;
  let commentModel: any;
  let read: jest.Mock;

  let create: (
    value: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;

  let save: () => Promise<void>;

  async function image(format: 'jpeg' | 'png' | 'webp') {
    return sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .toFormat(format)
      .toBuffer();
  }

  function file(
    buffer: Buffer,
    originalname: string,
    mimetype: string,
    size = buffer.length,
  ) {
    return { buffer, originalname, mimetype, size };
  }

  beforeEach(() => {
    create = jest.fn(async (value: Record<string, unknown>) => ({
      ...value,
      _id: { toString: () => ownerId },
      createdAt: new Date(),
    }));

    save = jest.fn(async () => undefined);

    const userModel = {
      findOne: jest.fn(() => ({
        exec: async () => ({
          _id: ownerId,
        }),
      })),
    };

    mediaModel = {
      create,
      countDocuments: jest.fn(() => ({ exec: async () => 0 })),
      find: jest.fn(() => ({ sort: () => ({ exec: async () => [] }) })),
      findOne: jest.fn(() => ({ select: () => ({ exec: async () => null }) })),
      deleteOne: jest.fn(() => ({ exec: async () => undefined })),
    };

    const hotelModel = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    const airlineModel = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    postModel = { findById: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(), exists: jest.fn() };
    commentModel = { findById: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(), exists: jest.fn() };

    read = jest.fn(async () => Buffer.from('stored-image'));
    const storage = {
      save,
      read,
      remove: jest.fn(),
    };

    service = new MediaService(
      mediaModel as never,
      userModel as never,
      hotelModel as never,
      airlineModel as never,
      postModel as never,
      commentModel as never,
      storage as never,
    );
  });

  async function upload(
    buffer: Buffer,
    originalname: string,
    mimetype: string,
    size = buffer.length,
  ) {
    return service.upload(
      ownerId,
      { targetType: MediaTargetType.PROFILE },
      file(buffer, originalname, mimetype, size),
    );
  }

  it('accepts a genuine JPG', async () => {
    await expect(upload(await image('jpeg'), 'photo.jpg', 'image/jpeg'))
      .resolves.toMatchObject({
        message: 'Media uploaded successfully',
      });
  });

  it('accepts a genuine PNG', async () => {
    await expect(upload(await image('png'), 'photo.png', 'image/png'))
      .resolves.toMatchObject({
        message: 'Media uploaded successfully',
      });
  });

  it('attaches an image to an author-owned post and enforces the five-image maximum', async () => {
    const targetId = '507f1f77bcf86cd799439012';
    postModel.findById.mockReturnValue({
      select: () => ({ exec: async () => ({ _id: targetId, authorId: { toString: () => ownerId }, status: 'published' }) }),
    });
    postModel.findOneAndUpdate.mockReturnValue({ exec: async () => ({ _id: targetId }) });
    mediaModel.create.mockImplementation(async (value: Record<string, unknown>) => ({
      ...value,
      _id: { toString: () => '507f1f77bcf86cd799439013' },
      createdAt: new Date(),
    }));
    const photo = await image('jpeg');
    await expect(service.upload(
      ownerId,
      { targetType: MediaTargetType.POST, targetId },
      file(photo, 'story.jpg', 'image/jpeg'),
    )).resolves.toMatchObject({ message: 'Media uploaded successfully' });
    expect(postModel.findOneAndUpdate).toHaveBeenCalled();

    mediaModel.countDocuments.mockReturnValue({ exec: async () => 5 });
    await expect(service.upload(
      ownerId,
      { targetType: MediaTargetType.POST, targetId },
      file(photo, 'sixth.jpg', 'image/jpeg'),
    )).rejects.toThrow('at most 5 images');
  });

  it('rejects post media uploads from a non-author', async () => {
    postModel.findById.mockReturnValue({
      select: () => ({ exec: async () => ({ _id: '507f1f77bcf86cd799439012', authorId: { toString: () => '507f1f77bcf86cd799439099' }, status: 'published' }) }),
    });
    const photo = await image('jpeg');
    await expect(service.upload(
      ownerId,
      { targetType: MediaTargetType.POST, targetId: '507f1f77bcf86cd799439012' },
      file(photo, 'story.jpg', 'image/jpeg'),
    )).rejects.toThrow('Only the post author can upload images');
  });

  it('keeps profile media owner-readable when its targetId is null', async () => {
    const mediaId = '507f1f77bcf86cd799439014';
    mediaModel.findOne.mockReturnValue({
      select: () => ({ exec: async () => ({
        targetType: MediaTargetType.PROFILE,
        targetId: null,
        storageKey: 'profile.jpg',
        mimeType: 'image/jpeg',
        originalName: 'profile.jpg',
      }) }),
    });
    await expect(service.getContent(ownerId, mediaId)).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    expect(read).toHaveBeenCalledWith('profile.jpg');
  });

  it('does not expose media when its post is no longer published', async () => {
    const mediaId = '507f1f77bcf86cd799439015';
    const targetId = '507f1f77bcf86cd799439016';
    mediaModel.findOne.mockReturnValue({
      select: () => ({ exec: async () => ({
        targetType: MediaTargetType.POST,
        targetId,
        storageKey: 'hidden-post.jpg',
        mimeType: 'image/jpeg',
        originalName: 'hidden-post.jpg',
      }) }),
    });
    postModel.findOne.mockReturnValue({ select: () => ({ exec: async () => null }) });
    await expect(service.getPublicContent(mediaId)).rejects.toThrow('Media not found');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects WebP', async () => {
    await expect(upload(await image('webp'), 'photo.webp', 'image/webp'))
      .rejects.toThrow(
        'Only matching JPG and PNG image files are supported',
      );
  });

  it('rejects unsupported formats', async () => {
    await expect(
      upload(Buffer.from('not an image'), 'photo.gif', 'image/gif'),
    ).rejects.toThrow(
      'Only matching JPG and PNG image files are supported',
    );
  });

  it('rejects mismatched MIME types and extensions', async () => {
    await expect(upload(await image('jpeg'), 'photo.png', 'image/png'))
      .rejects.toThrow(
        'Only matching JPG and PNG image files are supported',
      );
  });

  it('rejects corrupted images', async () => {
    const validJpg = await image('jpeg');

    const corrupted = Buffer.concat([
      validJpg.subarray(0, 3),
      Buffer.alloc(20),
      Buffer.from([0xff, 0xd9]),
    ]);

    await expect(upload(corrupted, 'photo.jpg', 'image/jpeg'))
      .rejects.toThrow(
        'The uploaded file is not a valid supported image',
      );
  });

  it('rejects files larger than 5 MB', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);

    await expect(upload(oversized, 'photo.jpg', 'image/jpeg'))
      .rejects.toThrow(
        'Media file must be between 1 byte and 5 MB',
      );

    expect(save).not.toHaveBeenCalled();
  });
});
