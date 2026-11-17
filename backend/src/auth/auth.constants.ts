/** ACC-05: consecutive failed logins before the account locks. */
export const MAX_LOGIN_ATTEMPTS = 5;
/** ACC-05: lock duration. */
export const LOCK_TIME_MS = 15 * 60 * 1000;
/** ACC-06: a session with no authenticated request for this long expires. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
