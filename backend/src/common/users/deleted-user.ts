/** ACC-12: how content of a deactivated (or missing) account is attributed. */
export const DELETED_USER_NAME = 'Deleted user';

export interface AuthorLike {
  _id: { toString(): string };
  name: string;
  isActive?: boolean;
  deactivatedAt?: Date | null;
}

export function isDeletedAccount(user: Pick<AuthorLike, 'isActive' | 'deactivatedAt'> | null | undefined): boolean {
  return !user || user.isActive === false || !!user.deactivatedAt;
}

export function presentAuthor(user: AuthorLike | null | undefined): { id: string | null; name: string } {
  if (!user || isDeletedAccount(user)) return { id: null, name: DELETED_USER_NAME };
  return { id: user._id.toString(), name: user.name };
}
