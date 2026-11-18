import {
  DEFAULT_SEED_PASSWORD,
  assertMayWrite,
  describeDatabase,
  parseSeedArgs,
  resolveSeedPassword,
} from './demo-seed.options';

describe('demo seed options', () => {
  it('parses the flags and the SEED_CONFIRM variable', () => {
    expect(parseSeedArgs([])).toEqual({ reset: false, confirmed: false, force: false });
    expect(parseSeedArgs(['--reset', '--yes'])).toEqual({ reset: true, confirmed: true, force: false });
    expect(parseSeedArgs([], { SEED_CONFIRM: 'yes' }).confirmed).toBe(true);
    expect(parseSeedArgs([], { SEED_CONFIRM: 'true' }).confirmed).toBe(false);
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    expect(() => parseSeedArgs(['--rest'])).toThrow('Unknown option --rest');
  });

  it('never returns credentials from the connection string', () => {
    expect(describeDatabase('mongodb+srv://user:secret@cluster0.example.mongodb.net/giu-travel?retryWrites=true')).toEqual({
      host: 'cluster0.example.mongodb.net',
      database: 'giu-travel',
    });
    expect(describeDatabase('mongodb://127.0.0.1:27017/')).toEqual({ host: '127.0.0.1:27017', database: 'test' });
    expect(() => describeDatabase('not a uri')).toThrow('not a valid MongoDB');
  });

  it('refuses to write without confirmation, and in production without --force', () => {
    expect(() => assertMayWrite({ reset: false, confirmed: false, force: false }, { NODE_ENV: 'development' })).toThrow('--yes');
    expect(() => assertMayWrite({ reset: false, confirmed: true, force: false }, { NODE_ENV: 'production' })).toThrow('production');
    expect(() => assertMayWrite({ reset: false, confirmed: true, force: true }, { NODE_ENV: 'production' })).not.toThrow();
    expect(() => assertMayWrite({ reset: false, confirmed: true, force: false }, { NODE_ENV: 'development' })).not.toThrow();
  });

  it('uses the default password and enforces the password policy', () => {
    expect(resolveSeedPassword({})).toBe(DEFAULT_SEED_PASSWORD);
    expect(resolveSeedPassword({ SEED_PASSWORD: 'Another123' })).toBe('Another123');
    expect(() => resolveSeedPassword({ SEED_PASSWORD: 'short1' })).toThrow('SEED_PASSWORD');
    expect(() => resolveSeedPassword({ SEED_PASSWORD: 'onlyletters' })).toThrow('SEED_PASSWORD');
  });
});
