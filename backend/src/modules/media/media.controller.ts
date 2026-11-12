import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
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
import type { Request, Response } from 'express';

import { UploadMediaDto } from './dto/upload-media.dto';
import { MediaService } from './media.service';

interface AuthenticatedRequest extends Request {
  user: { userId: string };
}

@Controller('media')
@ApiTags('Media')
@ApiCookieAuth('access_token')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post()
  @ApiOperation({ summary: 'Upload profile or activity media' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'JPG or PNG image up to 5 MB.',
    schema: {
      type: 'object',
      required: ['file', 'targetType'],
      properties: {
        file: { type: 'string', format: 'binary' },
        targetType: {
          type: 'string',
          enum: ['profile', 'activity'],
        },
        targetId: {
          type: 'string',
          description: 'Activity MongoDB ObjectId; required for activity images.',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Media uploaded successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid or unsupported image.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
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
  upload(
    @Req() request: AuthenticatedRequest,
    @UploadedFile()
    file:
      | {
          originalname: string;
          mimetype: string;
          size: number;
          buffer: Buffer;
        }
      | undefined,
    @Body() dto: UploadMediaDto,
  ) {
    return this.mediaService.upload(request.user.userId, dto, file);
  }

  @Get(':id/content')
  @ApiOperation({ summary: 'Retrieve owner-scoped media content' })
  @ApiParam({
    name: 'id',
    description: 'Media MongoDB ObjectId',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiResponse({ status: 200, description: 'Image bytes returned.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 404, description: 'Media not found or not accessible.' })
  async getContent(
    @Req() request: AuthenticatedRequest,
    @Param('id') mediaId: string,
    @Res() response: Response,
  ) {
    const content = await this.mediaService.getContent(
      request.user.userId,
      mediaId,
    );

    response.setHeader('Content-Type', content.mimeType);
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${content.originalName.replace(/["\\\r\n]/g, '_')}"`,
    );
    response.send(content.buffer);
  }
}