import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { unlink } from 'node:fs/promises';

export interface MediaStorageProvider {
  save(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<MediaRemovalResult>;
  retryPendingRemovals(): Promise<{ completed: number; pending: number }>;
}

export type MediaRemovalResult =
  | { status: 'removed' }
  | { status: 'queued' };

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

  async remove(key: string): Promise<MediaRemovalResult> {
    const filePath = this.resolveKey(key);
    try {
      await unlink(filePath);
      return { status: 'removed' };
    } catch (error: unknown) {
      if (this.errorCode(error) === 'ENOENT') {
        return { status: 'removed' };
      }

      await this.enqueueRemoval(key);
      return { status: 'queued' };
    }
  }

  async retryPendingRemovals(): Promise<{
    completed: number;
    pending: number;
  }> {
    const queueDirectory = join(this.rootDirectory, '.pending-cleanups');
    let jobs: string[];
    try {
      jobs = await readdir(queueDirectory);
    } catch (error: unknown) {
      if (this.errorCode(error) === 'ENOENT') {
        return { completed: 0, pending: 0 };
      }
      throw error;
    }

    let completed = 0;
    let pending = 0;
    for (const jobName of jobs.filter((name) => name.endsWith('.json'))) {
      const jobPath = join(queueDirectory, jobName);
      try {
        const job = JSON.parse(await readFile(jobPath, 'utf8')) as {
          key?: unknown;
        };
        if (typeof job.key !== 'string') {
          pending += 1;
          continue;
        }

        const filePath = this.resolveKey(job.key);
        try {
          await unlink(filePath);
        } catch (error: unknown) {
          if (this.errorCode(error) !== 'ENOENT') throw error;
        }
        await unlink(jobPath);
        completed += 1;
      } catch {
        pending += 1;
      }
    }

    return { completed, pending };
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

  private async enqueueRemoval(key: string): Promise<void> {
    const queueDirectory = join(this.rootDirectory, '.pending-cleanups');
    await mkdir(queueDirectory, { recursive: true });

    const jobName = `${createHash('sha256').update(key).digest('hex')}.json`;
    const jobPath = join(queueDirectory, jobName);
    const temporaryPath = join(queueDirectory, `${randomUUID()}.tmp`);
    await writeFile(temporaryPath, JSON.stringify({ key }), {
      flag: 'wx',
    });
    try {
      await link(temporaryPath, jobPath);
    } catch (error: unknown) {
      if (this.errorCode(error) !== 'EEXIST') throw error;
    } finally {
      try {
        await unlink(temporaryPath);
      } catch {
        // The retry worker ignores temporary files; the final job is authoritative.
      }
    }
  }

  private errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
      return undefined;
    }
    return typeof error.code === 'string' ? error.code : undefined;
  }
}
