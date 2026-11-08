import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Injectable,
  Logger,
  NotImplementedException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import sharp from 'sharp';

import { User, UserDocument } from '../../users/user.schema';
import { MediaTargetType, UploadMediaDto } from './dto/upload-media.dto';
import { Media, MediaDocument } from './schemas/media.schema';
import { LocalMediaStorage } from './media.storage';

interface UploadedMediaFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const ALLOWED_MEDIA: Record<string, {
  mimeType: string;
  matches: (buffer: Buffer) => boolean;
}> = {
  '.jpg': {
    mimeType: 'image/jpeg',
    matches: isJpeg,
  },
  '.jpeg': {
    mimeType: 'image/jpeg',
    matches: isJpeg,
  },
  '.png': {
    mimeType: 'image/png',
    matches: isPng,
  },
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

    const owner = await this.userModel
      .findOne({
        _id: ownerId,
        isActive: true,
        isSuspended: false,
        deactivatedAt: null,
      })
      .select('_id');
    if (!owner) {
      throw new UnauthorizedException('Account is unavailable');
    }

    if (dto.targetType !== MediaTargetType.PROFILE) {
      throw new NotImplementedException(
        'Content media attachment requires the target module ownership contract',
      );
    }

    if (dto.targetType === MediaTargetType.PROFILE && dto.targetId) {
      throw new BadRequestException(
        'Profile media must not include targetId',
      );
    }

    if (
      file.size < 1 ||
      file.size > MAX_FILE_SIZE ||
      !Buffer.isBuffer(file.buffer) ||
      file.buffer.length < 1 ||
      file.buffer.length !== file.size
    ) {
      throw new BadRequestException('Media file must be between 1 byte and 5 MB');
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

    try {
      const media = await this.mediaModel.create({
        ownerId: new Types.ObjectId(ownerId),
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

      return {
        message: 'Media uploaded successfully',
        media: this.toPublicMedia(media),
      };
    } catch (error: unknown) {
      try {
        await this.storage.remove(storageKey);
      } catch {
        this.logger.warn('Media cleanup failed after metadata persistence error');
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
        'Could not save media metadata',
      );
    }
  }

  async getContent(ownerId: string, mediaId: string) {
    if (!Types.ObjectId.isValid(mediaId)) {
      throw new NotFoundException('Media not found');
    }

    const media = await this.mediaModel
      .findOne({
        _id: mediaId,
        ownerId: new Types.ObjectId(ownerId),
        targetType: MediaTargetType.PROFILE,
      })
      .select('+storageKey');

    if (!media) {
      throw new NotFoundException('Media not found');
    }

    return {
      buffer: await this.storage.read(media.storageKey),
      mimeType: media.mimeType,
      originalName: media.originalName,
    };
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
      const image = sharp(buffer, {
        failOn: 'error',
      });
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

      await sharp(buffer, {
        failOn: 'error',
      })
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