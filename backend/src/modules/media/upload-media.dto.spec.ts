import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MediaTargetType, UploadMediaDto } from './dto/upload-media.dto';

describe('UploadMediaDto post targets', () => {
  it('requires a valid target ID for post uploads', async () => {
    const valid = plainToInstance(UploadMediaDto, {
      targetType: MediaTargetType.POST,
      targetId: '507f1f77bcf86cd799439011',
    });
    await expect(validate(valid)).resolves.toHaveLength(0);

    for (const targetId of [undefined, 'invalid']) {
      const invalid = plainToInstance(UploadMediaDto, {
        targetType: MediaTargetType.POST,
        targetId,
      });
      await expect(validate(invalid)).resolves.not.toHaveLength(0);
    }
  });
});
