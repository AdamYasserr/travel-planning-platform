
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { UserRole } from '../../common/enums/user-role.enum';
import { Hotel } from '../hotels/schemas/hotel.schema';
import { Airline } from '../airlines/schemas/airline.schema';
import { Post } from '../blog/schemas/post.schema';
import { Comment } from '../blog/schemas/comment.schema';
import { CommentStatus, PostStatus } from '../blog/enums/post-status.enum';
import { MediaTargetType, UploadMediaDto } from './dto/upload-media.dto';
import { Media, MediaDocument } from './schemas/media.schema';
import { LocalMediaStorage } from './media.storage';
import {
  IMAGE_SIZE_MESSAGE,
  MAX_ACTIVITY_IMAGES,
  MAX_HOTEL_PHOTOS,
  MAX_IMAGE_BYTES,
  MAX_POST_IMAGES,
} from './media.limits';
import { Itinerary } from '../itineraries/schemas/itinerary.schema';
import { ItineraryVisibility } from '../itineraries/enums/itinerary-visibility.enum';

interface UploadedMediaFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const ALLOWED_MEDIA: Record<
  string,
  {
    mimeType: string;
    matches: (buffer: Buffer) => boolean;
  }
> = {
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

const MAX_FILE_SIZE = MAX_IMAGE_BYTES;
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
    @InjectModel(Hotel.name)
    private readonly hotelModel: Model<Hotel>,
    @InjectModel(Airline.name)
    private readonly airlineModel: Model<Airline>,
    @InjectModel(Post.name)
    private readonly postModel: Model<Post>,
    @InjectModel(Comment.name)
    private readonly commentModel: Model<Comment>,
    private readonly storage: LocalMediaStorage,
    @InjectModel(Itinerary.name)
    private readonly itineraryModel: Model<Itinerary>,
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
      .exec();

    if (!owner) {
      throw new UnauthorizedException('Account is unavailable');
    }

    if (dto.targetType === MediaTargetType.PROFILE) {
      if (dto.targetId) {
        throw new BadRequestException(
          'Profile media must not include targetId',
        );
      }
    } else {
      if (!dto.targetId || !Types.ObjectId.isValid(dto.targetId)) {
        throw new BadRequestException(
          'A valid targetId is required for this media type',
        );
      }

      await this.checkTargetPermission(
        owner,
        dto.targetType,
        dto.targetId,
      );
    }

    if (
      file.size < 1 ||
      file.size > MAX_FILE_SIZE ||
      !Buffer.isBuffer(file.buffer) ||
      file.buffer.length < 1 ||
      file.buffer.length !== file.size
    ) {
      throw new BadRequestException(IMAGE_SIZE_MESSAGE);
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
    if (dto.targetType === MediaTargetType.ACTIVITY) await this.assertActivityHasRoom(dto.targetId!);

    const storageKey = `${randomUUID()}${extension}`;
    await this.storage.save(storageKey, file.buffer);

    let createdMedia: MediaDocument | null = null;
    let targetIsPublic = false;

    try {
      createdMedia = await this.mediaModel.create({
        ownerId: new Types.ObjectId(ownerId),
        targetType: dto.targetType,
        targetId: dto.targetId
          ? new Types.ObjectId(dto.targetId)
          : null,
        originalName: this.sanitizeFilename(
          file.originalname,
          extension,
        ),
        mimeType: mediaType.mimeType,
        extension,
        size: file.size,
        storageKey,
      });

      if (dto.targetType === MediaTargetType.HOTEL) {
        targetIsPublic = true;
        const publicUrl = this.publicMediaUrl(createdMedia._id.toString());

        const updatedHotel = await this.hotelModel
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(dto.targetId),
              $expr: {
                $lt: [
                  { $size: { $ifNull: ['$photos', []] } },
                  MAX_HOTEL_PHOTOS,
                ],
              },
            },
            {
              $push: { photos: publicUrl },
            },
            { returnDocument: 'after', runValidators: true },
          )
          .exec();

        if (!updatedHotel) {
          throw new ConflictException(
            'Hotel not found or already has the maximum of 5 photos',
          );
        }
      }

      if (dto.targetType === MediaTargetType.AIRLINE) {
        targetIsPublic = true;
        const publicUrl = this.publicMediaUrl(createdMedia._id.toString());

        const updatedAirline = await this.airlineModel
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(dto.targetId),
              $or: [
                { logo: null },
                { logo: { $exists: false } },
              ],
            },
            {
              $set: { logo: publicUrl },
            },
            { returnDocument: 'after', runValidators: true },
          )
          .exec();

        if (!updatedAirline) {
          throw new ConflictException(
            'Airline not found or already has a logo',
          );
        }
      }

      if (dto.targetType === MediaTargetType.POST) {
        const updatedPost = await this.postModel
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(dto.targetId),
              authorId: new Types.ObjectId(ownerId),
              status: { $in: [PostStatus.DRAFT, PostStatus.PUBLISHED] },
              $expr: {
                $lt: [
                  { $size: { $ifNull: ['$mediaIds', []] } },
                  MAX_POST_IMAGES,
                ],
              },
            },
            { $addToSet: { mediaIds: createdMedia._id } },
            { returnDocument: 'after' },
          )
          .exec();
        if (!updatedPost) {
          throw new ConflictException('Post not found or already has the maximum of 5 images');
        }
        targetIsPublic = updatedPost.status === PostStatus.PUBLISHED;
      }

      if (dto.targetType === MediaTargetType.ACTIVITY) {
        // The cap is part of the update filter, so two uploads at once can never reach a 6th image.
        const activityId = new Types.ObjectId(dto.targetId);
        const pushed = await this.itineraryModel
          .updateOne(
            {
              ownerId: new Types.ObjectId(ownerId),
              days: { $elemMatch: { activities: { $elemMatch: { _id: activityId, [`mediaIds.${MAX_ACTIVITY_IMAGES - 1}`]: { $exists: false } } } } },
            },
            { $push: { 'days.$[d].activities.$[a].mediaIds': createdMedia._id } },
            { arrayFilters: [{ 'd.activities._id': activityId }, { 'a._id': activityId }] },
          )
          .exec();
        if (pushed.modifiedCount !== 1) {
          throw new ConflictException(`Activity not found or already has the maximum of ${MAX_ACTIVITY_IMAGES} images`);
        }
      }

      if (dto.targetType === MediaTargetType.COMMENT) {
        const updatedComment = await this.commentModel
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(dto.targetId),
              authorId: new Types.ObjectId(ownerId),
              status: CommentStatus.VISIBLE,
            },
            { $addToSet: { mediaIds: createdMedia._id } },
            { returnDocument: 'after' },
          )
          .exec();
        if (!updatedComment) {
          throw new ConflictException('Comment is no longer available for media');
        }
        targetIsPublic = true;
      }

      return {
        message: 'Media uploaded successfully',
        media: this.toPublicMedia(createdMedia, targetIsPublic),
      };
    } catch (error: unknown) {
      if (createdMedia) {
        await this.mediaModel.deleteOne({ _id: createdMedia._id }).exec();
      }

      try {
        await this.storage.remove(storageKey);
      } catch {
        this.logger.warn(
          'Media cleanup failed after upload persistence error',
        );
      }

      if (error instanceof ConflictException) {
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

      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException ||
        error instanceof UnauthorizedException
      ) {
        throw error;
      }

      this.logger.error('Could not complete media upload', error);
      throw new InternalServerErrorException(
        'Could not save media metadata',
      );
    }
  }

  private async checkTargetPermission(
    owner: UserDocument,
    targetType: MediaTargetType,
    targetId: string,
  ): Promise<void> {
    const targetObjectId = new Types.ObjectId(targetId);

    if (targetType === MediaTargetType.HOTEL) {
      const assignedHotelId =
        owner.hotelId && Types.ObjectId.isValid(owner.hotelId)
          ? new Types.ObjectId(owner.hotelId).toString()
          : null;

      if (
        owner.role !== UserRole.MODERATOR ||
        assignedHotelId !== targetObjectId.toString()
      ) {
        throw new ForbiddenException(
          'You can only upload photos for the hotel assigned to your account',
        );
      }

      const hotel = await this.hotelModel
        .findOne({ _id: targetObjectId, isActive: true })
        .select('_id')
        .exec();

      if (!hotel) {
        throw new NotFoundException('Hotel not found or inactive');
      }

      return;
    }

    if (targetType === MediaTargetType.AIRLINE) {
      const assignedAirlineId =
        owner.airlineId && Types.ObjectId.isValid(owner.airlineId)
          ? new Types.ObjectId(owner.airlineId).toString()
          : null;

      const isAdmin = owner.role === UserRole.ADMIN;
      const isAssignedModerator =
        owner.role === UserRole.MODERATOR &&
        assignedAirlineId === targetObjectId.toString();

      if (!isAdmin && !isAssignedModerator) {
        throw new ForbiddenException(
          'You are not authorized to upload a logo for this airline',
        );
      }

      const airline = await this.airlineModel
        .findOne({ _id: targetObjectId, isActive: true })
        .select('_id')
        .exec();

      if (!airline) {
        throw new NotFoundException('Airline not found or inactive');
      }

      return;
    }

    if (targetType === MediaTargetType.POST) {
      const post = await this.postModel
        .findById(targetObjectId)
        .select('_id authorId status')
        .exec();
      if (!post || post.status === PostStatus.DELETED) {
        throw new NotFoundException('Post not found');
      }
      if (post.authorId.toString() !== owner._id.toString()) {
        throw new ForbiddenException('Only the post author can upload images');
      }
      const count = await this.mediaModel.countDocuments({
        targetType: MediaTargetType.POST,
        targetId: targetObjectId,
      }).exec();
      if (count >= MAX_POST_IMAGES) {
        throw new ConflictException('A post can have at most 5 images');
      }
      return;
    }

    if (targetType === MediaTargetType.COMMENT) {
      const comment = await this.commentModel
        .findById(targetObjectId)
        .select('_id authorId postId status')
        .exec();
      if (!comment || comment.status === CommentStatus.DELETED) {
        throw new NotFoundException('Comment not found');
      }
      if (comment.authorId.toString() !== owner._id.toString()) {
        throw new ForbiddenException('Only the comment author can upload images');
      }
      const post = await this.postModel
        .findOne({ _id: comment.postId, status: PostStatus.PUBLISHED })
        .select('_id')
        .exec();
      if (!post) throw new NotFoundException('Post not found');
      return;
    }

    if (targetType === MediaTargetType.ACTIVITY) {
      // ITN-12: only the itinerary's owner. Another user's activity is a 404, like every itinerary route.
      const owned = await this.itineraryModel.exists({ ownerId: owner._id, 'days.activities._id': targetObjectId });
      if (!owned) throw new NotFoundException('Activity not found');
      return;
    }

    throw new BadRequestException('Unsupported media target type');
  }

  async removePublicMedia(ownerId: string, mediaId: string) {
    if (!Types.ObjectId.isValid(ownerId)) {
      throw new UnauthorizedException('Invalid authenticated user');
    }

    if (!Types.ObjectId.isValid(mediaId)) {
      throw new NotFoundException('Media not found');
    }

    const owner = await this.userModel
      .findOne({
        _id: ownerId,
        isActive: true,
        isSuspended: false,
        deactivatedAt: null,
      })
      .exec();

    if (!owner) {
      throw new UnauthorizedException('Account is unavailable');
    }

    const media = await this.mediaModel
      .findOne({
        _id: mediaId,
        targetType: {
          $in: [MediaTargetType.HOTEL, MediaTargetType.AIRLINE],
        },
      })
      .select('+storageKey')
      .exec();

    if (!media || (media.targetType !== MediaTargetType.PROFILE && !media.targetId)) {
      throw new NotFoundException('Media not found');
    }

    await this.checkTargetPermission(
      owner,
      media.targetType,
      media.targetId!.toString(),
    );

    const publicUrl = this.publicMediaUrl(mediaId);

    if (media.targetType === MediaTargetType.HOTEL) {
      const hotel = await this.hotelModel
        .findByIdAndUpdate(
          media.targetId,
          { $pull: { photos: publicUrl } },
          { returnDocument: 'after' },
        )
        .exec();

      if (!hotel) {
        throw new NotFoundException('Hotel not found');
      }
    }

    if (media.targetType === MediaTargetType.AIRLINE) {
      const airline = await this.airlineModel
        .findOneAndUpdate(
          {
            _id: media.targetId,
            logo: publicUrl,
          },
          { $set: { logo: null } },
          { returnDocument: 'after' },
        )
        .exec();

      if (!airline) {
        throw new NotFoundException(
          'Airline not found or this media is no longer its logo',
        );
      }
    }

    await this.storage.remove(media.storageKey);
    await this.mediaModel.deleteOne({ _id: media._id }).exec();

    return {
      message: 'Media removed successfully',
      mediaId,
    };
  }

  async getContent(ownerId: string, mediaId: string) {
    if (!Types.ObjectId.isValid(mediaId)) {
      throw new NotFoundException('Media not found');
    }

    const media = await this.mediaModel
      .findOne({
        _id: mediaId,
        ownerId: new Types.ObjectId(ownerId),
        targetType: { $in: [MediaTargetType.PROFILE, MediaTargetType.POST, MediaTargetType.COMMENT, MediaTargetType.ACTIVITY] },
      })
      .select('+storageKey')
      .exec();

    if (!media || (media.targetType !== MediaTargetType.PROFILE && !media.targetId)) {
      throw new NotFoundException('Media not found');
    }

    if (media.targetType !== MediaTargetType.PROFILE) {
      const owner = await this.userModel.findOne({ _id: ownerId, isActive: true, isSuspended: false, deactivatedAt: null }).exec();
      if (!owner) throw new UnauthorizedException('Account is unavailable');
      if (!media.targetId) throw new NotFoundException('Media not found');
      await this.checkTargetPermission(owner, media.targetType, media.targetId.toString());
    }

    return {
      buffer: await this.storage.read(media.storageKey),
      mimeType: media.mimeType,
      originalName: media.originalName,
    };
  }

  async getPublicContent(mediaId: string) {
    if (!Types.ObjectId.isValid(mediaId)) {
      throw new NotFoundException('Media not found');
    }

    const media = await this.mediaModel
      .findOne({
        _id: mediaId,
        targetType: {
          $in: [MediaTargetType.HOTEL, MediaTargetType.AIRLINE, MediaTargetType.POST, MediaTargetType.COMMENT, MediaTargetType.ACTIVITY],
        },
      })
      .select('+storageKey')
      .exec();

    if (!media || !media.targetId) {
      throw new NotFoundException('Media not found');
    }

    if (media.targetType === MediaTargetType.POST) {
      const post = await this.postModel.findOne({ _id: media.targetId, status: PostStatus.PUBLISHED }).select('_id').exec();
      if (!post) throw new NotFoundException('Media not found');
    }
    if (media.targetType === MediaTargetType.ACTIVITY) {
      // ITN-12: an activity image is public only while its itinerary is public (hidden or made private: 404).
      const visible = await this.itineraryModel.exists({ visibility: ItineraryVisibility.PUBLIC, 'days.activities._id': media.targetId });
      if (!visible) throw new NotFoundException('Media not found');
    }
    if (media.targetType === MediaTargetType.COMMENT) {
      const comment = await this.commentModel.findOne({ _id: media.targetId, status: CommentStatus.VISIBLE }).select('postId').exec();
      if (!comment) throw new NotFoundException('Media not found');
      const post = await this.postModel.findOne({ _id: comment.postId, status: PostStatus.PUBLISHED }).select('_id').exec();
      if (!post) throw new NotFoundException('Media not found');
    }

    return {
      buffer: await this.storage.read(media.storageKey),
      mimeType: media.mimeType,
      originalName: media.originalName,
    };
  }

  private publicMediaUrl(mediaId: string): string {
    return `/api/media/public/${mediaId}/content`;
  }

  private toPublicMedia(media: MediaDocument, publicContent?: boolean) {
    const isPublic =
      media.targetType === MediaTargetType.HOTEL ||
      media.targetType === MediaTargetType.AIRLINE ||
      publicContent === true;

    return {
      id: media._id.toString(),
      targetType: media.targetType,
      targetId: media.targetId?.toString() ?? null,
      originalName: media.originalName,
      mimeType: media.mimeType,
      size: media.size,
      url: isPublic
        ? this.publicMediaUrl(media._id.toString())
        : `/api/media/${media._id.toString()}/content`,
      createdAt: media.createdAt,
    };
  }

  async listTargetMedia(targetType: MediaTargetType.POST | MediaTargetType.COMMENT, targetId: string, publicContent = false) {
    const rows = await this.mediaModel
      .find({ targetType, targetId: new Types.ObjectId(targetId) })
      .sort({ createdAt: 1 })
      .exec();
    return rows.map((media) => this.toPublicMedia(media, publicContent));
  }

  async removeTargetMedia(ownerId: string, targetType: MediaTargetType.POST | MediaTargetType.COMMENT, targetId: string, mediaId: string, moderation = false) {
    if (!Types.ObjectId.isValid(targetId) || !Types.ObjectId.isValid(mediaId)) {
      throw new BadRequestException('Invalid media target');
    }
    const media = await this.mediaModel
      .findOne({ _id: mediaId, targetType, targetId })
      .select('+storageKey')
      .exec();
    if (!media) throw new NotFoundException('Media not found');
    if (moderation) {
      const exists = targetType === MediaTargetType.POST
        ? await this.postModel.exists({ _id: targetId })
        : await this.commentModel.exists({ _id: targetId });
      if (!exists) throw new NotFoundException('Content not found');
    } else {
      const owner = await this.userModel.findOne({ _id: ownerId, isActive: true, isSuspended: false, deactivatedAt: null }).exec();
      if (!owner) throw new UnauthorizedException('Account is unavailable');
      await this.checkTargetPermission(owner, targetType, targetId);
    }
    await this.storage.remove(media.storageKey);
    if (targetType === MediaTargetType.POST) {
      await this.postModel.updateOne({ _id: targetId }, { $pull: { mediaIds: media._id } }).exec();
    } else {
      await this.commentModel.updateOne({ _id: targetId }, { $pull: { mediaIds: media._id } }).exec();
    }
    await this.mediaModel.deleteOne({ _id: media._id }).exec();
    return { mediaId, removed: true };
  }

  async deleteTargetMedia(ownerId: string, targetType: MediaTargetType.POST | MediaTargetType.COMMENT, targetId: string, moderation = false) {
    const mediaRows = await this.mediaModel
      .find({ targetType, targetId: new Types.ObjectId(targetId) })
      .select('+storageKey')
      .exec();
    for (const media of mediaRows) {
      await this.removeTargetMedia(ownerId, targetType, targetId, media._id.toString(), moderation);
    }
  }

  /** 409 when the activity already has the maximum number of images (the update filter re-checks atomically). */
  private async assertActivityHasRoom(activityId: string) {
    const count = await this.mediaModel
      .countDocuments({ targetType: MediaTargetType.ACTIVITY, targetId: new Types.ObjectId(activityId) })
      .exec();
    if (count >= MAX_ACTIVITY_IMAGES) {
      throw new ConflictException(`An activity can have at most ${MAX_ACTIVITY_IMAGES} images`);
    }
  }

  /**
   * ITN-12: removes one image of an activity (file, link and metadata). Only the itinerary's owner;
   * an unknown activity or image, or someone else's, is a 404.
   */
  async removeActivityImage(ownerId: string, activityId: string, mediaId: string) {
    if (!Types.ObjectId.isValid(activityId) || !Types.ObjectId.isValid(mediaId)) {
      throw new BadRequestException('Invalid media target');
    }
    if (!Types.ObjectId.isValid(ownerId)) throw new UnauthorizedException('Invalid authenticated user');
    const owner = await this.userModel
      .findOne({ _id: ownerId, isActive: true, isSuspended: false, deactivatedAt: null })
      .exec();
    if (!owner) throw new UnauthorizedException('Account is unavailable');
    await this.checkTargetPermission(owner, MediaTargetType.ACTIVITY, activityId);

    const media = await this.mediaModel
      .findOne({ _id: mediaId, targetType: MediaTargetType.ACTIVITY, targetId: new Types.ObjectId(activityId) })
      .select('+storageKey')
      .exec();
    if (!media) throw new NotFoundException('Media not found');

    const id = new Types.ObjectId(activityId);
    await this.itineraryModel
      .updateOne(
        { ownerId: owner._id, 'days.activities._id': id },
        { $pull: { 'days.$[d].activities.$[a].mediaIds': media._id } },
        { arrayFilters: [{ 'd.activities._id': id }, { 'a._id': id }] },
      )
      .exec();
    await this.storage.remove(media.storageKey);
    await this.mediaModel.deleteOne({ _id: media._id }).exec();
    return { mediaId, removed: true };
  }

  /** Best effort: deletes the images of activities that were removed (with their day or itinerary). */
  async deleteActivityMedia(activityIds: Types.ObjectId[]) {
    if (!activityIds.length) return;
    const rows = await this.mediaModel
      .find({ targetType: MediaTargetType.ACTIVITY, targetId: { $in: activityIds } })
      .select('+storageKey')
      .exec();
    for (const media of rows) {
      try {
        await this.storage.remove(media.storageKey);
      } catch {
        this.logger.warn('Activity image file could not be removed');
      }
    }
    await this.mediaModel.deleteMany({ _id: { $in: rows.map((media) => media._id) } }).exec();
  }

  private sanitizeFilename(
    originalName: string,
    extension: string,
  ): string {
    const baseName = originalName
      .replace(/[\/\\\0-\x1f\x7f]/g, '_')
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
