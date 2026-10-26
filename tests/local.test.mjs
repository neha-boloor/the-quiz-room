import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createLocalApp } from '../server/app.js';
import { FileBucket } from '../server/file-bucket.js';

const password = 'test-only-host-access-12345';
test('persistent file storage commits conditional writes and binary media atomically', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quiz-store-'));
  try {
    const a = new FileBucket(directory);
    const first = await a.put('key', 'initial', { onlyIf: new Headers({ 'If-None-Match': '*' }) });
    assert.equal(
      await a.put('key', 'overwrite', { onlyIf: new Headers({ 'If-None-Match': '*' }) }),
      null,
    );
    const writes = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        a.put('key', 'winner ' + i, { onlyIf: { etagMatches: first.etag } }),
      ),
    );
    assert.equal(writes.filter(Boolean).length, 1);
    await a.put('media', new Uint8Array([0, 1, 2, 255]), {
      httpMetadata: { contentType: 'image/png' },
    });
    const recovered = await new FileBucket(directory).get('media');
    assert.deepEqual([...new Uint8Array(await recovered.arrayBuffer())], [0, 1, 2, 255]);
    assert.equal(recovered.httpMetadata.contentType, 'image/png');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('standalone HTTP + WebSocket party, private auth, media, restart and session expiry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quiz-local-'));
  let app,
    origin,
    hostCookie = '';
  const start = async () => {
    app = await createLocalApp({ dataDirectory: directory, password });
    const port = await app.listen(0, '127.0.0.1');
    origin = 'http://localhost:' + port;
  };
  const call = async (route, body, { host = false, token = '', extra = {} } = {}) => {
    const response = await fetch(origin + '/api/' + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'content-type': 'application/json', origin } : {}),
        ...(host ? { cookie: hostCookie } : {}),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { response, status: response.status, data: await response.json() };
  };
  const login = async () => {
    const r = await call('local/login', { accessCode: password });
    assert.equal(r.status, 200);
    hostCookie = r.response.headers.get('set-cookie').split(';')[0];
  };
  try {
    await start();
    assert.equal((await fetch(origin)).status, 200);
    assert.equal((await call('workspace')).status, 403);
    assert.equal(
      (
        await call('workspace', null, {
          extra: { 'oai-authenticated-user-email': 'owner@quiz.local' },
        })
      ).status,
      403,
      'identity spoofing blocked',
    );
    assert.equal((await call('local/login', { accessCode: 'wrong' })).status, 403);
    await login();
    let w = (await call('workspace', null, { host: true })).data;
    w.brand.title = 'Offline party';
    const upload = await call(
      'upload',
      { type: 'image/png', data: Buffer.from('local-media-fixture').toString('base64') },
      { host: true },
    );
    assert.equal(upload.status, 200);
    w.brand.logo = upload.data.key;
    assert.equal(
      (await call('workspace/save', { rev: w.rev, brand: w.brand }, { host: true })).status,
      200,
    );
    const id = w.decks[0].id;
    let room = (await call('room/create', { deck: id }, { host: true })).data;
    const join = await call('room/' + room.id + '/join', {
      invite: room.join,
      name: 'Team Offline',
      client: crypto.randomUUID(),
    });
    assert.equal(join.status, 200);
    let token = join.data.token;
    const roomPath = 'room/' + room.id;
    const command = async (action, data = {}) =>
      call(roomPath + '/' + action, { commandId: crypto.randomUUID(), ...data }, { host: true });
    const q = room.deck.boards[0].questions[0];
    await command('select', { question: q.id });
    room = (await command('open')).data;
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/live', { origin });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ roomId: room.id, token, guest: true }));
    const ready = await new Promise((resolve) =>
      socket.once('message', (bytes) => resolve(JSON.parse(bytes.toString()))),
    );
    assert.equal(ready.type, 'ready');
    const update = new Promise((resolve) =>
      socket.once('message', (bytes) => resolve(JSON.parse(bytes.toString()))),
    );
    const team = join.data.id;
    await command('score', { team, amount: 40 });
    assert.equal((await update).type, 'refresh');
    assert.equal((await call(roomPath, null, { token })).data.teams[0].score, 40);
    const buzz = await call(
      roomPath + '/buzz',
      { commandId: crypto.randomUUID(), question: q.id, epoch: room.epoch },
      { token },
    );
    assert.equal(buzz.data.queue[0], 'Team Offline');
    const media = await fetch(origin + '/api/asset/' + upload.data.key + '?room=' + room.id, {
      headers: { authorization: 'Bearer ' + token },
    });
    assert.equal(await media.text(), 'local-media-fixture');
    await command('replace', { team });
    assert.equal(
      (await call(roomPath)).status,
      403,
      'empty revoked credential never authorizes anonymous requests',
    );
    assert.equal((await call(roomPath, null, { token })).status, 403);
    const replacement = await call(roomPath + '/join', {
      invite: room.join,
      name: 'Team Offline',
      client: crypto.randomUUID(),
    });
    token = replacement.data.token;
    assert.equal((await call(roomPath, null, { token })).data.teams[0].score, 40);
    socket.terminate();
    await app.close();
    await start();
    await login();
    assert.equal((await call('workspace', null, { host: true })).data.brand.title, 'Offline party');
    room = (await call(roomPath, null, { host: true })).data;
    assert.equal(room.teams[0].score, 40, 'scores survive process restart');
    assert.equal(
      (await fetch(origin + '/api/asset/' + upload.data.key, { headers: { cookie: hostCookie } }))
        .status,
      200,
    );
    await command('end');
    assert.equal((await call(roomPath, null, { token })).status, 410);
    assert.equal(
      (
        await call(roomPath + '/join', {
          invite: room.join,
          name: 'Late',
          client: crypto.randomUUID(),
        })
      ).status,
      410,
    );
    assert.equal(
      (await call('workspace', null, { host: true })).status,
      200,
      'hosts retain private history',
    );
    assert.equal(
      (
        await call(
          'workspace/save',
          { rev: 0 },
          { host: true, extra: { origin: 'http://attacker.invalid' } },
        )
      ).status,
      403,
    );
    assert.equal(
      (await call('workspace', null, { extra: { host: 'attacker.invalid' } })).status,
      403,
      'DNS rebinding host check',
    );
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
