import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  CreateCommentDto,
  CreatePostDto,
  SearchPostsQueryDto,
  UpdateCommentDto,
  UpdatePostDto,
  UpdatePostTagsDto,
} from './dto/blog.dto';
import { PostStatus } from './enums/post-status.enum';

describe('Blog Phase 1 DTO validation', () => {
  it('accepts Draft and Published post payloads with optional tags', async () => {
    for (const status of [PostStatus.DRAFT, PostStatus.PUBLISHED]) {
      const dto = plainToInstance(CreatePostDto, {
        title: '  Trip  ',
        body: '  Story  ',
        status,
        tags: ['  Egypt  '],
      });

      await expect(validate(dto)).resolves.toHaveLength(0);
      expect(dto.title).toBe('Trip');
      expect(dto.tags).toEqual(['Egypt']);
    }
  });

  it.each([
    { body: 'Story', status: PostStatus.DRAFT },
    { title: 'Trip', status: PostStatus.PUBLISHED },
    { title: ' ', body: 'Story', status: PostStatus.DRAFT },
    { title: 'Trip', body: '  ', status: PostStatus.PUBLISHED },
    { title: 'Trip', body: 'Story', status: 'invalid' },
  ])('rejects invalid post fields: %j', async (payload) => {
    const dto = plainToInstance(CreatePostDto, payload);
    await expect(validate(dto)).resolves.not.toHaveLength(0);
  });

  it('allows omitted tags on post creation', async () => {
    const dto = plainToInstance(CreatePostDto, {
      title: 'Trip',
      body: 'Story',
      status: PostStatus.DRAFT,
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('accepts an empty tag list to clear all tags', async () => {
    const dto = plainToInstance(UpdatePostTagsDto, { tags: [] });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('trims tag values and enforces the five-tag and 30-character limits', async () => {
    const valid = plainToInstance(UpdatePostTagsDto, {
      tags: ['  Egypt  ', 'Alexandria'],
    });
    await expect(validate(valid)).resolves.toHaveLength(0);
    expect(valid.tags).toEqual(['Egypt', 'Alexandria']);

    for (const tags of [
      ['a', 'b', 'c', 'd', 'e', 'f'],
      ['x'.repeat(31)],
      ['   '],
    ]) {
      const invalid = plainToInstance(UpdatePostTagsDto, { tags });
      await expect(validate(invalid)).resolves.not.toHaveLength(0);
    }
  });

  it('enforces tag limits on post creation too', async () => {
    for (const tags of [
      ['a', 'b', 'c', 'd', 'e', 'f'],
      ['x'.repeat(31)],
      ['   '],
    ]) {
      const dto = plainToInstance(CreatePostDto, {
        title: 'Trip',
        body: 'Story',
        status: PostStatus.DRAFT,
        tags,
      });
      await expect(validate(dto)).resolves.not.toHaveLength(0);
    }
  });

  it('rejects missing or non-array tag updates', async () => {
    for (const payload of [{}, { tags: 'Egypt' }]) {
      const dto = plainToInstance(UpdatePostTagsDto, payload);
      await expect(validate(dto)).resolves.not.toHaveLength(0);
    }
  });

  it('accepts nonempty comments up to 500 characters and trims whitespace', async () => {
    const dto = plainToInstance(CreateCommentDto, { body: ` ${'x'.repeat(500)} ` });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.body).toHaveLength(500);
  });

  it('rejects empty, whitespace-only, and overlong comments', async () => {
    for (const body of ['', '   ', 'x'.repeat(501)]) {
      const dto = plainToInstance(CreateCommentDto, { body });
      await expect(validate(dto)).resolves.not.toHaveLength(0);
    }
  });

  it('trims and validates search keywords and pagination', async () => {
    const valid = plainToInstance(SearchPostsQueryDto, {
      keyword: '  Alexandria  ',
      page: '2',
    });
    await expect(validate(valid)).resolves.toHaveLength(0);
    expect(valid.keyword).toBe('Alexandria');
    expect(valid.page).toBe(2);

    for (const payload of [
      { keyword: '   ' },
      { keyword: 'x'.repeat(101) },
      { keyword: 'coast', page: 0 },
      { keyword: 'coast', page: 1001 },
      { keyword: 'coast', page: Number.MAX_SAFE_INTEGER },
    ]) {
      const invalid = plainToInstance(SearchPostsQueryDto, payload);
      await expect(validate(invalid)).resolves.not.toHaveLength(0);
    }
  });

  it('allows partial post edits and enforces comment edit bounds', async () => {
    const postUpdate = plainToInstance(UpdatePostDto, { title: ' Edited ' });
    await expect(validate(postUpdate)).resolves.toHaveLength(0);
    expect(postUpdate.title).toBe('Edited');

    for (const body of ['', '   ', 'x'.repeat(501)]) {
      const commentUpdate = plainToInstance(UpdateCommentDto, { body });
      await expect(validate(commentUpdate)).resolves.not.toHaveLength(0);
    }
  });
});
