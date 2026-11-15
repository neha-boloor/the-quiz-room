import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('new host tab reopens the active session shared with teams', async () => {
  const source = await readFile(new URL('../client/app.js', import.meta.url), 'utf8');
  const boot = source.match(
    /async function boot\(\)[\s\S]*?(?=window\.addEventListener\('hashchange')/,
  )?.[0];
  const choose = source.match(/function activeSession\(\)[\s\S]*?(?=function themesView)/)?.[0];
  assert(boot, 'host boot function should be available');
  assert(choose, 'active session selector should be available');
  const requests = [];
  let polling = 0;
  const context = vm.createContext({
    location: { hash: '' },
    guest: false,
    stage: false,
    me: {},
    w: undefined,
    sessions: [],
    room: null,
    view: 'decks',
    api: async (route) => {
      requests.push(route);
      if (route === 'me') return { host: true, local: true };
      if (route === 'workspace')
        return {
          rooms: [
            { id: 'party-2', title: 'Empty duplicate', time: 200 },
            { id: 'party-1', title: 'Friday Quiz Night', time: 100 },
          ],
        };
      if (route === 'sessions')
        return [
          {
            id: 'party-2',
            title: 'Empty duplicate',
            status: 'In progress',
            teamCount: 0,
            time: 200,
          },
          {
            id: 'party-1',
            title: 'Friday Quiz Night',
            status: 'In progress',
            teamCount: 3,
            time: 100,
          },
        ];
      if (route === 'room/party-1')
        return {
          id: 'party-1',
          title: 'Friday Quiz Night',
          ended: false,
          expires: Date.now() + 60_000,
        };
      throw Error(`Unexpected request: ${route}`);
    },
    render() {},
    startPoll() {
      polling++;
    },
    $() {
      return { innerHTML: '' };
    },
    esc: String,
    Date,
  });
  new vm.Script(
    `${choose}\n${boot}\nglobalThis.runBoot = boot; globalThis.getState = () => ({ room, view });`,
  ).runInContext(context);
  await context.runBoot();
  assert.equal(context.getState().room?.id, 'party-1');
  assert.equal(context.getState().view, 'host');
  assert.deepEqual(requests, ['me', 'workspace', 'sessions', 'room/party-1']);
  assert.equal(polling, 1);
});

test('CSV folder picker uploads media and imports the matching question set', async () => {
  const source = await readFile(new URL('../client/app.js', import.meta.url), 'utf8');
  const importer = source.match(
    /async function importCSVFolder[\s\S]*?(?=async function action)/,
  )?.[0];
  assert(importer, 'CSV folder import function should be available');
  const calls = [];
  const context = vm.createContext({
    w: {},
    toast() {},
    render() {},
    dataURL: async () => 'data:image/png;base64,cGhvdG8=',
    api: async (route, body) => {
      calls.push({ route, body });
      if (route === 'upload') return { key: 'uploaded-photo' };
      if (route === 'deck/import') return { title: 'Friday Quiz' };
      if (route === 'workspace') return { decks: [] };
      throw Error(`Unexpected route: ${route}`);
    },
  });
  new vm.Script(`${importer}\nglobalThis.runImport = importCSVFolder;`).runInContext(context);
  await context.runImport([
    { webkitRelativePath: 'my-quiz/questions.csv', text: async () => 'CSV contents' },
    { webkitRelativePath: 'my-quiz/media/photo.png', size: 5 },
  ]);
  assert.deepEqual(
    calls.map((call) => call.route),
    ['upload', 'deck/import', 'workspace'],
  );
  assert.equal(calls[1].body.csv, 'CSV contents');
  assert.equal(calls[1].body.media['media/photo.png'], 'uploaded-photo');
});

test('mobile buzzer chime waits for a suspended audio context to resume', async () => {
  const source = await readFile(new URL('../client/app.js', import.meta.url), 'utf8');
  const match = source.match(/function playBuzzer[\s\S]*?(?=function announceNewBuzzes)/);
  assert(match, 'playBuzzer should be available to the client');

  const events = [];
  let releaseAudio;
  const audioContext = {
    state: 'suspended',
    currentTime: 1,
    destination: {},
    resume() {
      return new Promise((resolve) => {
        releaseAudio = () => {
          this.state = 'running';
          resolve();
        };
      });
    },
    createOscillator() {
      return {
        type: '',
        frequency: { setValueAtTime() {} },
        connect(target) {
          return target;
        },
        start() {
          events.push('start');
        },
        stop() {},
      };
    },
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {
          return audioContext.destination;
        },
      };
    },
  };
  const context = vm.createContext({
    audioContext,
    room: { teams: [{ id: 'team-1' }] },
  });
  new vm.Script(`${match[0]} globalThis.triggerBuzzer = () => playBuzzer('team-1');`).runInContext(
    context,
  );
  context.triggerBuzzer();
  assert.equal(events.length, 0, 'no tone plays before the browser releases audio');
  releaseAudio();
  await new Promise(setImmediate);
  assert.equal(events.length, 4, 'the queued chime plays after audio is released');
});

