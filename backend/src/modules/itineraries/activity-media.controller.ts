import {
  BadRequestException,
  Controller,
  Param,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { MediaTargetType } from '../media/dto/upload-media.dto';
import { MediaService } from '../media/media.service';

interface AuthenticatedRequest extends Request {
  user: { userId: string };
}

@Controller('activities')
@ApiTags('Activities')
@ApiCookieAuth('access_token')
export class ActivityMediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post(':id/images')
  @ApiOperation({ summary: 'Upload an image for an itinerary activity' })
  @ApiParam({
    name: 'id',
    description: 'Activity MongoDB ObjectId',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'JPG or PNG image up to 5 MB.',
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Activity image uploaded.' })
  @ApiResponse({ status: 400, description: 'Invalid or unsupported image.' })
  @ApiResponse({ status: 404, description: 'Activity not found.' })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
      fileFilter: (_request, file, callback) => {
        const allowedExtensions = /\.(jpe?g|png)$/i;
        const allowedMimeTypes = /^image\/(jpeg|png)$/i;

        if (
          !allowedExtensions.test(file.originalname) ||
          !allowedMimeTypes.test(file.mimetype)
        ) {
          callback(
            new BadRequestException(
              'Only JPG and PNG image files are supported',
            ),
            false,
          );
          return;
        }

        callback(null, true);
      },
    }),
  )
  uploadActivityImage(
    @Req() request: AuthenticatedRequest,
    @Param('id') activityId: string,
    @UploadedFile()
    file:
      | {
          originalname: string;
          mimetype: string;
          size: number;
          buffer: Buffer;
        }
      | undefined,
  ) {
    return this.mediaService.upload(
      request.user.userId,
      {
        targetType: MediaTargetType.ACTIVITY,
        targetId: activityId,
      },
      file,
    );
  }
}