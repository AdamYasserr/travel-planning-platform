import { CommentSchema } from './schemas/comment.schema';
import { PostLikeSchema } from './schemas/post-like.schema';

describe('Comment schema', () => {
  it('defines a chronological index for comments in a post', () => {
    const chronologicalIndex = CommentSchema.indexes().find(([fields]) =>
      'postId' in fields && 'createdAt' in fields,
    );

    expect(chronologicalIndex?.[0]).toEqual({
      postId: 1,
      isHidden: 1,
      createdAt: 1,
      _id: 1,
    });
  });
});

describe('PostLike schema', () => {
  it('enforces one like per user and post with a unique compound index', () => {
    const uniqueIndex = PostLikeSchema.indexes().find(
      ([fields, options]) =>
        'postId' in fields && 'userId' in fields && options?.unique === true,
    );

    expect(uniqueIndex?.[0]).toEqual({ postId: 1, userId: 1 });
    expect(uniqueIndex?.[1]).toMatchObject({ unique: true });
  });
});