test('participant chime starts inside the buzz tap before the network wait', async () => {
  const source = await readFile(new URL('../client/app.js', import.meta.url), 'utf8');
  const branch = source.match(/else if \(a === 'buzz'\)[\s\S]*?(?=} else if \(room\))/)?.[0];
  assert(branch, 'buzz action branch should exist');
  assert(
    branch.indexOf('playBuzzer(room.teamId)') < branch.indexOf("await api('room/'"),
    'mobile audio must begin during the user tap, before yielding to the network',
  );
});

test('team phones reconnect live updates and poll within one second', async () => {
  const source = await readFile(new URL('../client/app.js', import.meta.url), 'utf8');
  const match = source.match(/function startPoll[\s\S]*?(?=async function action)/);
  assert(match, 'startPoll should be available to the client');

  const intervals = [];
  const timeouts = [];
  const sockets = [];
  class FakeWebSocket {
    constructor() {
      sockets.push(this);
    }
    close() {}
    send() {}
  }
  const context = vm.createContext({
    me: { local: true },
    room: { id: 'room-1', ended: false },
    cred: 'team-token',
    guest: true,
    stage: false,
    location: { protocol: 'http:', host: 'quiz.local' },
    WebSocket: FakeWebSocket,
    refreshRoom() {},
    clearInterval() {},
    setInterval(callback, milliseconds) {
      intervals.push(milliseconds);
      return 1;
    },
    clearTimeout() {},
    setTimeout(callback, milliseconds) {
      timeouts.push({ callback, milliseconds });
      return 1;
    },
  });
  new vm.Script(
    `let timer; let liveSocket; let liveReconnect; let busy = false; let refreshPending = false; ${match[0]} globalThis.start = startPoll; globalThis.socket = () => liveSocket;`,
  ).runInContext(context);
  context.start();
  assert(intervals[0] <= 1000, 'fallback polling should make phones ready within one second');
  assert.equal(
    typeof context.socket().onclose,
    'function',
    'closed live connections must reconnect',
  );
  context.socket().onclose();
  assert(timeouts[0].milliseconds <= 1000, 'reconnection should begin promptly');
  timeouts[0].callback();
  assert.equal(sockets.length, 2, 'a closed socket should be replaced');
});

test('phones and TV wait for the same server release time', async () => {
  const source = await readFile(new URL('../client/app.js', import.meta.url), 'utf8');
  const match = source.match(/function releaseStarted[\s\S]*?(?=function scheduleBuzzerReady)/);
  assert(match, 'shared release scheduling should be available to the client');

  let now = 9_000;
  const timeouts = [];
  const context = vm.createContext({
    room: { releaseAt: 10_000 },
    serverClockOffset: 500,
    releaseTimer: null,
    Date: { now: () => now },
    clearTimeout() {},
    setTimeout(callback, milliseconds) {
      timeouts.push({ callback, milliseconds });
      return 1;
    },
    render() {},
  });
  new vm.Script(
    `${match[0]} globalThis.started = releaseStarted; globalThis.synchronizing = buzzerSynchronizing; globalThis.schedule = scheduleReleaseRender;`,
  ).runInContext(context);

  assert.equal(context.started(), false, 'the faster device must remain locked before release');
  assert.equal(
    context.synchronizing(),
    true,
    'the TV must show preparation instead of the question before release',
  );
  context.schedule();
  assert.equal(timeouts[0].milliseconds, 515, 'render is scheduled from server-adjusted time');
  now = 9_500;
  assert.equal(context.started(), true, 'the buzzer unlocks at the shared server time');
  assert.equal(context.synchronizing(), false, 'the TV may show the question at release');
});

test('category introductions render only through the private host guide', async () => {
  const source = await readFile(new URL('../client/app.js', import.meta.url), 'utf8');
  const match = source.match(/function categoryGuideHTML[\s\S]*?(?=function scoreHTML)/);
  assert(match, 'private category guide should be available to the host view');
  assert(
    source.includes('boardHTML(b, room.used) + categoryGuideHTML(b)'),
    'the host board should include the private guide',
  );

  const context = vm.createContext({
    esc: (value) => String(value),
  });
  new vm.Script(`${match[0]} globalThis.guide = categoryGuideHTML;`).runInContext(context);
  const html = context.guide({
    categories: ['Bada Patakha!'],
    categoryIcons: ['🧨'],
    categoryDescriptions: ['Five questions, one hidden connection!'],
  });
  assert.match(html, /PRIVATE · HOST CUES/);
  assert.match(html, /🧨/);
  assert.match(html, /Five questions, one hidden connection!/);
});
