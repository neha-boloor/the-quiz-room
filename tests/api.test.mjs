import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { columns, parseCSV, stringifyCSV } from '../shared/deck-csv.js';
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
const env = {
  BUCKET: new Bucket(),
  OWNER_EMAIL: 'owner@example.test',
  BUZZER_RELEASE_DELAY_MS: 50,
};
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
  const question = w.decks[0].boards[0].questions[0];
  question.answerMedia = 'answer-media';
  question.answerType = 'image';
  w.decks[0].boards[0].questions = [question];
  w.decks[0].boards[0].categoryIcons = ['✦', '✦', '✦', '✦', '✦'];
  w.decks[0].boards[0].categoryDescriptions = ['Private host cue', '', '', '', ''];
  const finalQuestion = { ...question, id: crypto.randomUUID() };
  w.decks[0].boards.push({
    ...structuredClone(w.decks[0].boards[0]),
    id: crypto.randomUUID(),
    title: 'The finale',
    questions: [finalQuestion],
  });
  w = (await call('workspace/save', { rev: w.rev, decks: w.decks })).data;
  const created = await call('room/create', { deck: w.decks[0].id, title: 'Friday Quiz Night' });
  assert.equal(created.status, 200);
  let r = created.data;
  assert.equal(r.title, 'Friday Quiz Night');
  assert.equal(
    (await call('room/create', { deck: w.decks[0].id, title: 'Accidental duplicate' })).data.id,
    r.id,
  );
  assert.equal((await call('sessions')).data[0].status, 'In progress');
  assert.equal(r.deck.boards[0].categoryDescriptions[0], 'Private host cue');
  host = false;
  auth = r.stage;
  const lobby = (await call('room/' + r.id)).data;
  assert.equal(lobby.stageView, 'join');
  assert.equal(lobby.join, r.join);
  host = true;
  auth = '';
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
  host = true;
  assert.equal((await call('sessions')).data[0].teamCount, 12);
  host = false;
  assert(joins.every((x) => x.status === 200));
  const teamTokens = joins.map((j) => j.data.token);
  auth = teamTokens[0];
  let state = (await call('room/' + r.id)).data;
  assert.equal(state.teams.length, 1);
  assert.equal(state.teams[0].id, joins[0].data.id);
  assert(!JSON.stringify(state).includes('Jurassic'));
  assert(!JSON.stringify(state).includes('Private host cue'));
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
  r = (await cmd('check', { mode: 'start' })).data;
  assert.equal(r.buzzerCheck, true);
  assert.equal(r.open, true);
  assert.equal(r.current, null);
  host = false;
  const checkBuzz = await call(
    'room/' + r.id + '/buzz',
    { commandId: crypto.randomUUID(), question: null, epoch: r.epoch },
    { authorization: 'Bearer ' + teamTokens[0] },
  );
  assert.equal(checkBuzz.status, 200);
  host = true;
  r = (await cmd('check', { mode: 'reset' })).data;
  assert.equal(r.queue.length, 0);
  assert.equal(r.attempts.length, 0);
  r = (await cmd('check', { mode: 'finish' })).data;
  assert.equal(r.buzzerCheck, false);
  assert.equal(r.open, false);
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
  host = false;
  auth = teamTokens[1];
  const privateTeamView = (await call('room/' + r.id)).data;
  assert.equal(privateTeamView.teams.length, 1);
  assert.equal(privateTeamView.teams[0].score, 0);
  host = true;
  auth = '';
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
  assert(!JSON.stringify(stage).includes('Jurassic'));
  assert(!JSON.stringify(stage).includes('Private host cue'));
  assert(!JSON.stringify(stage).includes('answer-media'));
  assert.equal(stage.stageView, 'board');
  assert.equal(stage.join, r.join);
  host = true;
  auth = '';
  await cmd('reveal');
  host = false;
  auth = r.stage;
  const revealed = (await call('room/' + r.id)).data;
  assert(JSON.stringify(revealed).includes('Jurassic'));
  assert.equal(revealed.question.answerMedia, 'answer-media');
  host = true;
  auth = '';
  r = (await cmd('scoreboard')).data;
  host = false;
  auth = r.stage;
  assert.equal((await call('room/' + r.id)).data.scoreboard, true);
  host = true;
  auth = '';
  r = (await cmd('back')).data;
  assert.equal(
    (await cmd('winner')).status,
    400,
    'winner stays hidden until every board is complete',
  );
  r = (await cmd('board', { board: 1 })).data;
  r = (await cmd('select', { question: finalQuestion.id })).data;
  r = (await cmd('reveal')).data;
  r = (await cmd('back')).data;
  r = (await cmd('winner')).data;
  assert.equal(r.winnerReveal, true);
  assert.equal(r.locked, true);
  host = false;
  auth = r.stage;
  assert.equal((await call('room/' + r.id)).data.winnerReveal, true);
  auth = teamTokens[0];
  const teamWinnerView = (await call('room/' + r.id)).data;
  assert.equal(teamWinnerView.winnerReveal, true);
  assert.equal(teamWinnerView.teams.length, 1);
  host = true;
  auth = '';
  await cmd('end');
  assert.equal((await call('sessions')).data[0].status, 'Finished');
  assert.equal((await call('sessions')).data[0].teamCount, 12);
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
test('question resolution synchronizes buzzers and advances through the queue', async () => {
  host = true;
  auth = '';
  const w = (await call('workspace')).data;
  let room = (await call('room/create', { deck: w.decks[0].id })).data;
  const question = room.deck.boards[0].questions[0];
  host = false;
  const first = await call('room/' + room.id + '/join', {
    invite: room.join,
    name: 'First team',
    client: crypto.randomUUID(),
  });
  const second = await call('room/' + room.id + '/join', {
    invite: room.join,
    name: 'Second team',
    client: crypto.randomUUID(),
  });
  host = true;
  const command = async (action, data = {}) =>
    call('room/' + room.id + '/' + action, { commandId: crypto.randomUUID(), ...data });
  room = (await command('select', { question: question.id })).data;
  assert.equal(room.open, false, 'selecting a question prepares every buzzer first');
  assert.equal(room.arming, true);
  host = false;
  for (const token of [first.data.token, second.data.token]) {
    const prepared = await call(
      'room/' + room.id + '/ready',
      { commandId: crypto.randomUUID(), question: question.id, epoch: room.epoch },
      { authorization: 'Bearer ' + token },
    );
    assert.equal(prepared.status, 200);
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  await call(
    'room/' + room.id + '/buzz',
    { commandId: crypto.randomUUID(), question: question.id, epoch: room.epoch },
    { authorization: 'Bearer ' + first.data.token },
  );
  await call(
    'room/' + room.id + '/buzz',
    { commandId: crypto.randomUUID(), question: question.id, epoch: room.epoch },
    { authorization: 'Bearer ' + second.data.token },
  );
  host = true;
  room = (await call('room/' + room.id)).data;
  room = (await command('resolve', { outcome: 'incorrect' })).data;
  assert.equal(room.teams.find((t) => t.id === first.data.id).score, -question.points);
  assert.equal(room.queue[0], second.data.id, 'the next queued team becomes active');
  assert.equal(room.open, true, 'other teams can still buzz');
  host = false;
  auth = first.data.token;
  const firstView = (await call('room/' + room.id)).data;
  assert(firstView.attempted.includes(first.data.id));
  host = true;
  auth = '';
  room = (await command('resolve', { outcome: 'correct' })).data;
  assert.equal(room.teams.find((t) => t.id === second.data.id).score, question.points);
  assert.equal(room.reveal, true);
  assert.equal(room.open, false);
  assert(room.used.includes(question.id));
  room = (await command('back')).data;
  assert.equal(room.current, null, 'returning to the board clears the revealed question');
  assert.equal(room.stageView, 'board');
  await command('end');
});

test('question waits for every team phone before one shared buzzer release', async () => {
  host = true;
  auth = '';
  const workspace = (await call('workspace')).data;
  let room = (await call('room/create', { deck: workspace.decks[0].id })).data;
  const question = room.deck.boards[0].questions[0];

  host = false;
  const first = await call('room/' + room.id + '/join', {
    invite: room.join,
    name: 'Ready first',
    client: crypto.randomUUID(),
  });
  const second = await call('room/' + room.id + '/join', {
    invite: room.join,
    name: 'Ready second',
    client: crypto.randomUUID(),
  });

  host = true;
  const command = (action, data = {}) =>
    call('room/' + room.id + '/' + action, { commandId: crypto.randomUUID(), ...data });
  room = (await command('select', { question: question.id })).data;
  assert.equal(room.arming, true, 'selecting starts a preparation phase');
  assert.equal(room.open, false, 'no phone can buzz during preparation');
  assert.deepEqual(room.readyTeams, []);

  host = false;
  auth = room.stage;
  assert.equal(
    (await call('room/' + room.id)).data.question,
    null,
    'the TV must not reveal the question while phones prepare',
  );

  auth = first.data.token;
  let prepared = await call('room/' + room.id + '/ready', {
    commandId: crypto.randomUUID(),
    question: question.id,
    epoch: room.epoch,
  });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.data.open, false, 'one fast phone cannot open early');

  auth = second.data.token;
  prepared = await call('room/' + room.id + '/ready', {
    commandId: crypto.randomUUID(),
    question: question.id,
    epoch: room.epoch,
  });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.data.open, true);
  assert(prepared.data.releaseAt > Date.now(), 'all phones receive a future shared release time');

  const earlyBuzz = await call('room/' + room.id + '/buzz', {
    commandId: crypto.randomUUID(),
    question: question.id,
    epoch: room.epoch,
  });
  assert.equal(earlyBuzz.status, 409, 'the server rejects a phone that enables itself early');
});

