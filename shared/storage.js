import { fail } from './errors.js';
export async function get(bucket, key) {
  const o = await bucket.get(key);
  return o ? { data: JSON.parse(await o.text()), etag: o.etag } : null;
}
export async function mutate(bucket, key, fn, initial) {
  for (let n = 0; n < 40; n++) {
    const o = await get(bucket, key);
    const s = o?.data ?? structuredClone(initial);
    if (!s) fail('Not found', 404);
    const result = fn(s);
    s.rev = (s.rev || 0) + 1;
    const written = await bucket.put(key, JSON.stringify(s), {
      onlyIf: o ? { etagMatches: o.etag } : new Headers({ 'If-None-Match': '*' }),
    });
    if (written) return { state: s, result };
  }
  fail('Busy room — please retry', 409);
}
