import { CommentSchema } from './schemas/comment.schema';

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