test('host can import a CSV folder with referenced media through the app API', async () => {
  env.BUCKET = new Bucket();
  host = true;
  auth = '';
  const rows = parseCSV(
    await readFile(new URL('../examples/quiz-template.csv', import.meta.url), 'utf8'),
  );
  rows[1][columns.indexOf('Question Media')] = 'media/photo.png';
  const csv = stringifyCSV(rows);
  assert.equal((await call('deck/import', { csv, media: {} })).status, 400);
  const uploaded = await call('upload', {
    type: 'image/png',
    data: Buffer.from('photo-fixture').toString('base64'),
  });
  assert.equal(uploaded.status, 200);
  const result = await call('deck/import', {
    csv,
    media: { 'media/photo.png': uploaded.data.key },
  });
  assert.equal(result.status, 200);
  const workspace = (await call('workspace')).data;
  const deck = workspace.decks.find((item) => item.id === result.data.id);
  assert.equal(deck.boards[0].questions[0].media, uploaded.data.key);
  assert.equal(deck.boards[0].questions[0].type, 'image');
});

test('simultaneous hosts start one shared session', async () => {
  env.BUCKET = new Bucket();
  host = true;
  auth = '';
  const workspace = (await call('workspace')).data;
  const created = await Promise.all(
    Array.from({ length: 8 }, () => call('room/create', { deck: workspace.decks[0].id })),
  );
  assert(created.every((result) => result.status === 200));
  assert.equal(new Set(created.map((result) => result.data.id)).size, 1);
  assert.equal((await call('sessions')).data.length, 1);
});
