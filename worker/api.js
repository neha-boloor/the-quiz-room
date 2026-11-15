import { fail } from '../shared/errors.js';
import { presets, seed } from '../shared/seed.js';
import { get, mutate } from '../shared/storage.js';
import { theme, validateDeck } from '../shared/validation.js';
import { deckFromCSV, deckMediaRefs } from '../shared/deck-csv.js';
import { alive, auth, publicRoom, assetAllowed } from '../shared/room.js';
const id = () => crypto.randomUUID();
const token = () => id() + id();
export async function api(req, env) {
  const u = new URL(req.url),
    path = u.pathname;
  const bucket = env.BUCKET;
  const releaseDelay = Math.max(50, Math.min(5000, Number(env.BUZZER_RELEASE_DELAY_MS) || 2500));
  if (!bucket) fail('Storage is not connected yet', 503);
  if (req.method !== 'GET' && req.headers.get('origin') && req.headers.get('origin') !== u.origin)
    fail('Cross-origin request denied', 403);
  const OWNER = env.OWNER_EMAIL || 'owner@quiz.local';
  const email = (req.headers.get('oai-authenticated-user-email') || '').toLowerCase();
  let w = (await get(bucket, 'workspace'))?.data;
  if (!w) w = (await mutate(bucket, 'workspace', () => {}, seed())).state;
  const host =
      req.headers.get('x-guest-view') !== '1' &&
      (email === OWNER || (w.cohost && email === w.cohost)),
    owner = email === OWNER;
  const needHost = () => {
    if (!host) fail('Host sign-in required', 403);
  };
  if (!['GET', 'POST'].includes(req.method)) fail('Method not allowed', 405);
  let b = {};
  if (req.method === 'POST') {
    try {
      b = await req.json();
    } catch {
      fail('Invalid JSON', 400);
    }
  }
  if (
    req.method !== 'POST' &&
    (path.endsWith('/save') ||
      path === '/api/upload' ||
      path === '/api/deck/import' ||
      path === '/api/room/create' ||
      /^\/api\/room\/[\w-]+\/\w+$/.test(path))
  )
    fail('POST required', 405);
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  if (path === '/api/me')
    return { host, owner, email: host ? email : '', presets, local: !!env.LOCAL_MODE };
  if (path === '/api/workspace') {
    needHost();
    return w;
  }
  if (path === '/api/sessions') {
    needHost();
    const now = Date.now();
    return Promise.all(
      w.rooms.map(async (entry) => {
        const room = (await get(bucket, 'room/' + entry.id))?.data;
        return {
          ...entry,
          status: !room
            ? 'Unavailable'
            : room.ended
              ? 'Finished'
              : room.expires <= now
                ? 'Expired'
                : 'In progress',
          teamCount: room?.teams.length || 0,
          expires: room?.expires || 0,
        };
      }),
    );
  }
  if (path === '/api/workspace/save') {
    needHost();
    const out = await mutate(bucket, 'workspace', (s) => {
      if (s.rev !== b.rev) fail('Someone else saved changes. Reload before saving.', 409);
      if (b.brand) s.brand = theme(b.brand);
      if (b.cohost !== undefined) {
        if (!owner) fail('Owner only', 403);
        const e = String(b.cohost).trim().toLowerCase();
        if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) fail('Enter a valid email');
        s.cohost = e;
      }
      if (b.decks) {
        if (!Array.isArray(b.decks) || b.decks.length > 60) fail('Too many decks');
        s.decks = b.decks.map(validateDeck);
      }
    });
    return out.state;
  }
  if (path === '/api/deck/import') {
    needHost();
    if (typeof b.csv !== 'string' || b.csv.length > 2_000_000) fail('Choose a CSV under 2 MB');
    let deck;
    try {
      deck = deckFromCSV(b.csv);
    } catch (error) {
      fail(error.message);
    }
    const files = b.media && typeof b.media === 'object' && !Array.isArray(b.media) ? b.media : {};
    for (const ref of deckMediaRefs(deck)) {
      const relative = ref.owner[ref.field];
      if (
        relative.startsWith('/') ||
        relative.includes('\\') ||
        relative.split('/').some((part) => !part || part === '.' || part === '..')
      )
        fail(`Invalid media path: ${relative}`);
      const key = files[relative];
      if (typeof key !== 'string' || !/^[0-9a-f-]{36}$/i.test(key))
        fail(`Missing media file: ${relative}`);
      const asset = await bucket.get('asset/' + key);
      if (!asset) fail(`Missing uploaded media: ${relative}`);
      const kind = asset.httpMetadata?.contentType?.split('/')[0];
      if (!['image', 'audio', 'video'].includes(kind) || (ref.kind !== 'any' && kind !== ref.kind))
        fail(`Unsupported media type: ${relative}`);
      ref.owner[ref.field] = key;
      if (ref.field === 'media' || ref.field === 'answerMedia')
        ref.owner[ref.field === 'media' ? 'type' : 'answerType'] = kind;
    }
    validateDeck(deck);
    await mutate(bucket, 'workspace', (state) => {
      if (state.decks.length >= 60) fail('Workspace already has 60 decks');
      state.decks.push(deck);
    });
    return { id: deck.id, title: deck.title };
  }
  if (path === '/api/upload') {
    needHost();
    if (
      ![
        'image/png',
        'image/jpeg',
        'image/webp',
        'audio/mpeg',
        'audio/wav',
        'video/mp4',
        'video/webm',
      ].includes(b.type)
    )
      fail('Use PNG, JPG, WebP, MP3, WAV, MP4 or WebM');
    if (typeof b.data !== 'string' || b.data.length > 14000000) fail('Maximum upload 10 MB');
    const key = id();
    const bytes = Uint8Array.from(atob(b.data), (c) => c.charCodeAt(0));
    await bucket.put('asset/' + key, bytes, { httpMetadata: { contentType: b.type } });
    return { key };
  }
  if (path.startsWith('/api/asset/')) {
    const key = path.split('/').pop();
    if (!host) {
      const r = (await get(bucket, 'room/' + u.searchParams.get('room')))?.data;
      if (!r) fail('Not found', 404);
      const a = auth(r, bearer);
      if (!assetAllowed(r, key, a)) fail('Asset unavailable', 403);
    }
    const asset = await bucket.get('asset/' + key);
    if (!asset) fail('Missing asset', 404);
    return new Response(asset.body, {
      headers: {
        'content-type': asset.httpMetadata?.contentType || 'application/octet-stream',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  if (path === '/api/room/create') {
    needHost();
    const d = w.decks.find((d) => d.id === b.deck);
    if (!d) fail('Choose a deck');
    const staleRooms = new Set();
    let activeRoom;
    for (const entry of w.rooms) {
      const existing = (await get(bucket, 'room/' + entry.id))?.data;
      if (existing && !existing.ended && existing.expires > Date.now()) {
        if (!activeRoom || existing.teams.length > activeRoom.teams.length) activeRoom = existing;
      } else staleRooms.add(entry.id);
    }
    if (activeRoom) return activeRoom;
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (title.length > 100) fail('Session name must be 100 characters or fewer');
    const r = {
      id: id(),
      rev: 0,
      title: title || d.title,
      deck: structuredClone(d),
      theme: {
        ...w.brand,
        logo: d.theme?.logo || w.brand.logo,
        background: d.theme?.background || w.brand.background,
      },
      join: token(),
      stage: token(),
      teams: [],
      epoch: 0,
      open: false,
      locked: false,
      paused: false,
      ended: false,
      board: 0,
      used: [],
      queue: [],
      attempts: [],
      ledger: [],
      processed: [],
      current: null,
      reveal: false,
      hint: false,
      scoreboard: false,
      winnerReveal: false,
      buzzerCheck: false,
      arming: false,
      readyTeams: [],
      releaseAt: 0,
      stageView: 'join',
      expires: Date.now() + 12 * 3600000,
    };
    await bucket.put('room/' + r.id, JSON.stringify(r), {
      onlyIf: new Headers({ 'If-None-Match': '*' }),
    });
    const selected = await mutate(bucket, 'workspace', (state) => {
      if (
        state.activeRoomId &&
        state.activeRoomExpires > Date.now() &&
        !staleRooms.has(state.activeRoomId)
      )
        return state.activeRoomId;
      state.activeRoomId = r.id;
      state.activeRoomExpires = r.expires;
      state.rooms.unshift({ id: r.id, title: r.title, group: d.group, time: Date.now() });
      return r.id;
    });
    return selected.result === r.id ? r : (await get(bucket, 'room/' + selected.result)).data;
  }
  const m = path.match(/^\/api\/room\/([\w-]+)(?:\/(\w+))?$/);
  if (!m) fail('Not found', 404);
  const roomKey = 'room/' + m[1],
    action = m[2];
  const rr = (await get(bucket, roomKey))?.data;
  if (!rr) fail('Room not found', 404);
  if (!action) {
    if (host) return { ...rr, serverNow: Date.now() };
    return publicRoom(rr, auth(rr, bearer));
  }
  if (action === 'join') {
    alive(rr);
    const out = await mutate(bucket, roomKey, (r) => {
      alive(r);
      if (r.locked) fail('Joining is locked', 403);
      if (b.invite !== r.join) fail('Invalid invitation', 403);
      if (typeof b.client !== 'string' || b.client.length < 20 || b.client.length > 100)
        fail('Device identifier required');
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 40)
        fail('Enter a team name (40 characters maximum)');
      const vacant = r.teams.find(
        (t) => t.name.trim().toLowerCase() === b.name.trim().toLowerCase() && !t.token,
      );
      if (vacant) {
        vacant.token = token();
        vacant.client = b.client;
        return { token: vacant.token, id: vacant.id };
      }
      const existing = r.teams.find((t) => t.client === b.client);
      if (existing) {
        if (b.resume !== existing.token)
          fail(
            'That device already has a team. Reopen its saved session or ask the host to replace it.',
            403,
          );
        return { token: existing.token, id: existing.id };
      }
      if (r.teams.length >= 12) fail('Room is full');
      if (r.teams.some((t) => t.name.trim().toLowerCase() === b.name.trim().toLowerCase()))
        fail('That team already has a buzzer phone');
      const t = { id: id(), token: token(), client: b.client, name: b.name.trim(), score: 0 };
      r.teams.push(t);
      return { token: t.token, id: t.id };
    });
    return out.result;
  }
  const out = await mutate(bucket, roomKey, (r) => {
    alive(r);
    if (typeof b.commandId !== 'string' || b.commandId.length > 100) fail('Command ID required');
    if (r.processed.includes(b.commandId)) return;
    const q = () => r.deck.boards.flatMap((b) => b.questions).find((q) => q.id === r.current);
    if (action === 'ready') {
      const a = auth(r, bearer);
      if (a.role !== 'team') fail('Team required', 403);
      if (!r.arming || b.epoch !== r.epoch || b.question !== r.current)
        fail('This buzzer is not being prepared', 409);
      r.readyTeams ||= [];
      if (!r.readyTeams.includes(a.team.id)) r.readyTeams.push(a.team.id);
      const activeTeams = r.teams.filter((team) => team.token).map((team) => team.id);
      if (activeTeams.every((teamId) => r.readyTeams.includes(teamId))) {
        r.arming = false;
        r.open = true;
        r.releaseAt = Date.now() + releaseDelay;
      }
    } else if (action === 'buzz') {
      const a = auth(r, bearer);
      if (a.role !== 'team') fail('Team required', 403);
      if (
        !r.open ||
        r.arming ||
        Date.now() < (r.releaseAt || 0) ||
        r.paused ||
        b.epoch !== r.epoch ||
        b.question !== r.current
      )
        fail('Buzzers are closed', 409);
      if (!(r.attempts || []).includes(a.team.id)) {
        r.queue.push(a.team.id);
        (r.attempts ||= []).push(a.team.id);
      }
    } else {
      needHost();
      switch (action) {
        case 'select': {
          const z = r.deck.boards[r.board].questions.find((q) => q.id === b.question);
          if (!z || r.used.includes(z.id)) fail('Question unavailable');
          r.current = z.id;
          r.attempts = [];
          r.reveal = false;
          r.hint = false;
          r.scoreboard = false;
          r.winnerReveal = false;
          r.buzzerCheck = false;
          r.stageView = 'board';
          r.queue = [];
          r.open = false;
          r.arming = true;
          r.readyTeams = [];
          r.releaseAt = 0;
          r.paused = false;
          r.epoch++;
          if (!r.teams.some((team) => team.token)) {
            r.arming = false;
            r.open = true;
            r.releaseAt = Date.now() + releaseDelay;
          }
          break;
        }
        case 'open':
          if (!q() || r.reveal) fail('Select an unanswered question first');
          r.open = true;
          r.arming = false;
          r.readyTeams = [];
          r.releaseAt = Date.now();
          r.paused = false;
          r.epoch++;
          break;
        case 'close':
          r.open = false;
          r.arming = false;
          break;
        case 'pause':
          r.paused = !r.paused;
          r.open = false;
          r.arming = false;
          break;
        case 'lock':
          r.locked = !r.locked;
          break;
        case 'rotate':
          r.join = token();
          break;
        case 'reveal':
          r.reveal = true;
          r.open = false;
          r.arming = false;
          if (r.current && !r.used.includes(r.current)) r.used.push(r.current);
          r.queue = [];
          break;
        case 'hint':
          r.hint = true;
          break;
        case 'back':
          r.current = null;
          r.open = false;
          r.arming = false;
          r.readyTeams = [];
          r.releaseAt = 0;
          r.queue = [];
          r.scoreboard = false;
          r.winnerReveal = false;
          r.buzzerCheck = false;
          r.stageView = 'board';
          r.epoch++;
          break;
        case 'stage':
          r.stageView = r.stageView === 'join' ? 'board' : 'join';
          break;
        case 'scoreboard':
          r.scoreboard = !r.scoreboard;
          r.winnerReveal = false;
          r.buzzerCheck = false;
          break;
        case 'check':
          if (b.mode === 'finish') {
            r.buzzerCheck = false;
            r.open = false;
            r.arming = false;
            r.readyTeams = [];
            r.releaseAt = 0;
            r.queue = [];
            r.attempts = [];
            r.stageView = 'board';
            r.epoch++;
            break;
          }
          if (!r.teams.length) fail('Wait for at least one team to join');
          r.buzzerCheck = true;
          r.current = null;
          r.reveal = false;
          r.hint = false;
          r.scoreboard = false;
          r.winnerReveal = false;
          r.open = true;
          r.arming = false;
          r.readyTeams = [];
          r.releaseAt = Date.now();
          r.paused = false;
          r.queue = [];
          r.attempts = [];
          r.stageView = 'board';
          r.epoch++;
          break;
        case 'winner':
          if (r.current) fail('Finish the current question before revealing the winner');
          if (!r.teams.length) fail('Need at least one team to reveal a winner');
          {
            const questions = r.deck.boards.flatMap((board) => board.questions);
            if (!questions.length || !questions.every((question) => r.used.includes(question.id)))
              fail('Complete every board before revealing the winner');
          }
          r.winnerReveal = true;
          r.buzzerCheck = false;
          r.scoreboard = false;
          r.open = false;
          r.arming = false;
          r.readyTeams = [];
          r.releaseAt = 0;
          r.locked = true;
          r.stageView = 'board';
          break;
        case 'board':
          if (!r.deck.boards[b.board]) fail('Board not found');
          r.board = b.board;
          r.current = null;
          r.open = false;
          r.arming = false;
          r.readyTeams = [];
          r.releaseAt = 0;
          r.queue = [];
          r.winnerReveal = false;
          r.buzzerCheck = false;
          r.epoch++;
          break;
        case 'next':
          r.queue.shift();
          break;
        case 'resolve': {
          const team = r.teams.find((t) => t.id === r.queue[0]);
          if (!team) fail('Wait for a team to buzz');
          if (!['correct', 'incorrect', 'noanswer'].includes(b.outcome)) fail('Invalid outcome');
          const question = q();
          if (!question) fail('Select a question first');
          const delta =
            b.outcome === 'correct'
              ? question.points
              : b.outcome === 'incorrect'
                ? -question.points
                : 0;
          if (delta) {
            team.score += delta;
            r.ledger.push({
              id: b.commandId,
              team: team.id,
              name: team.name,
              delta,
              host: email,
              time: Date.now(),
              reason: b.outcome === 'correct' ? 'Correct answer' : 'Incorrect answer',
            });
          }
          r.queue.shift();
          if (b.outcome === 'correct') {
            r.reveal = true;
            r.open = false;
            r.arming = false;
            r.queue = [];
            if (!r.used.includes(question.id)) r.used.push(question.id);
          }
          break;
        }
        case 'score': {
          const t = r.teams.find((t) => t.id === b.team);
          if (!t) fail('Team not found');
          if (!Number.isFinite(b.amount) || Math.abs(b.amount) > 10000) fail('Invalid points');
          if (b.mode === 'set' && b.expectedScore !== t.score)
            fail('Score changed — review current total', 409);
          const delta = b.mode === 'set' ? b.amount - t.score : b.amount;
          t.score += delta;
          r.ledger.push({
            id: b.commandId,
            team: t.id,
            name: t.name,
            delta,
            host: email,
            time: Date.now(),
            reason: String(b.reason || 'Manual adjustment').slice(0, 200),
          });
          break;
        }
        case 'undo': {
          const entry = [...r.ledger]
            .reverse()
            .find((e) => !e.undo && !r.ledger.some((x) => x.undo === e.id));
          if (!entry) fail('Nothing to undo');
          const t = r.teams.find((t) => t.id === entry.team);
          if (t) t.score -= entry.delta;
          r.ledger.push({
            id: b.commandId,
            undo: entry.id,
            team: entry.team,
            name: entry.name,
            delta: -entry.delta,
            host: email,
            time: Date.now(),
            reason: 'Undo',
          });
          break;
        }
        case 'replace': {
          const t = r.teams.find((t) => t.id === b.team);
          if (!t) fail('Team not found');
          t.token = '';
          t.client = '';
          r.queue = r.queue.filter((x) => x !== t.id);
          break;
        }
        case 'kick':
          r.teams = r.teams.filter((t) => t.id !== b.team);
          r.queue = r.queue.filter((t) => t !== b.team);
          break;
        case 'end':
          r.ended = true;
          r.open = false;
          r.arming = false;
          r.locked = true;
          r.join = '';
          r.stage = '';
          r.teams.forEach((t) => (t.token = ''));
          break;
        default:
          fail('Unknown action');
      }
    }
    r.processed.push(b.commandId);
    if (r.processed.length > 5000) r.processed.shift();
  });
  if (action === 'end')
    await mutate(bucket, 'workspace', (state) => {
      if (state.activeRoomId === rr.id) {
        state.activeRoomId = '';
        state.activeRoomExpires = 0;
      }
    });
  return host ? out.state : publicRoom(out.state, auth(out.state, bearer));
}
