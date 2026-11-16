
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

function query(result: unknown) {
  const value: Record<string, any> = {};
  for (const method of ['select', 'session', 'lean', 'limit']) {
    value[method] = jest.fn(() => value);
  }
  value.exec = jest.fn().mockResolvedValue(result);
  return value;
}

describe('MediaService GEN-08 validation', () => {
  const ownerId = '507f1f77bcf86cd799439011';

  let service: MediaService;

  let create: (
    value: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;

  let save: () => Promise<void>;
  let userModel: Record<string, any>;
  let mediaModel: Record<string, any>;
  let itineraryModel: Record<string, any>;
  let postModel: Record<string, any>;
  let storage: Record<string, any>;

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

    userModel = {
      findOne: jest.fn(() => ({
        select: jest.fn(() => ({
          exec: jest.fn().mockResolvedValue({ _id: ownerId }),
        })),
      })),
    };

    mediaModel = {
      create,
      findOne: jest.fn(() => query(null)),
      find: jest.fn(() => query([])),
      deleteOne: jest.fn(() => query({ deletedCount: 1 })),
      deleteMany: jest.fn(() => query({ deletedCount: 0 })),
      updateOne: jest.fn(() => query({ matchedCount: 1 })),
      updateMany: jest.fn(() => query({ matchedCount: 1 })),
    };
    itineraryModel = { findOne: jest.fn() };
    postModel = {
      findOne: jest.fn(() => query({ imageIds: [] })),
      findById: jest.fn(() => query(null)),
      updateOne: jest.fn(() => query({ matchedCount: 1 })),
      db: {
        startSession: jest.fn().mockResolvedValue({
          withTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
          endSession: jest.fn(),
        }),
      },
    };
    storage = {
      save,
      read: jest.fn().mockResolvedValue(Buffer.from('image')),
      remove: jest.fn(async () => ({ status: 'removed' as const })),
      retryPendingRemovals: jest.fn(async () => ({ completed: 0, pending: 0 })),
    };

    service = new MediaService(
      mediaModel as never,
      userModel as never,
      itineraryModel as never,
      postModel as never,
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

  it('attaches post uploads only after verifying ownership and image capacity', async () => {
    const buffer = await image('jpeg');
    postModel.findOne.mockReturnValue(query({ imageIds: [] }));

    await service.upload(
      ownerId,
      { targetType: MediaTargetType.POST, targetId: ownerId },
      file(buffer, 'post.jpg', 'image/jpeg'),
    );

    expect(postModel.findOne).toHaveBeenCalledWith({
      _id: expect.any(Object),
      authorId: expect.any(Object),
    });
    expect(postModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: expect.any(Object),
        $expr: expect.any(Object),
      }),
      { $addToSet: { imageIds: expect.any(Object) } },
    );
    expect(mediaModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: MediaTargetType.POST }),
    );
  });

  it('rejects a sixth post image before storing it', async () => {
    postModel.findOne.mockReturnValue(
      query({ imageIds: Array.from({ length: 5 }, () => ({})) }),
    );

    await expect(
      service.upload(
        ownerId,
        { targetType: MediaTargetType.POST, targetId: ownerId },
        file(await image('jpeg'), 'post.jpg', 'image/jpeg'),
      ),
    ).rejects.toThrow('A post can have at most 5 images');
    expect(save).not.toHaveBeenCalled();
  });

  it('serves an attached image to a guest only while its post is public', async () => {
    const media = {
      ownerId: { toString: () => ownerId },
      targetType: MediaTargetType.POST,
      targetId: { toString: () => ownerId },
      storageKey: 'post-image.jpg',
      mimeType: 'image/jpeg',
      originalName: 'post.jpg',
    };
    mediaModel.findOne.mockReturnValue(query(media));
    postModel.findOne.mockReturnValue(
      query({
        status: 'published',
        isHidden: false,
        authorId: { toString: () => ownerId },
      }),
    );

    await expect(service.getPublicPostContent(ownerId)).resolves.toMatchObject({
      buffer: Buffer.from('image'),
      mimeType: 'image/jpeg',
      originalName: 'post.jpg',
    });

    postModel.findOne.mockReturnValue(query(null));
    await expect(service.getPublicPostContent(ownerId)).rejects.toThrow(
      'Media not found',
    );
  });

  it('does not serve post media after its ID is detached from the post', async () => {
    mediaModel.findOne.mockReturnValue(
      query({
        ownerId: { toString: () => ownerId },
        targetType: MediaTargetType.POST,
        targetId: { toString: () => ownerId },
        storageKey: 'stale.jpg',
      }),
    );
    postModel.findOne.mockReturnValue(query(null));

    await expect(service.getPublicPostContent(ownerId)).rejects.toThrow(
      'Media not found',
    );
    expect(postModel.findOne).toHaveBeenCalledWith({
      _id: expect.any(Object),
      status: 'published',
      isHidden: false,
      imageIds: expect.any(Object),
    });
    expect(storage.read).not.toHaveBeenCalled();
  });

  it('does not serve post media owned by someone other than the post author', async () => {
    mediaModel.findOne.mockReturnValue(
      query({
        ownerId: { toString: () => ownerId },
        targetType: MediaTargetType.POST,
        targetId: { toString: () => ownerId },
        storageKey: 'mismatched-owner.jpg',
      }),
    );
    postModel.findOne.mockReturnValue(
      query({
        authorId: { toString: () => '507f1f77bcf86cd799439013' },
      }),
    );

    await expect(service.getPublicPostContent(ownerId)).rejects.toThrow(
      'Media not found',
    );
    expect(storage.read).not.toHaveBeenCalled();
  });

  it('removes a post image only for the owner and cleans its stored file', async () => {
    mediaModel.findOne.mockReturnValue(
      query({
        _id: { toString: () => ownerId },
        storageKey: 'post-image.jpg',
      }),
    );

    await expect(
      service.deletePostImage(ownerId, ownerId, ownerId),
    ).resolves.toMatchObject({ message: 'Post image deleted successfully' });
    expect(postModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: expect.any(Object),
        imageIds: expect.any(Object),
      }),
      { $pull: { imageIds: expect.any(Object) } },
    );
    expect(storage.remove).toHaveBeenCalledWith('post-image.jpg');
  });

  it('prepares post-media metadata for the post transaction and cleans files after commit', async () => {
    mediaModel.find.mockReturnValue(
      query([{ storageKey: 'first.jpg' }, { storageKey: 'second.png' }]),
    );
    const session = {} as never;

    const cleanup = await service.preparePostMediaDeletion(
      ownerId,
      ownerId,
      session,
    );

    expect(mediaModel.find).toHaveBeenCalledWith({
      ownerId: expect.any(Object),
      targetType: MediaTargetType.POST,
      targetId: expect.any(Object),
    });
    expect(mediaModel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: MediaTargetType.POST }),
      { $set: { cleanupPending: true } },
    );
    expect(storage.remove).not.toHaveBeenCalled();
    await expect(cleanup()).resolves.toBe(0);
    expect(storage.remove).toHaveBeenCalledTimes(2);
  });

  it('reports queued storage cleanup instead of claiming the image was removed', async () => {
    mediaModel.findOne.mockReturnValue(
      query({
        _id: { toString: () => ownerId },
        storageKey: 'post-image.jpg',
      }),
    );
    storage.remove.mockResolvedValue({ status: 'queued' });

    await expect(
      service.deletePostImage(ownerId, ownerId, ownerId),
    ).resolves.toEqual({
      message: 'Post image detached; storage cleanup queued for retry',
      storageCleanupPending: true,
    });
    expect(mediaModel.deleteOne).not.toHaveBeenCalled();
  });

  it('retries persisted media cleanup records from the scheduled cleanup pass', async () => {
    const pendingMedia = {
      _id: { toString: () => ownerId },
      storageKey: 'retry.jpg',
    };
    mediaModel.find.mockReturnValue(query([pendingMedia]));

    await service.retryPendingStorageCleanup();

    expect(storage.retryPendingRemovals).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledWith('retry.jpg');
    expect(mediaModel.deleteOne).toHaveBeenCalledWith({
      _id: pendingMedia._id,
      cleanupPending: true,
    });
  });
});
