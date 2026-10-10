const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function validKey(value) {
  return typeof value === 'string' && value.length <= 512 && !/[\r\n]/.test(value) &&
    /^sk-[A-Za-z0-9_-]{17,}$/.test(value.trim());
}

function encryptionAvailable(storage) {
  try {
    if (!storage?.isEncryptionAvailable()) return false;
    // Electron can fall back to a known plaintext password on Linux.
    if (process.platform === 'linux' && typeof storage.getSelectedStorageBackend === 'function' &&
        storage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  } catch {
    return false;
  }
}

class Credentials {
  #sessionKey = '';
  #hasSessionKey = false;

  constructor({ file, safeStorage }) {
    this.file = file;
    this.safeStorage = safeStorage;
  }

  status() {
    return { hasSavedKey: fs.existsSync(this.file), canRemember: encryptionAvailable(this.safeStorage) };
  }

  getKey() {
    if (this.#hasSessionKey) return this.#sessionKey;
    try {
      const stat = fs.statSync(this.file);
      if (!stat.isFile() || stat.size === 0 || stat.size > 65536 || !encryptionAvailable(this.safeStorage)) {
        throw new Error('Invalid saved credential');
      }
      const key = this.safeStorage.decryptString(fs.readFileSync(this.file));
      if (!validKey(key)) throw new Error('Invalid saved credential');
      return key.trim();
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw new Error('Roody could not read the saved API key. Remove it in Settings and save it again.');
    }
  }

  setKey(key, { remember = false } = {}) {
    if (!validKey(key)) throw new Error('Enter a valid OpenAI API key beginning with sk-.');
    const normalized = key.trim();
    if (!remember) {
      this.#removeFile();
      this.#sessionKey = normalized;
      this.#hasSessionKey = true;
      return this.status();
    }
    if (!encryptionAvailable(this.safeStorage)) {
      throw new Error('Secure key storage is unavailable. Use the key for this session instead.');
    }

    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      const encrypted = this.safeStorage.encryptString(normalized);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('Invalid encrypted credential');
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, encrypted, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, this.file);
    } catch {
      throw new Error('Roody could not save the API key securely. Try using it for this session.');
    } finally {
      try { fs.unlinkSync(temp); } catch { /* A successful rename leaves no temporary file. */ }
    }
    this.#sessionKey = '';
    this.#hasSessionKey = false;
    return this.status();
  }

  remove() {
    this.#removeFile();
    this.#sessionKey = '';
    this.#hasSessionKey = false;
    return this.status();
  }

  #removeFile() {
    try { fs.unlinkSync(this.file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Roody could not remove the saved API key.');
    }
  }
}

module.exports = { Credentials };
