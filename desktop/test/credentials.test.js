const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Credentials } = require('../lib/credentials');

// Synthetic fixtures only; these do not authenticate with any service.
const fixtureKey = () => 'sk-' + 'test_fixture_'.repeat(4);

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roody-credentials-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const encryptionKey = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test_secret_service',
    encryptString(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
    ...overrides,
  };
  const file = path.join(dir, 'credentials.enc');
  return { dir, file, safeStorage, credentials: new Credentials({ file, safeStorage }) };
}

test('remembered keys survive restart with ciphertext only on disk and metadata only in status', t => {
  const { dir, file, safeStorage, credentials } = setup(t);
  const key = fixtureKey();
  assert.equal(credentials.getKey(), '');
  assert.deepEqual(credentials.setKey(key, { remember: true }), { hasSavedKey: true, canRemember: true });
  assert.equal(new Credentials({ file, safeStorage }).getKey(), key);
  assert.equal(fs.readFileSync(file).includes(Buffer.from(key)), false);
  assert.equal(JSON.stringify(credentials.status()).includes(key), false);
  assert.deepEqual(fs.readdirSync(dir), ['credentials.enc']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('session keys remove an earlier remembered key and do not survive restart', t => {
  const { file, safeStorage, credentials } = setup(t);
  credentials.setKey(fixtureKey(), { remember: true });
  const sessionKey = fixtureKey() + 'session';
  assert.deepEqual(credentials.setKey(sessionKey, { remember: false }), { hasSavedKey: false, canRemember: true });
  assert.equal(credentials.getKey(), sessionKey);
  assert.equal(fs.existsSync(file), false);
  assert.equal(new Credentials({ file, safeStorage }).getKey(), '');
});

test('remove clears both remembered and session credentials', t => {
  const { file, credentials } = setup(t);
  credentials.setKey(fixtureKey(), { remember: true });
  credentials.remove();
  assert.equal(fs.existsSync(file), false);
  assert.equal(credentials.getKey(), '');
  credentials.setKey(fixtureKey(), { remember: false });
  credentials.remove();
  assert.equal(credentials.getKey(), '');
});

test('unavailable encryption permits session use but never persistence', t => {
  const { dir, credentials } = setup(t, { isEncryptionAvailable: () => false });
  assert.equal(credentials.status().canRemember, false);
  assert.throws(() => credentials.setKey(fixtureKey(), { remember: true }), /Secure key storage is unavailable/);
  assert.deepEqual(fs.readdirSync(dir), []);
  credentials.setKey(fixtureKey(), { remember: false });
  assert.equal(credentials.getKey(), fixtureKey());
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('Linux basic_text fallback is rejected for remembered keys', { skip: process.platform !== 'linux' }, t => {
  const { dir, credentials } = setup(t, { getSelectedStorageBackend: () => 'basic_text' });
  assert.equal(credentials.status().canRemember, false);
  assert.throws(() => credentials.setKey(fixtureKey(), { remember: true }), /Secure key storage is unavailable/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('invalid input preserves the existing saved credential', t => {
  const { file, credentials } = setup(t);
  credentials.setKey(fixtureKey(), { remember: true });
  const encrypted = fs.readFileSync(file);
  for (const key of [null, '', 'sk-short', fixtureKey() + '\n', 'sk-' + 'x'.repeat(600), 'not-an-api-key']) {
    assert.throws(() => credentials.setKey(key, { remember: true }), /Enter a valid OpenAI API key/);
    assert.deepEqual(fs.readFileSync(file), encrypted);
  }
  assert.equal(credentials.getKey(), fixtureKey());
});

test('corrupt saved credentials report a generic error and preserve the original file', t => {
  const { file, safeStorage } = setup(t);
  const corrupt = Buffer.from('invalid encrypted data');
  fs.writeFileSync(file, corrupt);
  const credentials = new Credentials({ file, safeStorage });
  assert.equal(credentials.status().hasSavedKey, true);
  assert.throws(() => credentials.getKey(), /Roody could not read the saved API key/);
  assert.deepEqual(fs.readFileSync(file), corrupt);
});

test('failed secure saving preserves the previous file and leaves no temporary files', t => {
  const { dir, file, safeStorage, credentials } = setup(t);
  credentials.setKey(fixtureKey(), { remember: true });
  const original = fs.readFileSync(file);
  safeStorage.encryptString = () => { throw new Error('Injected storage failure'); };
  assert.throws(() => credentials.setKey(fixtureKey() + 'next', { remember: true }), /could not save the API key securely/);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(fs.readdirSync(dir), ['credentials.enc']);
});

test('failed atomic replacement cleans up the ciphertext temporary file', t => {
  const { dir, file, credentials } = setup(t);
  fs.mkdirSync(file);
  assert.throws(() => credentials.setKey(fixtureKey(), { remember: true }), /could not save the API key securely/);
  assert.equal(fs.statSync(file).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(dir), ['credentials.enc']);
});
