import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The storage contract shared by the Worker and the standalone local server.
 * Conditional writes are serialized per key. Data and metadata commit together
 * in one atomic rename, so readers never see a half-written object.
 * Run only one local server per data directory.
 */
export class FileBucket {
  #locks = new Map();
  constructor(directory) {
    this.directory = path.resolve(directory);
  }
  filename(key) {
    if (typeof key !== 'string' || key.length > 500) throw Error('Invalid storage key');
    return path.join(this.directory, createHash('sha256').update(key).digest('hex') + '.json');
  }
  async get(key) {
    let saved;
    try {
      saved = JSON.parse(await readFile(this.filename(key), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const bytes = Buffer.from(saved.data, 'base64');
    return {
      etag: saved.etag,
      httpMetadata: saved.httpMetadata,
      body: bytes,
      text: async () => bytes.toString('utf8'),
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }
  async put(key, value, options = {}) {
    const previous = this.#locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#locks.set(key, tail);
    await previous;
    try {
      const current = await this.get(key);
      if (options.onlyIf instanceof Headers) {
        if (options.onlyIf.get('if-none-match') === '*' && current) return null;
      } else if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== current?.etag)
        return null;
      const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
      const saved = {
        etag: randomUUID(),
        httpMetadata: options.httpMetadata || {},
        data: bytes.toString('base64'),
      };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const destination = this.filename(key);
      const temporary = destination + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 });
      await rename(temporary, destination);
      return { etag: saved.etag };
    } finally {
      release();
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }
}
