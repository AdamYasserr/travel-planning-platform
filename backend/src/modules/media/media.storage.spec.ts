import { jest } from '@jest/globals';
import * as actualFs from 'node:fs/promises';

let failNextMediaUnlink = true;
const unlinkMock = jest.fn(async (path: Parameters<typeof actualFs.unlink>[0]) => {
  if (String(path).endsWith('image.jpg') && failNextMediaUnlink) {
    failNextMediaUnlink = false;
    throw Object.assign(new Error('file is temporarily locked'), {
      code: 'EPERM',
    });
  }
  return actualFs.unlink(path);
});

jest.unstable_mockModule('node:fs/promises', () => ({
  ...actualFs,
  unlink: unlinkMock,
}));

let LocalMediaStorage: typeof import('./media.storage.js').LocalMediaStorage;

describe('LocalMediaStorage cleanup retry queue', () => {
  beforeAll(async () => {
    ({ LocalMediaStorage } = await import('./media.storage.js'));
  });

  it('queues a failed deletion and removes the file on retry', async () => {
    const { mkdtemp, rm, stat } = actualFs;
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'media-storage-retry-'));
    const storage = new LocalMediaStorage({
      get: () => root,
    } as never);

    try {
      await storage.save('image.jpg', Buffer.from('image'));

      await expect(storage.remove('image.jpg')).resolves.toEqual({
        status: 'queued',
      });
      await expect(stat(join(root, 'image.jpg'))).resolves.toBeDefined();

      await expect(storage.retryPendingRemovals()).resolves.toEqual({
        completed: 1,
        pending: 0,
      });
      await expect(stat(join(root, 'image.jpg'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const jobs = await actualFs.readdir(join(root, '.pending-cleanups'));
      expect(jobs).toEqual([]);
      expect(unlinkMock).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
