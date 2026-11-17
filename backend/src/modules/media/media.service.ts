import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import sharp from 'sharp';

import { User, UserDocument } from '../../users/user.schema';
import { Post, PostDocument } from '../blog/schemas/post.schema';
import { PostStatus } from '../blog/enums/post-status.enum';
import {
  Itinerary,
  ItineraryDocument,
} from '../itineraries/schemas/itinerary.schema';
import { MediaTargetType, UploadMediaDto } from './dto/upload-media.dto';
import { Media, MediaDocument } from './schemas/media.schema';
import { LocalMediaStorage } from './media.storage';

interface UploadedMediaFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

interface ActivityWithImages {
  _id: Types.ObjectId;
  imageIds: Types.ObjectId[];
}

const ALLOWED_MEDIA: Record<
  string,
  {
    mimeType: string;
    matches: (buffer: Buffer) => boolean;
  }
> = {
  '.jpg': { mimeType: 'image/jpeg', matches: isJpeg },
  '.jpeg': { mimeType: 'image/jpeg', matches: isJpeg },
  '.png': { mimeType: 'image/png', matches: isPng },
};

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const SUPPORTED_FORMATS = new Set(['jpeg', 'png']);

function isJpeg(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff &&
    buffer[buffer.length - 2] === 0xff &&
    buffer[buffer.length - 1] === 0xd9
  );
}

