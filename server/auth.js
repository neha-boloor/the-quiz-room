import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function initializeHost(directory, { password, reset = false } = {}) {
  const filename = path.join(directory, 'host-auth.json');
  if (!reset) {
    try {
      return { record: JSON.parse(await readFile(filename, 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (password && password.length < 12)
    throw Error('Host access code must be at least 12 characters.');
  const accessCode = password || randomBytes(18).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const record = { salt, hash: scryptSync(accessCode, salt, 32).toString('hex') };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(filename, JSON.stringify(record), { mode: 0o600 });
  return { record, accessCode };
}
export function verifyAccessCode(record, candidate) {
  if (typeof candidate !== 'string' || candidate.length > 256) return false;
  return timingSafeEqual(scryptSync(candidate, record.salt, 32), Buffer.from(record.hash, 'hex'));
}
export function hostSession(request, sessions) {
  const cookie = request.headers.cookie || '';
  const value = cookie
    .split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith('quiz_host='))
    ?.slice(10);
  const expiry = sessions.get(value);
  if (!expiry || expiry < Date.now()) {
    sessions.delete(value);
    return false;
  }
  return true;
}
