import {
  applyDecorators,
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  PayloadTooLargeException,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

/**
 * GEN-08: the one set of upload limits. Every image upload endpoint (POST /media, POST /posts/:id/images,
 * POST /activities/:id/images) uses these, and MediaService enforces them again by content.
 *
 *   - JPG or PNG only, checked by extension, MIME type, magic bytes and a real decode
 *   - 1 byte to 5 MB per file, one file per request
 *   - at most 5 photos per hotel, 5 images per post, 5 images per activity (409 when a 6th is added),
 *     one logo per airline
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_HOTEL_PHOTOS = 5;
export const MAX_POST_IMAGES = 5;
export const MAX_ACTIVITY_IMAGES = 5;

export const IMAGE_SIZE_MESSAGE = 'Media file must be between 1 byte and 5 MB';
export const IMAGE_TYPE_MESSAGE = 'Only JPG and PNG image files are supported';

export const imageUploadOptions = {
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (
    _request: unknown,
    file: { originalname: string; mimetype: string },
    callback: (error: Error | null, accept: boolean) => void,
  ) => {
    const valid = /\.(jpe?g|png)$/i.test(file.originalname) && /^image\/(jpeg|png)$/i.test(file.mimetype);
    callback(valid ? null : new BadRequestException(IMAGE_TYPE_MESSAGE), valid);
  },
};

/** multer reports an oversized file as 413; every upload endpoint documents (and returns) 400 instead. */
@Catch(PayloadTooLargeException)
export class OversizedImageFilter implements ExceptionFilter {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost) {
    host.switchToHttp().getResponse<Response>().status(400).json({
      statusCode: 400,
      message: IMAGE_SIZE_MESSAGE,
      error: 'Bad Request',
    });
  }
}

/** The multipart `file` field of an image upload, with the shared limits and the 400 for an oversized file. */
export const ImageUpload = () =>
  applyDecorators(UseInterceptors(FileInterceptor('file', imageUploadOptions)), UseFilters(OversizedImageFilter));
