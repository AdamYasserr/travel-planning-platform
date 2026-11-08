import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { unlink } from 'node:fs/promises';

export interface MediaStorageProvider {
  save(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

@Injectable()
export class LocalMediaStorage implements MediaStorageProvider {
  private readonly rootDirectory: string;

  constructor(configService: ConfigService) {
    this.rootDirectory =
      resolve(
        configService.get<string>('media.storagePath') ?? 'uploads/media',
      );
  }

  async save(key: string, data: Buffer): Promise<void> {
    const filePath = this.resolveKey(key);
    try {
      await mkdir(this.rootDirectory, { recursive: true });
      await writeFile(filePath, data, {
        flag: 'wx',
      });
    } catch {
      throw new InternalServerErrorException('Could not store media file');
    }
  }

  async read(key: string): Promise<Buffer> {
    const filePath = this.resolveKey(key);
    try {
      return await readFile(filePath);
    } catch {
      throw new NotFoundException('Media file is not available');
    }
  }

  async remove(key: string): Promise<void> {
    const filePath = this.resolveKey(key);
    try {
      await unlink(filePath);
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }
  }

  private resolveKey(key: string): string {
    if (
      !key ||
      isAbsolute(key) ||
      key.includes('/') ||
      key.includes('\\') ||
      key === '.' ||
      key === '..'
    ) {
      throw new InternalServerErrorException('Invalid media storage key');
    }

    const filePath = resolve(join(this.rootDirectory, key));
    const relativePath = relative(this.rootDirectory, filePath);
    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      isAbsolute(relativePath)
    ) {
      throw new InternalServerErrorException('Invalid media storage key');
    }

    return filePath;
  }
}
