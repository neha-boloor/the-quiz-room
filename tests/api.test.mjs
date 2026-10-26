import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';
export class Bucket {
  constructor() {
    this.m = new Map();
    this.seq = 0;
  }
  async get(k) {
    const x = this.m.get(k);
    return x
      ? { etag: x.etag, text: async () => x.body, body: x.body, httpMetadata: x.httpMetadata }
      : null;
  }
  async put(k, v, opt = {}) {
    const x = this.m.get(k);
    if (opt.onlyIf instanceof Headers) {
      if (opt.onlyIf.get('if-none-match') === '*' && x) return null;
    } else if (opt.onlyIf?.etagMatches && opt.onlyIf.etagMatches !== x?.etag) return null;
    const y = { body: v, etag: String(++this.seq), httpMetadata: opt.httpMetadata };
    this.m.set(k, y);
    return y;
  }
}
const env = { BUCKET: new Bucket(), OWNER_EMAIL: 'owner@example.test' };
let host = true,
  auth = '';
async function call(path, data, extra = {}) {
  const r = await worker.fetch(
    new Request('https://quiz.test/api/' + path, {
      method: data ? 'POST' : 'GET',
      headers: {
        ...(host ? { 'oai-authenticated-user-email': 'owner@example.test' } : {}),
        ...(auth ? { authorization: 'Bearer ' + auth } : {}),
        'content-type': 'application/json',
        ...extra,
      },
      body: data ? JSON.stringify(data) : undefined,
    }),
    env,
  );
  return { status: r.status, data: await r.json() };
}
test('complete party and authorization with concurrent writes', async () => {
  let w = (await call('workspace')).data;
  assert.equal(w.decks.length, 1);
  const created = await call('room/create', { deck: w.decks[0].id });
  assert.equal(created.status, 200);
  let r = created.data;
  host = false;
  assert.equal((await call('workspace')).status, 403);
  assert.equal((await call('room/' + r.id)).status, 403);
  assert.equal(
    (
      await call('room/' + r.id + '/join', {
        invite: 'wrong',
        name: 'Intruder',
        client: crypto.randomUUID(),
      })
    ).status,
    403,
  );
  const joins = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      call('room/' + r.id + '/join', {
        invite: r.join,
        name: 'Team ' + i,
        client: crypto.randomUUID(),
      }),
    ),
  );
  assert(joins.every((x) => x.status === 200));
  const teamTokens = joins.map((j) => j.data.token);
  auth = teamTokens[0];
  let state = (await call('room/' + r.id)).data;
  assert.equal(state.teams.length, 12);
  assert(!JSON.stringify(state).includes('Zindagi'));
  assert(!state.join);
  assert(!state.stage);
  assert(!state.deck);
  assert.equal(
    (
      await call('room/' + r.id + '/score', {
        commandId: crypto.randomUUID(),
        amount: 999,
        team: state.teams[0].id,
      })
    ).status,
    403,
  );
  host = true;
  auth = '';
  const cmd = async (a, data = {}) =>
    call('room/' + r.id + '/' + a, { commandId: crypto.randomUUID(), ...data });
  const q = r.deck.boards[0].questions[0].id;
  await cmd('select', { question: q });
  r = (await cmd('open')).data;
  host = false;
  const buzz = await Promise.all(
    teamTokens.map((t) =>
      call(
        'room/' + r.id + '/buzz',
        { commandId: crypto.randomUUID(), question: q, epoch: r.epoch },
        { authorization: 'Bearer ' + t },
      ),
    ),
  );
  assert(buzz.every((x) => x.status === 200));
  host = true;
  r = (await call('room/' + r.id)).data;
  assert.equal(r.queue.length, 12);
  assert.equal(new Set(r.queue).size, 12);
  const team = r.teams[0].id;
  await Promise.all(Array.from({ length: 20 }, () => cmd('score', { team, amount: 10 })));
  r = (await call('room/' + r.id)).data;
  assert.equal(r.teams.find((t) => t.id === team).score, 200);
  const duplicate = { commandId: crypto.randomUUID(), team, amount: -30 };
  await Promise.all([
    call('room/' + r.id + '/score', duplicate),
    call('room/' + r.id + '/score', duplicate),
  ]);
  r = (await call('room/' + r.id)).data;
  assert.equal(r.teams.find((t) => t.id === team).score, 170);
  await cmd('undo');
  r = (await call('room/' + r.id)).data;
  assert.equal(r.teams.find((t) => t.id === team).score, 200);
  host = false;
  auth = r.stage;
  const stage = (await call('room/' + r.id)).data;
  assert(!JSON.stringify(stage).includes('Zindagi'));
  host = true;
  auth = '';
  await cmd('reveal');
  host = false;
  auth = r.stage;
  assert(JSON.stringify((await call('room/' + r.id)).data).includes('Zindagi'));
  host = true;
  auth = '';
  await cmd('end');
  host = false;
  auth = teamTokens[0];
  assert.equal((await call('room/' + r.id)).status, 410);
  assert.equal(
    (
      await call('room/' + r.id + '/join', {
        invite: r.join,
        name: 'Late',
        client: crypto.randomUUID(),
      })
    ).status,
    410,
  );
  assert.equal(
    (
      await call('room/' + r.id + '/buzz', {
        commandId: crypto.randomUUID(),
        question: q,
        epoch: r.epoch,
      })
    ).status,
    410,
  );
});
test('unrelated signed-in identity cannot access studio', async () => {
  host = false;
  auth = '';
  assert.equal(
    (await call('workspace', null, { 'oai-authenticated-user-email': 'stranger@example.com' }))
      .status,
    403,
  );
});
