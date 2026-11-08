
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
    InternalServerErrorException: TestHttpError,
    Injectable: () => () => undefined,
    Logger: class {
      warn() {}
    },
    NotImplementedException: TestHttpError,
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
        select: jest.fn(async () => ({ _id: ownerId })),
      })),
    };

    const mediaModel = { create };
    const storage = {
      save,
      read: jest.fn(),
      remove: jest.fn(),
    };

    service = new MediaService(
      mediaModel as never,
      userModel as never,
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
      .resolves.toMatchObject({ message: 'Media uploaded successfully' });
  });

  it('accepts a genuine PNG', async () => {
    await expect(upload(await image('png'), 'photo.png', 'image/png'))
      .resolves.toMatchObject({ message: 'Media uploaded successfully' });
  });

  it('rejects WebP', async () => {
    await expect(upload(await image('webp'), 'photo.webp', 'image/webp'))
      .rejects.toThrow('Only matching JPG and PNG image files are supported');
  });

  it('rejects unsupported formats', async () => {
    await expect(
      upload(Buffer.from('not an image'), 'photo.gif', 'image/gif'),
    ).rejects.toThrow('Only matching JPG and PNG image files are supported');
  });

  it('rejects mismatched MIME types and extensions', async () => {
    await expect(upload(await image('jpeg'), 'photo.png', 'image/png'))
      .rejects.toThrow('Only matching JPG and PNG image files are supported');
  });

  it('rejects corrupted images', async () => {
    const validJpg = await image('jpeg');

    const corrupted = Buffer.concat([
      validJpg.subarray(0, 3),
      Buffer.alloc(20),
      Buffer.from([0xff, 0xd9]),
    ]);

    await expect(upload(corrupted, 'photo.jpg', 'image/jpeg'))
      .rejects.toThrow('The uploaded file is not a valid supported image');
  });

  it('rejects files larger than 5 MB', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);

    await expect(upload(oversized, 'photo.jpg', 'image/jpeg'))
      .rejects.toThrow('Media file must be between 1 byte and 5 MB');

    expect(save).not.toHaveBeenCalled();
  });
});