function isPng(buffer: Buffer): boolean {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    return false;
  }

  const ihdrLength = buffer.readUInt32BE(8);
  const ihdrType = buffer.toString('ascii', 12, 16);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const hasIend = buffer.subarray(8).includes(Buffer.from('IEND'));

  return (
    ihdrLength === 13 &&
    ihdrType === 'IHDR' &&
    width > 0 &&
    height > 0 &&
    hasIend
  );
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @InjectModel(Media.name)
    private readonly mediaModel: Model<MediaDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Itinerary.name)
    private readonly itineraryModel: Model<Itinerary>,
    @InjectModel(Post.name)
    private readonly postModel: Model<PostDocument>,
    private readonly storage: LocalMediaStorage,
  ) {}

  async upload(
    ownerId: string,
    dto: UploadMediaDto,
    file: UploadedMediaFile | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('A media file is required');
    }

    if (!Types.ObjectId.isValid(ownerId)) {
      throw new UnauthorizedException('Invalid authenticated user');
    }

    const ownerObjectId = new Types.ObjectId(ownerId);
    const owner = await this.userModel
      .findOne({
        _id: ownerObjectId,
        isActive: true,
        isSuspended: false,
        deactivatedAt: null,
      })
      .select('_id')
      .exec();

    if (!owner) {
      throw new UnauthorizedException('Account is unavailable');
    }

    let itinerary: ItineraryDocument | null = null;
    let post: PostDocument | null = null;
    let postObjectId: Types.ObjectId | null = null;
    let attachedToPost = false;

    if (dto.targetType === MediaTargetType.PROFILE) {
      if (dto.targetId) {
        throw new BadRequestException(
          'Profile media must not include targetId',
        );
      }
    } else if (dto.targetType === MediaTargetType.ACTIVITY) {
      if (!dto.targetId || !Types.ObjectId.isValid(dto.targetId)) {
        throw new BadRequestException(
          'A valid activity targetId is required',
        );
      }

      itinerary = await this.itineraryModel
        .findOne({
          ownerId: ownerObjectId,
          'days.activities._id': new Types.ObjectId(dto.targetId),
        })
        .exec();

      if (!itinerary) {
        throw new NotFoundException(
          'Activity not found in one of your itineraries',
        );
      }
    } else if (dto.targetType === MediaTargetType.POST) {
      if (!dto.targetId || !Types.ObjectId.isValid(dto.targetId)) {
        throw new BadRequestException('A valid post targetId is required');
      }

      postObjectId = new Types.ObjectId(dto.targetId);
      post = await this.postModel
        .findOne({ _id: postObjectId, authorId: ownerObjectId })
        .select('_id imageIds')
        .exec();

      if (!post) {
        throw new NotFoundException('Post not found');
      }
      if ((post.imageIds ?? []).length >= 5) {
        throw new BadRequestException('A post can have at most 5 images');
      }
    } else {
      throw new BadRequestException(
        'This media target type is not supported yet',
      );
    }

    if (
      file.size < 1 ||
      file.size > MAX_FILE_SIZE ||
      !Buffer.isBuffer(file.buffer) ||
      file.buffer.length < 1 ||
      file.buffer.length !== file.size
    ) {
      throw new BadRequestException(
        'Media file must be between 1 byte and 5 MB',
      );
    }

    const extension = extname(file.originalname).toLowerCase();
    const mediaType = ALLOWED_MEDIA[extension];

    if (
      !mediaType ||
      mediaType.mimeType !== file.mimetype.toLowerCase() ||
      !mediaType.matches(file.buffer)
    ) {
      throw new BadRequestException(
        'Only matching JPG and PNG image files are supported',
      );
    }

    await this.validateImage(file.buffer, mediaType.mimeType);

    const storageKey = `${randomUUID()}${extension}`;
    await this.storage.save(storageKey, file.buffer);

    let media: MediaDocument | undefined;

    try {
      media = await this.mediaModel.create({
        ownerId: ownerObjectId,
        targetType: dto.targetType,
        targetId: dto.targetId
          ? new Types.ObjectId(dto.targetId)
          : null,
        originalName: this.sanitizeFilename(file.originalname, extension),
        mimeType: mediaType.mimeType,
        extension,
        size: file.size,
        storageKey,
      });

      if (
        dto.targetType === MediaTargetType.ACTIVITY &&
        itinerary &&
        dto.targetId
      ) {
        const activity = this.findActivity(itinerary, dto.targetId);

        if (!activity) {
          throw new NotFoundException('Activity not found');
        }

        activity.imageIds ??= [];
        activity.imageIds.push(media._id);
        await itinerary.save();
      }

      if (dto.targetType === MediaTargetType.POST && postObjectId) {
        const attachment = await this.postModel
          .updateOne(
            {
              _id: postObjectId,
              authorId: ownerObjectId,
              $expr: {
                $lt: [{ $size: { $ifNull: ['$imageIds', []] } }, 5],
              },
            },
            { $addToSet: { imageIds: media._id } },
          )
          .exec();

        if (attachment.matchedCount !== 1) {
          throw new ConflictException(
            'Post image limit reached or post is no longer available',
          );
        }
        attachedToPost = true;
      }

      return {
        message: 'Media uploaded successfully',
        media: this.toPublicMedia(media),
      };
    } catch (error: unknown) {
      if (attachedToPost && postObjectId) {
        try {
          await this.postModel
            .updateOne(
              { _id: postObjectId, authorId: ownerObjectId },
              { $pull: { imageIds: media?._id } },
            )
            .exec();
        } catch {
          this.logger.warn('Post image reference cleanup failed after upload error');
        }
      }
      if (media) {
        try {
          await this.mediaModel
            .updateOne({ _id: media._id }, { $set: { cleanupPending: true } })
            .exec();
        } catch {
          this.logger.error('Could not mark failed-upload media for cleanup');
        }
      }

      try {
        const removal = await this.storage.remove(storageKey);
        if (removal.status === 'queued') {
          this.logger.warn('Failed-upload media cleanup was queued for retry');
        } else if (media) {
          await this.mediaModel.deleteOne({ _id: media._id }).exec();
        }
      } catch {
        this.logger.error('Media file cleanup could not be queued after upload error');
      }

      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }

      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 11000
      ) {
        throw new ConflictException('Media metadata already exists');
      }

      throw new InternalServerErrorException(
        'Could not save media or attach it to the activity',
      );
    }
  }

  async deleteActivityImage(
    ownerId: string,
    activityId: string,
    imageId: string,
  ) {
    if (
      !Types.ObjectId.isValid(ownerId) ||
      !Types.ObjectId.isValid(activityId) ||
      !Types.ObjectId.isValid(imageId)
    ) {
      throw new BadRequestException('Invalid user, activity, or image ID');
    }

    const ownerObjectId = new Types.ObjectId(ownerId);
    const activityObjectId = new Types.ObjectId(activityId);
    const imageObjectId = new Types.ObjectId(imageId);

    const itinerary = await this.itineraryModel
      .findOne({
        ownerId: ownerObjectId,
        'days.activities._id': activityObjectId,
      })
      .exec();

    if (!itinerary) {
      throw new NotFoundException(
        'Activity not found in one of your itineraries',
      );
    }

    const activity = this.findActivity(itinerary, activityId);

    if (!activity) {
      throw new NotFoundException('Activity not found');
    }

    const media = await this.mediaModel
      .findOne({
        _id: imageObjectId,
        ownerId: ownerObjectId,
        targetType: MediaTargetType.ACTIVITY,
        targetId: activityObjectId,
      })
      .select('+storageKey')
      .exec();

    if (!media) {
      throw new NotFoundException('Activity image not found');
    }

    activity.imageIds = (activity.imageIds ?? []).filter(
      (id) => id.toString() !== imageId,
    );

    await itinerary.save();
    await this.mediaModel
      .updateOne(
        { _id: imageObjectId, ownerId: ownerObjectId },
        { $set: { cleanupPending: true } },
      )
      .exec();
    const pending = await this.cleanupStoredMedia([media]);

    return {
      message: pending
        ? 'Activity image detached; storage cleanup queued for retry'
        : 'Activity image deleted successfully',
      storageCleanupPending: pending > 0,
    };
  }

  async deletePostImage(ownerId: string, postId: string, imageId: string) {
    if (
      !Types.ObjectId.isValid(ownerId) ||
      !Types.ObjectId.isValid(postId) ||
      !Types.ObjectId.isValid(imageId)
    ) {
      throw new BadRequestException('Invalid user, post, or image ID');
    }

    const ownerObjectId = new Types.ObjectId(ownerId);
    const postObjectId = new Types.ObjectId(postId);
    const imageObjectId = new Types.ObjectId(imageId);
    const session = await this.postModel.db.startSession();
    let mediaToClean: MediaDocument | undefined;

    try {
      await session.withTransaction(async () => {
        const post = await this.postModel
          .findOne({ _id: postObjectId, authorId: ownerObjectId })
          .select('_id')
          .session(session)
          .exec();

        if (!post) {
          throw new NotFoundException('Post not found');
        }

        const media = await this.mediaModel
          .findOne({
            _id: imageObjectId,
            ownerId: ownerObjectId,
            targetType: MediaTargetType.POST,
            targetId: postObjectId,
          })
          .select('+storageKey')
          .session(session)
          .exec();

        if (!media) {
          throw new NotFoundException('Post image not found');
        }
        if (media.cleanupPending) {
          mediaToClean = media;
          return;
        }

        const detached = await this.postModel
          .updateOne(
            {
              _id: postObjectId,
              authorId: ownerObjectId,
              imageIds: imageObjectId,
            },
            { $pull: { imageIds: imageObjectId } },
          )
          .session(session)
          .exec();

        if (detached.matchedCount !== 1) {
          throw new NotFoundException('Post image not found');
        }

        await this.mediaModel
          .updateOne(
            { _id: imageObjectId, ownerId: ownerObjectId },
            { $set: { cleanupPending: true } },
          )
          .session(session)
          .exec();
        mediaToClean = media;
      });
    } finally {
      await session.endSession();
    }

    const pending = mediaToClean
      ? await this.cleanupStoredMedia([mediaToClean])
      : 0;

    return {
      message: pending
        ? 'Post image detached; storage cleanup queued for retry'
        : 'Post image deleted successfully',
      storageCleanupPending: pending > 0,
    };
  }

  async preparePostMediaDeletion(
    ownerId: string,
    postId: string,
    session: ClientSession,
  ): Promise<() => Promise<number>> {
    if (
      !Types.ObjectId.isValid(ownerId) ||
      !Types.ObjectId.isValid(postId)
    ) {
      throw new BadRequestException('Invalid user or post ID');
    }

    const filter = {
      ownerId: new Types.ObjectId(ownerId),
      targetType: MediaTargetType.POST,
      targetId: new Types.ObjectId(postId),
    };
    const media = await this.mediaModel
      .find(filter)
      .select('+storageKey')
      .session(session)
      .exec();

    if (media.length === 0) return async () => 0;

    await this.mediaModel
      .updateMany(filter, { $set: { cleanupPending: true } })
      .session(session)
      .exec();

    return () => this.cleanupStoredMedia(media);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async retryPendingStorageCleanup(): Promise<void> {
    try {
      const queueResult = await this.storage.retryPendingRemovals();
      const pendingMedia = await this.mediaModel
        .find({ cleanupPending: true })
        .select('+storageKey')
        .limit(100)
        .exec();
      const pendingRecords = await this.cleanupStoredMedia(pendingMedia);

      if (queueResult.pending > 0 || pendingRecords > 0) {
        this.logger.warn(
          `Media cleanup retry left ${queueResult.pending + pendingRecords} item(s) pending`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        'Media cleanup retry failed',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  async getContent(ownerId: string, mediaId: string) {
    if (
      !Types.ObjectId.isValid(ownerId) ||
      !Types.ObjectId.isValid(mediaId)
    ) {
      throw new NotFoundException('Media not found');
    }

    const media = await this.mediaModel
      .findOne({
        _id: new Types.ObjectId(mediaId),
        ownerId: new Types.ObjectId(ownerId),
        cleanupPending: { $ne: true },
        targetType: {
          $in: [
            MediaTargetType.PROFILE,
            MediaTargetType.ACTIVITY,
            MediaTargetType.POST,
          ],
        },
      })
      .select('+storageKey')
      .exec();

    if (!media) {
      throw new NotFoundException('Media not found');
    }

    if (media.targetType === MediaTargetType.POST) {
      if (!media.targetId || media.ownerId.toString() !== ownerId) {
        throw new NotFoundException('Media not found');
      }
      const post = await this.postModel
        .findById(media.targetId)
        .select('authorId')
        .exec();

      if (!post || post.authorId.toString() !== ownerId) {
        throw new NotFoundException('Media not found');
      }
    }

    return {
      buffer: await this.storage.read(media.storageKey),
      mimeType: media.mimeType,
      originalName: media.originalName,
    };
  }

  async getPublicPostContent(mediaId: string) {
    if (!Types.ObjectId.isValid(mediaId)) {
      throw new NotFoundException('Media not found');
    }

    const media = await this.mediaModel
      .findOne({
        _id: new Types.ObjectId(mediaId),
        targetType: MediaTargetType.POST,
        cleanupPending: { $ne: true },
      })
      .select('+storageKey')
      .exec();

    if (!media?.targetId) {
      throw new NotFoundException('Media not found');
    }

    const post = await this.postModel
      .findOne({
        _id: media.targetId,
        status: PostStatus.PUBLISHED,
        isHidden: false,
        imageIds: new Types.ObjectId(mediaId),
      })
      .select('_id authorId')
      .exec();

    if (
      !post?.authorId ||
      !media.ownerId ||
      post.authorId.toString() !== media.ownerId.toString()
    ) {
      throw new NotFoundException('Media not found');
    }

    return {
      buffer: await this.storage.read(media.storageKey),
      mimeType: media.mimeType,
      originalName: media.originalName,
    };
  }

  private async cleanupStoredMedia(media: MediaDocument[]): Promise<number> {
    let pending = 0;
    for (const item of media) {
      try {
        if (item.targetType === MediaTargetType.POST && item.targetId) {
          await this.postModel
            .updateOne(
              { _id: item.targetId, authorId: item.ownerId },
              { $pull: { imageIds: item._id } },
            )
            .exec();
        }

        const result = await this.storage.remove(item.storageKey);
        if (result.status === 'queued') {
          pending += 1;
          continue;
        }
        await this.mediaModel
          .deleteOne({ _id: item._id, cleanupPending: true })
          .exec();
      } catch (error: unknown) {
        pending += 1;
        this.logger.error(
          'Media file cleanup could not be queued; cleanup remains pending',
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
    return pending;
  }

  private findActivity(
    itinerary: ItineraryDocument,
    activityId: string,
  ): ActivityWithImages | undefined {
    return itinerary.days
      .flatMap((day) =>
        day.activities as unknown as ActivityWithImages[],
      )
      .find((activity) => activity._id.toString() === activityId);
  }

  private toPublicMedia(media: MediaDocument) {
    return {
      id: media._id.toString(),
      targetType: media.targetType,
      targetId: media.targetId?.toString() ?? null,
      originalName: media.originalName,
      mimeType: media.mimeType,
      size: media.size,
      url:
        media.targetType === MediaTargetType.POST
          ? `/api/media/public/${media._id.toString()}/content`
          : `/api/media/${media._id.toString()}/content`,
      createdAt: media.createdAt,
    };
  }

  private sanitizeFilename(originalName: string, extension: string): string {
    const baseName = originalName
      .replace(/[/\\\0-\x1f\x7f]/g, '_')
      .replace(/["']/g, '_')
      .trim()
      .slice(0, 120);

    return baseName || `upload${extension}`;
  }

  private async validateImage(
    buffer: Buffer,
    expectedMimeType: string,
  ): Promise<void> {
    try {
      const image = sharp(buffer, { failOn: 'error' });
      const metadata = await image.metadata();

      if (
        !metadata.format ||
        !SUPPORTED_FORMATS.has(metadata.format) ||
        metadata.width === undefined ||
        metadata.height === undefined ||
        metadata.width < 1 ||
        metadata.height < 1 ||
        this.mimeTypeForFormat(metadata.format) !== expectedMimeType
      ) {
        throw new Error('Unsupported or unsafe image metadata');
      }

      await sharp(buffer, { failOn: 'error' })
        .rotate()
        .raw()
        .toBuffer();
    } catch {
      throw new BadRequestException(
        'The uploaded file is not a valid supported image',
      );
    }
  }

  private mimeTypeForFormat(format: string): string | undefined {
    switch (format) {
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      default:
        return undefined;
    }
  }
}
