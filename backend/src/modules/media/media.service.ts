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
import { Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import sharp from 'sharp';

import { User, UserDocument } from '../../users/user.schema';
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

      return {
        message: 'Media uploaded successfully',
        media: this.toPublicMedia(media),
      };
    } catch (error: unknown) {
      if (media) {
        try {
          await this.mediaModel.deleteOne({ _id: media._id }).exec();
        } catch {
          this.logger.warn('Media metadata cleanup failed after upload error');
        }
      }

      try {
        await this.storage.remove(storageKey);
      } catch {
        this.logger.warn('Media file cleanup failed after upload error');
      }

      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
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
    await this.mediaModel.deleteOne({ _id: imageObjectId }).exec();

    try {
      await this.storage.remove(media.storageKey);
    } catch {
      this.logger.warn('Activity image file cleanup failed after deletion');
    }

    return { message: 'Activity image deleted successfully' };
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
        _id: mediaId,
        ownerId: new Types.ObjectId(ownerId),
        targetType: {
          $in: [MediaTargetType.PROFILE, MediaTargetType.ACTIVITY],
        },
      })
      .select('+storageKey')
      .exec();

    if (!media) {
      throw new NotFoundException('Media not found');
    }

    return {
      buffer: await this.storage.read(media.storageKey),
      mimeType: media.mimeType,
      originalName: media.originalName,
    };
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
      url: `/api/media/${media._id.toString()}/content`,
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