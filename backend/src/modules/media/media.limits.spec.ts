import { jest } from '@jest/globals';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

import { IMAGE_SIZE_MESSAGE, imageUploadOptions, MAX_IMAGE_BYTES, OversizedImageFilter } from './media.limits';

describe('shared upload limits (GEN-08)', () => {
  const run = (originalname: string, mimetype: string) => {
    let result: { error: Error | null; accept: boolean } | undefined;
    imageUploadOptions.fileFilter({}, { originalname, mimetype }, (error, accept) => (result = { error, accept }));
    return result!;
  };

  it('allows 5 MB and one file per request', () => {
    expect(imageUploadOptions.limits).toEqual({ fileSize: 5 * 1024 * 1024, files: 1 });
    expect(MAX_IMAGE_BYTES).toBe(5_242_880);
  });

  it('accepts JPG and PNG by name and MIME type, rejects everything else with 400', () => {
    expect(run('a.png', 'image/png').accept).toBe(true);
    expect(run('a.JPG', 'image/jpeg').accept).toBe(true);
    expect(run('a.jpeg', 'image/jpeg').accept).toBe(true);
    for (const [name, type] of [['a.gif', 'image/gif'], ['a.png', 'text/plain'], ['a.txt', 'image/png'], ['a', 'image/png']]) {
      const { error, accept } = run(name, type);
      expect(accept).toBe(false);
      expect(error).toBeInstanceOf(BadRequestException);
    }
  });

  it("answers multer's 413 with a 400 that names the limit", () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) };
    new OversizedImageFilter().catch(new PayloadTooLargeException(), host as never);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ statusCode: 400, message: IMAGE_SIZE_MESSAGE, error: 'Bad Request' });
  });
});
