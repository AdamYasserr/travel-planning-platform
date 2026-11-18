
import {
  Controller,
  Body,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
} from '@nestjs/common';
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

import { Public } from '../../common/decorators/public.decorator';
import { UploadMediaDto } from './dto/upload-media.dto';
import { ImageUpload } from './media.limits';
import { MediaService } from './media.service';

interface AuthenticatedRequest extends Request {
  user: { userId: string };
}

@Controller('media')
@ApiTags('Media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post()
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Upload profile, provider, or community post media' })
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
          enum: ['profile', 'hotel', 'airline', 'post', 'comment', 'activity'],
        },
        targetId: {
          type: 'string',
            description: 'Required for hotel, airline, post, comment, and activity uploads.',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Media uploaded successfully.' })
  @ApiResponse({
    status: 400,
    description: 'Missing, oversized, malformed, or unsupported image.',
  })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({
    status: 403,
    description: 'The user is not authorized to upload to this target.',
  })
  @ImageUpload()
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

  @Delete(':id')
  @ApiCookieAuth('access_token')
  @ApiOperation({
    summary: 'Remove a hotel photo or airline logo',
  })
  @ApiParam({
    name: 'id',
    description: 'Media MongoDB ObjectId',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiResponse({ status: 200, description: 'Media removed successfully.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({
    status: 403,
    description: 'The user is not authorized to remove this media.',
  })
  @ApiResponse({ status: 404, description: 'Media not found.' })
  removePublicMedia(
    @Req() request: AuthenticatedRequest,
    @Param('id') mediaId: string,
  ) {
    return this.mediaService.removePublicMedia(
      request.user.userId,
      mediaId,
    );
  }

  @Public()
  @Get('public/:id/content')
  @ApiOperation({
    summary: 'Retrieve public hotel or airline media content',
  })
  @ApiParam({
    name: 'id',
    description: 'Media MongoDB ObjectId',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiResponse({ status: 200, description: 'Public image content returned.' })
  @ApiResponse({ status: 404, description: 'Media not found.' })
  async getPublicContent(
    @Param('id') mediaId: string,
    @Res() response: Response,
  ) {
    const content = await this.mediaService.getPublicContent(mediaId);

    response.setHeader('Content-Type', content.mimeType);
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${content.originalName.replace(/["\\\r\n]/g, '_')}"`,
    );
    response.send(content.buffer);
  }

  @Get(':id/content')
  @ApiCookieAuth('access_token')
  @ApiOperation({
    summary: 'Retrieve owner-scoped private profile media content',
  })
  @ApiParam({
    name: 'id',
    description: 'Media MongoDB ObjectId',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiResponse({ status: 200, description: 'Private image content returned.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({
    status: 404,
    description: 'Media not found or not accessible.',
  })
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
