import { Types } from 'mongoose';
import { DELETED_USER_NAME, presentAuthor } from './deleted-user';

describe('presentAuthor (ACC-12)', () => {
  const id = new Types.ObjectId();

  it('shows the real name for an active account', () => {
    expect(presentAuthor({ _id: id, name: 'Amina', isActive: true, deactivatedAt: null })).toEqual({ id: id.toString(), name: 'Amina' });
  });

  it.each([
    ['isActive false', { _id: id, name: 'Amina', isActive: false }],
    ['deactivatedAt set', { _id: id, name: 'Amina', isActive: true, deactivatedAt: new Date() }],
  ])('shows "Deleted user" and hides the id when %s', (_label, user) => {
    expect(presentAuthor(user)).toEqual({ id: null, name: DELETED_USER_NAME });
    expect(DELETED_USER_NAME).toBe('Deleted user');
  });

  it('shows "Deleted user" when the account no longer exists', () => {
    expect(presentAuthor(null)).toEqual({ id: null, name: 'Deleted user' });
  });
});
