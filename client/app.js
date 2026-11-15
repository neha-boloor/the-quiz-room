const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
let me = {},
  w,
  sessions = [],
  view = 'decks',
  editing,
  slot,
  room,
  guest = false,
  stage = false,
  cred = '',
  joinId = '',
  invite = '',
  timer,
  releaseTimer,
  busy = false,
  refreshPending = false,
  readyRequest = '',
  serverClockOffset = 0,
  lastRev = -1,
  assetURLs = {},
  audioContext,
  buzzQuestion = '',
  heardBuzzes = new Set(),
  winnerCelebratedFor = '';
const uuid = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) =>
        x.toString(16).padStart(2, '0'),
      ).join('');
function toast(s) {
  const t = $('#toast');
  t.className = 'toast';
  t.textContent = s;
  clearTimeout(t.timeout);
  t.timeout = setTimeout(() => {
    t.className = '';
    t.textContent = '';
  }, 5000);
}
function enableBuzzerAudio() {
  if (stage || (!me.host && !guest)) return;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return;
  if (!audioContext) audioContext = new Context();
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}
function playBuzzer(teamId, order = 0) {
  if (room?.deck?.buzzerMedia || room?.buzzerMedia) {
    const key = room?.deck?.buzzerMedia || room.buzzerMedia;
    loadAsset(key)
      .then((url) => {
        const sound = new Audio(url);
        sound.play().catch(() => {});
      })
      .catch(() => {});
    return;
  }
  const context = audioContext;
  if (!context) return;
  const teamIndex = room?.teams.findIndex((t) => t.id === teamId) ?? 0;
  const patterns = [
    [523, 659, 784, 1046],
    [659, 784, 988, 1319],
    [440, 554, 659, 880],
    [587, 740, 880, 1175],
  ];
  const play = () => {
    if (context.state !== 'running') return;
    const now = context.currentTime + order * 0.45;
    patterns[Math.max(0, teamIndex) % patterns.length].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = now + index * 0.095;
      oscillator.type = index % 2 ? 'sine' : 'triangle';
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.2, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.16);
    });
  };
  if (context.state === 'running') play();
  else
    context
      .resume()
      .then(play)
      .catch(() => {});
}
function announceNewBuzzes(next) {
  if (!me.host || guest || stage) return;
  const key = `${next.id}:${next.current || ''}:${next.epoch}`;
  if (key !== buzzQuestion) {
    buzzQuestion = key;
    heardBuzzes = new Set();
  }
  const newBuzzes = next.queue.filter((teamId) => !heardBuzzes.has(teamId));
  next.queue.forEach((teamId) => heardBuzzes.add(teamId));
  newBuzzes.forEach((teamId, index) => playBuzzer(teamId, index));
}
function announceWinner(next) {
  if (!guest || stage) return;
  if (!next.winnerReveal) {
    winnerCelebratedFor = '';
    return;
  }
  if (winnerCelebratedFor === next.id) return;
  winnerCelebratedFor = next.id;
  navigator.vibrate?.([90, 55, 130, 55, 210]);
}
async function api(path, data) {
  const started = Date.now();
  const r = await fetch('/api/' + path, {
    method: data ? 'POST' : 'GET',
    headers: {
      ...(data ? { 'content-type': 'application/json' } : {}),
      ...(cred ? { authorization: 'Bearer ' + cred } : {}),
      ...(guest || stage ? { 'x-guest-view': '1' } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const b = await r.json();
  const finished = Date.now();
  if (Number.isFinite(b?.serverNow)) serverClockOffset = b.serverNow - (started + finished) / 2;
  if (!r.ok) {
    const e = new Error(b.error || 'Request failed');
    e.status = r.status;
    throw e;
  }
  return b;
}
function releaseStarted(r = room) {
  return !r?.releaseAt || Date.now() + serverClockOffset >= r.releaseAt;
}
function releaseWait(r = room) {
  return Math.max(0, (r?.releaseAt || 0) - (Date.now() + serverClockOffset));
}
function buzzerSynchronizing(r = room) {
  return !!(r?.arming || (r?.releaseAt && !releaseStarted(r)));
}
function scheduleReleaseRender() {
  clearTimeout(releaseTimer);
  if (!room?.releaseAt || releaseStarted(room)) return;
  releaseTimer = setTimeout(render, releaseWait(room) + 15);
}
function scheduleBuzzerReady() {
  if (!guest || stage || !room?.arming || room.ready) return;
  const key = `${room.id}:${room.current}:${room.epoch}`;
  if (readyRequest === key) return;
  readyRequest = key;
  requestAnimationFrame(() =>
    requestAnimationFrame(async () => {
      if (!room?.arming || room.ready || key !== `${room.id}:${room.current}:${room.epoch}`) {
        readyRequest = '';
        return;
      }
      try {
        const next = await api('room/' + room.id + '/ready', {
          epoch: room.epoch,
          question: room.current,
          commandId: uuid(),
        });
        if (room?.id === next.id && next.rev >= room.rev) {
          room = next;
          render();
        }
      } catch (error) {
        if (error.status !== 409) toast(error.message);
        refreshRoom();
      } finally {
        readyRequest = '';
      }
    }),
  );
}
function applyTheme(t) {
  if (!t) return;
  for (const [k, v] of Object.entries({
    accent: t.accent,
    bg: t.bg,
    surface: t.surface,
    text: t.text,
    radius: (t.radius || 0) + 'px',
    font: t.font || 'system-ui',
  }))
    document.body.style.setProperty('--' + k, v);
  document.title = t.title || 'The Quiz Room';
  document.body.dataset.theme =
    t.name === 'India Tricolor'
      ? 'india'
      : t.name === 'Diwali Lights' || t.name === 'Diwali Celebration'
        ? 'diwali'
        : 'default';
  const rgb = (t.accent || '#c9a7fa')
    .slice(1)
    .match(/../g)
    .map((x) => parseInt(x, 16));
  document.body.style.setProperty(
    '--accentText',
    rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 145 ? '#15121d' : '#ffffff',
  );
  document.body.style.backgroundImage = '';
  if (t.background)
    loadAsset(t.background).then(
      (url) =>
        (document.body.style.backgroundImage = `linear-gradient(${t.bg}${Math.round(
          (t.overlay ?? 75) * 2.55,
        )
          .toString(16)
          .padStart(2, '0')},${t.bg}ee),url("${url}")`),
    );
  document.body.style.backgroundSize = 'cover';
  document.body.style.backgroundAttachment = 'fixed';
}
async function loadAsset(key) {
  if (assetURLs[key]) return assetURLs[key];
  const q = (guest || stage) && room ? '?room=' + room.id : '';
  const r = await fetch('/api/asset/' + key + q, {
    headers: {
      ...(cred ? { authorization: 'Bearer ' + cred } : {}),
      ...(guest || stage ? { 'x-guest-view': '1' } : {}),
    },
  });
  if (!r.ok) throw Error('Media unavailable');
  return (assetURLs[key] = URL.createObjectURL(await r.blob()));
}
function mediaHTML(key, type = 'image', alt = 'Question media') {
  return key
    ? `<${type === 'audio' ? 'audio' : type === 'video' ? 'video' : 'img'} data-media="${esc(key)}" class="media" ${type !== 'image' ? 'controls' : ''} alt="${esc(alt)}"></${type === 'audio' ? 'audio' : type === 'video' ? 'video' : 'img'}>`
    : '';
}
function hydrate() {
  document.querySelectorAll('[data-media]').forEach((el) =>
    loadAsset(el.dataset.media)
      .then((url) => (el.src = url))
      .catch(() => {}),
  );
  document.querySelectorAll('[data-qr]').forEach((el) => {
    const q = qrcode(0, 'M');
    q.addData(el.dataset.qr);
    q.make();
    el.innerHTML = q.createSvgTag(4, 2);
  });
}
function button(label, a, attrs = '', primary = false) {
  return `<button type="button" data-a="${a}" ${attrs} class="${primary ? 'primary' : ''}">${label}</button>`;
}
function logoHTML(key, icon = '✦') {
  return key
    ? `<img data-media="${esc(key)}" class="logo" alt="Quiz logo">`
    : `<span class="logo-fallback" aria-hidden="true">${esc(icon)}</span>`;
}
function shell(content) {
  const nav = [
    ['decks', '◈', 'Quiz decks'],
    ['themes', '✦', 'Themes'],
    ['parties', '◷', 'Sessions'],
    ['settings', '⚙', 'Settings'],
  ];
  return `<div class="shell"><aside class="sidebar"><div class="brand">${logoHTML(w.brand.logo, w.brand.icon)}<small>HOST CONTROL</small>${esc(w.brand.title)}</div>${nav.map(([v, i, label]) => button(i + ' &nbsp; ' + label, 'view', `data-v="${v}" style="${view === v ? 'background:var(--surface);color:var(--accent)' : ''}"`)).join('')}<footer><span class="pill">The Quiz Room</span></footer></aside><main class="main"><div class="top"><span>${view === 'host' ? 'LIVE HOST DESK' : 'QUIZ DECKS'} <span class="muted">/ The Quiz Room</span></span><span class="pill">${esc(me.local ? 'Local host' : me.email || 'Host')} · Private</span>${me.local ? button('Sign out', 'logout') : ''}</div>${content}</main></div>`;
}
function render() {
  applyTheme(room ? room.theme : w?.brand);
  scheduleReleaseRender();
  if (guest || stage) {
    renderGuest();
    scheduleBuzzerReady();
    return;
  }
  if (!me.host) {
    $('#app').innerHTML =
      `<div class="login"><div class="eyebrow">THE QUIZ ROOM</div><h1>Host a quiz night.</h1><p class="muted">Host a quiz night from your own computer. Joining a game? Scan the QR shown by your host.</p>${me.local ? `<label for="accesscode">Host access code</label><input id="accesscode" type="password" autocomplete="current-password"><div class="toolbar">${button('Host sign in', 'local-login', '', true)}</div><p class="tiny muted">Use the private code printed in the terminal on first setup.</p>` : `<a class="button primary" href="/signin-with-chatgpt?return_to=/" target="_top">Host sign in</a>`}</div>`;
    return;
  }
  let h = '';
  if (view === 'decks') h = decksView();
  if (view === 'themes') h = themesView();
  if (view === 'edit') h = editorView();
  if (view === 'host') h = hostView();
  if (view === 'parties') h = partiesView();
  if (view === 'settings') h = settingsView();
  $('#app').innerHTML = shell(h);
  hydrate();
}
function decksView() {
  const active = activeSession();
  return `<div class="row between"><div class="hero"><div class="eyebrow">QUIZ DECKS</div><h1>Choose a question deck.</h1><p>Create a deck or import a CSV folder, then start a session.</p></div><div class="row">${button('+ New deck', 'new', '', true)}${button('Import CSV folder', 'importcsv')}${w.decks.some((d) => d.archived) ? button('Restore archived', 'restorearchive') : ''}</div></div>${active ? `<div class="card"><strong>Session in progress: ${esc(active.title)}</strong><p>${active.teamCount} ${active.teamCount === 1 ? 'team' : 'teams'} joined</p>${button('Resume host desk', 'room', `data-id="${active.id}"`, true)}</div>` : ''}<div class="grid">${w.decks
    .filter((d) => !d.archived)
    .map(
      (d, i) =>
        `<article class="card deck"><div class="deck-art">${esc(d.title)}</div><div class="eyebrow">${esc(d.group || 'YOUR PEOPLE')}</div><h3>${esc(d.title)}</h3><p class="muted tiny">${d.boards.length} boards · ${d.boards.reduce((n, b) => n + b.questions.length, 0)} questions</p><div class="row">${button('Host quiz ↗', 'start', `data-id="${d.id}" ${active ? 'disabled' : ''}`, true)}${button('Edit', 'edit', `data-id="${d.id}"`)}${button('⋯', 'deckmenu', `data-id="${d.id}" aria-label="Deck options"`)}</div></article>`,
    )
    .join(
      '',
    )}</div><div class="notice tiny">Choose a look in Themes, then start a session from your question deck.</div>`;
}
function activeSession() {
  return sessions
    .filter((session) => session.status === 'In progress')
    .sort((a, b) => b.teamCount - a.teamCount || b.time - a.time)[0];
}
function themesView() {
  const t = w.brand;
  return `<div class="hero"><div class="eyebrow">THEMES</div><h1>Choose a theme.</h1><p>Choose a look for your next quiz. You can add a logo or background image if you like.</p></div><div class="split"><section class="card"><h3>Theme</h3><div class="theme-options">${Object.entries(
    me.presets,
  )
    .map(([key, preset]) =>
      button(
        esc(`${preset.icon} ${preset.name}`),
        'preset',
        `data-key="${key}" aria-pressed="${t.name === preset.name}"`,
      ),
    )
    .join(
      '',
    )}</div><label>Optional logo (PNG, JPG, WebP)</label><input type="file" data-upload="logo" accept="image/png,image/jpeg,image/webp">${t.logo ? button('Remove logo', 'clearasset', 'data-key="logo"') : ''}<label>Optional background image (PNG, JPG, WebP)</label><input type="file" data-upload="background" accept="image/png,image/jpeg,image/webp">${t.background ? button('Remove background', 'clearasset', 'data-key="background"') : ''}<div class="toolbar">${button('Save theme', 'savetheme', '', true)}</div><p class="tiny muted">The selected theme applies to new sessions. A session already in progress keeps its current look.</p></section><aside class="preview">${logoHTML(t.logo, t.icon)}<h2>The Quiz Room</h2><p class="muted">${esc(t.name)}</p><div class="board" style="grid-template-columns:repeat(3,1fr)">${[10, 20, 30].map((x) => `<button class="tile" type="button">${x}</button>`).join('')}</div></aside></div>`;
}
function currentBoard() {
  return editing.boards[editing.bi || 0];
}
function editorView() {
  const b = currentBoard(),
    q = b.questions.find((q) => q.id === slot) || b.questions[0];
  slot = q?.id;
  const mediaTypes = ['text', 'image', 'audio', 'video'];
  const typeOptions = (selected) =>
    mediaTypes.map((t) => `<option ${selected === t ? 'selected' : ''}>${t}</option>`).join('');
  return `<div class="row between"><div><div class="eyebrow">DECK BUILDER</div><h2>${esc(editing.title)}</h2></div><div class="row">${button('← Decks', 'view', 'data-v="decks"')}${button('Save deck', 'savedeck', '', true)}</div></div><div class="formgrid"><div><label>Deck title</label><input data-deck="title" value="${esc(editing.title)}"></div><div><label>Optional buzzer sound (MP3 or WAV)</label><input type="file" data-upload="buzzer" accept="audio/mpeg,audio/wav">${editing.buzzerMedia ? button('Clear buzzer sound', 'clearbuzzer') : ''}</div></div><div class="row toolbar"><label>Board</label><select id="boardpick" style="width:auto">${editing.boards.map((x, i) => `<option value="${i}" ${i === (editing.bi || 0) ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select>${button('+ Add board', 'addboard')}${button('Rename board', 'renameboard')}${button('Resize grid', 'resize')}</div><div class="split"><section>${boardHTML(b, [], true)}<p class="muted tiny">Choose a point tile to edit its question. Click a category title to rename it.</p></section><section class="card">${q ? `<div class="eyebrow">${esc(b.categories[q.col])} · ${q.points} POINTS</div><label>Question</label><textarea data-q="prompt">${esc(q.prompt)}</textarea><label>Question media type</label><select data-q="type">${typeOptions(q.type)}</select><label>Attach question media (10 MB maximum)</label><input type="file" data-upload="question" accept="image/png,image/jpeg,image/webp,audio/mpeg,audio/wav,video/mp4,video/webm">${mediaHTML(q.media, q.type)}${button('Clear question media', 'clearmedia', 'data-kind="question"')}<label>Answer (host only)</label><textarea data-q="answer">${esc(q.answer)}</textarea><label>Answer media type</label><select data-q="answerType">${typeOptions(q.answerType)}</select><label>Attach answer media (shown with the answer)</label><input type="file" data-upload="answer" accept="image/png,image/jpeg,image/webp,audio/mpeg,audio/wav,video/mp4,video/webm">${mediaHTML(q.answerMedia, q.answerType, 'Answer media')}${button('Clear answer media', 'clearmedia', 'data-kind="answer"')}<label>Hint</label><input data-q="hint" value="${esc(q.hint)}"><label>Private host notes</label><textarea data-q="notes">${esc(q.notes)}</textarea><label>Points</label><input data-q="points" type="number" min="0" value="${q.points}">` : 'No question selected'}</section></div>`;
}
function boardHTML(b, used = [], edit = false) {
  return `<div class="board" style="grid-template-columns:repeat(${b.categories.length},minmax(0,1fr))">${b.categories
    .map(
      (c, col) =>
        `<div class="column"><div class="cat">${edit ? button(esc(c), 'category', `data-col="${col}"`) : esc(c)}</div>${b.rows
          .map((v, row) => {
            const q = b.questions.find((q) => q.col === col && q.row === row);
            return q
              ? `<button class="tile ${used.includes(q.id) ? 'used' : ''} ${q.id === slot ? 'chosen' : ''}" data-a="${edit ? 'slot' : 'select'}" data-id="${q.id}" ${!edit && used.includes(q.id) ? 'disabled' : ''}>${used.includes(q.id) ? '✓' : q.points}</button>`
              : '';
          })
          .join('')}</div>`,
    )
    .join('')}</div>`;
}
function categoryGuideHTML(board) {
  if (!board.categoryDescriptions?.some(Boolean)) return '';
  return `<section class="category-guide" aria-label="Private host category introductions"><div class="eyebrow">PRIVATE · HOST CUES</div><h3>How to introduce the categories</h3><div class="category-cue-grid">${board.categories
    .map(
      (category, index) =>
        `<article class="category-cue"><strong><span aria-hidden="true">${esc(board.categoryIcons?.[index] || '✦')}</span> ${esc(category)}</strong><p>“${esc(board.categoryDescriptions[index])}”</p></article>`,
    )
    .join('')}</div></section>`;
}
function scoreHTML(r) {
  return `<div class="score">${r.teams.map((t) => `<div class="team">${esc(t.name)}<strong>${t.score}</strong></div>`).join('') || '<p class="muted">Waiting for teams to join…</p>'}</div>`;
}
function ownScoreHTML(team) {
  return `<div class="score"><div class="team"><span>Your team score</span><strong>${team?.score ?? 0}</strong></div></div>`;
}
function standingsHTML(r) {
  const teams = [...r.teams].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return `<section class="standings"><div class="eyebrow">SCOREBOARD</div><h1>${esc(r.boards?.[r.board]?.title || 'Round')} standings</h1><div class="standings-list">${teams.map((t, i) => `<div class="standing"><span>${i + 1}</span><strong>${esc(t.name)}</strong><b>${t.score}</b></div>`).join('') || '<p class="muted">Waiting for teams to join…</p>'}</div></section>`;
}
function winnerHTML(r) {
  const [winner] = [...r.teams].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return `<section class="winner-screen">${confettiHTML('winner-confetti')}<div class="eyebrow">AND THE WINNER IS</div><h1>${esc(winner?.name || 'Our champions')}</h1><p>${winner ? `${winner.score} points` : 'What a night!'}</p><div class="winner-sparkles" aria-hidden="true">✦ &nbsp; ✧ &nbsp; ✦</div></section>`;
}
function confettiHTML(className) {
  return `<div class="${className}" aria-hidden="true">${Array.from({ length: 18 }, (_, i) => `<i style="--x:${(i * 37) % 100}%;--d:${(i % 6) * -0.45}s;--r:${(i * 53) % 360}deg"></i>`).join('')}</div>`;
}
function boardComplete(r, board) {
  return board.questions.length > 0 && board.questions.every((q) => r.used.includes(q.id));
}
function allBoardsComplete(r) {
  return r.deck.boards.every((board) => boardComplete(r, board));
}
function roundCompleteHTML(r, board) {
  if (!boardComplete(r, board) || r.winnerReveal) return '';
  return `<section class="card resolution"><h3>${allBoardsComplete(r) ? 'All boards complete' : `${esc(board.title)} complete`}</h3><p class="muted">${allBoardsComplete(r) ? 'The final scores are ready. Reveal the winner on the TV when everyone is looking.' : 'Show the scoreboard on TV, then choose the next board when you are ready.'}</p></section>`;
}
function buzzerCheckHTML(r, host = false) {
  const order = (team) => {
    const byId = r.queue.indexOf(team.id),
      byName = r.queue.indexOf(team.name);
    return Math.max(byId, byName);
  };
  const checked = r.teams.filter((team) => order(team) >= 0).length;
  return `<section class="buzzer-check"><div class="eyebrow">SOUND CHECK</div><h1>Test your buzzers</h1><p>${host ? 'Ask every team to tap once. You should hear each team’s chime on this laptop.' : 'One captain per team: tap BUZZ on your phone now.'}</p><div class="check-count">${checked} of ${r.teams.length} teams checked</div><div class="check-grid">${
    r.teams
      .map((team) => {
        const position = order(team);
        return `<div class="check-team ${position >= 0 ? 'checked' : ''}"><span>${position >= 0 ? position + 1 : '·'}</span><strong>${esc(team.name)}</strong><b>${position >= 0 ? 'Buzzed ✓' : 'Waiting'}</b></div>`;
      })
      .join('') || '<p class="muted">Waiting for teams to join…</p>'
  }</div></section>`;
}
function questionHTML(q, r, host = false) {
  const showAnswer = r.reveal || (q.answer && stage);
  return `<div class="question"><div class="eyebrow">${q.points || ''} ${q.points ? 'POINTS' : ''}</div><h2>${esc(q.prompt)}</h2>${mediaHTML(q.media, q.type)}${r.hint && q.hint ? `<p>Hint: ${esc(q.hint)}</p>` : ''}</div>${showAnswer ? `<section class="answer answer-card"><div class="eyebrow">ANSWER</div><strong>${esc(q.answer)}</strong>${mediaHTML(q.answerMedia, q.answerType, 'Answer media')}</section>` : ''}${host ? `<div class="notice"><div class="eyebrow">PRIVATE · HOST ONLY</div><strong>Answer: ${esc(q.answer)}</strong>${mediaHTML(q.answerMedia, q.answerType, 'Answer media')}${q.hint ? `<p>Hint: ${esc(q.hint)}</p>` : ''}${q.notes ? `<p class="tiny muted">${esc(q.notes)}</p>` : ''}</div>` : ''}`;
}
function buzzerSyncHTML(r, host = false) {
  const ready = r.readyTeams?.length ?? r.readyCount ?? 0;
  const total = Array.isArray(r.readyTeams)
    ? r.teams.filter((team) => team.token).length
    : (r.teamCount ?? 0);
  const armed = !r.arming && r.releaseAt;
  return `<section class="card resolution sync-card"><div class="eyebrow">${armed ? 'ALL TEAMS READY' : 'PREPARING BUZZERS'}</div><h2>${armed ? 'Get ready…' : `${ready} of ${total} phones ready`}</h2><p class="muted">${armed ? 'The question and every buzzer will unlock together.' : host ? 'The TV is holding the question until every team phone confirms it is armed.' : 'The question will appear as soon as every team phone is armed.'}</p></section>`;
}
function resolutionHTML(r, q) {
  if (buzzerSynchronizing(r)) return buzzerSyncHTML(r, true);
  const first = r.teams.find((t) => t.id === r.queue[0]);
  if (r.reveal)
    return `<section class="card resolution"><h3>Answer revealed on TV</h3><p class="muted">Choose where the TV goes next.</p><div class="row toolbar">${button('Return TV to board', 'back', '', true)}${button('Show scoreboard on TV', 'scoreboard')}</div></section>`;
  return `<section class="card resolution"><h3>${first ? esc(first.name) + ' is answering' : 'Waiting for the first buzz'}</h3>${first ? `<p class="muted">Resolve this team, then the next queued team moves up automatically.</p><div class="row toolbar">${button(`Correct +${q.points}`, 'resolve', 'data-outcome="correct"', true)}${button(`Incorrect -${q.points}`, 'resolve', 'data-outcome="incorrect"')}${button('No answer', 'resolve', 'data-outcome="noanswer"')}</div>` : '<p class="muted">Buzzers opened when this question appeared.</p>'}<div class="row toolbar">${button('Finish question and reveal', 'reveal')}</div></section>`;
}
function roomLinks() {
  const root = me.partyOrigin || location.origin;
  return {
    join: root + '/#join/' + room.id + '/' + room.join,
    stage: root + '/#stage/' + room.id + '/' + room.stage,
  };
}
function hostView() {
  if (!room) return '<p>Choose a party.</p>';
  const b = room.deck.boards[room.board],
    q = b.questions.find((q) => q.id === room.current),
    links = roomLinks(),
    active = !room.ended && Date.now() < room.expires;
  const live = active
    ? `<div class="split"><section><div class="row toolbar"><select id="liveboard" style="width:auto">${room.deck.boards.map((b, i) => `<option value="${i}" ${i === room.board ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}</select><span class="pill">${room.arming ? `Preparing ${room.readyTeams?.length || 0}/${room.teams.filter((team) => team.token).length}` : room.open && releaseStarted(room) ? 'Buzzers open' : room.releaseAt && !releaseStarted(room) ? 'Starting together…' : 'Buzzers closed'}</span>${room.buzzerCheck ? button('Reset buzzer check', 'check', 'data-mode="reset"') + button('Finish check & show Board 1', 'check', 'data-mode="finish"', true) : button(room.stageView === 'join' ? 'Start buzzer check' : 'Show QR on TV', room.stageView === 'join' ? 'check' : 'stage', room.stageView === 'join' ? 'data-mode="start"' : '', room.stageView === 'join') + button(room.scoreboard ? 'Return TV to board' : 'Show scoreboard on TV', 'scoreboard') + (room.winnerReveal ? button('Return TV to board', 'back', '', true) : !q && allBoardsComplete(room) ? button('Reveal winner on TV', 'winner', '', true) : '')}</div>${room.buzzerCheck ? buzzerCheckHTML(room, true) : room.winnerReveal ? winnerHTML(room) : q ? questionHTML(q, room, true) + resolutionHTML(room, q) : boardHTML(b, room.used) + categoryGuideHTML(b) + roundCompleteHTML(room, b)}</section><aside><section class="card"><div class="eyebrow">ONE PHONE PER TEAM</div><h3>Join this session</h3><div class="qr" data-qr="${links.join}"></div><div class="row toolbar">${button('Copy invitation', 'copy')}${button(room.locked ? 'Unlock joining' : 'Lock joining', 'lock')}</div><p class="tiny muted">Show this QR to your friends. It expires when you end this quiz.</p></section><section class="card" style="margin-top:16px"><h3>Buzz order</h3>${room.queue.map((t, i) => `<div class="ledger">${i + 1}. ${esc(room.teams.find((z) => z.id === t)?.name || 'Removed team')} ${i === 0 ? '<span class="pill">Answering</span>' : ''}</div>`).join('') || '<p class="muted">Waiting for a team to buzz.</p>'}</section><section class="card" style="margin-top:16px"><h3>Team devices</h3>${room.teams.map((t) => `<div class="row between ledger"><span>${esc(t.name)} ${room.arming && t.token ? `<span class="pill">${room.readyTeams?.includes(t.id) ? 'Armed' : 'Waiting'}</span>` : ''}</span>${button('Replace phone', 'replace', `data-id="${t.id}"`)}</div>`).join('')}</section></aside></div>`
    : '';
  return `<div class="row between"><div><div class="eyebrow">${active ? 'SESSION IN PROGRESS' : room.ended ? 'SAVED RESULTS' : 'EXPIRED SESSION'} · <span id="connection">CONNECTED</span></div><h2>${esc(room.title)}</h2></div><div class="row">${active ? `<a class="button" target="_blank" href="${links.stage}">Open TV display ↗</a>${button('End quiz', 'end', 'class="danger"')}` : '<span class="pill">Guest access expired</span>'}</div></div>${scoreHTML(room)}${live}<h3 style="margin-top:32px">Score history</h3>${
    room.ledger
      .slice(-12)
      .reverse()
      .map(
        (e) =>
          `<div class="ledger">${esc(e.name)} <strong>${e.delta > 0 ? '+' : ''}${e.delta}</strong> <span class="muted tiny">${esc(e.reason)} · ${new Date(e.time).toLocaleTimeString()}</span></div>`,
      )
      .join('') || '<p class="muted">Score adjustments will appear here.</p>'
  }`;
}
function partiesView() {
  return `<div class="hero"><div class="eyebrow">SESSIONS</div><h1>Sessions.</h1><p>Resume the room your teams joined, or review finished results.</p></div>${sessions.map((session) => `<div class="card row between" style="margin:12px 0"><div><h3>${esc(session.title)}</h3><span class="pill">${esc(session.status)}</span><span class="muted tiny"> ${session.teamCount} ${session.teamCount === 1 ? 'team' : 'teams'} · ${new Date(session.time).toLocaleString()}</span></div>${session.status !== 'Unavailable' ? button(session.status === 'In progress' ? 'Resume host desk' : 'View results', 'room', `data-id="${session.id}"`, session.status === 'In progress') : ''}</div>`).join('') || '<p>No sessions yet. Host your first quiz.</p>'}`;
}
function settingsView() {
  const cohost = me.local
    ? '<p class="muted">Co-hosts use the same private host access code. Teams only need the QR invitation.</p>'
    : `<h3>Co-host access</h3><label>Co-host ChatGPT account email</label><input id="cohost" type="email" value="${esc(w.cohost)}" ${!me.owner ? 'disabled' : ''}>${button('Save co-host', 'cohost', me.owner ? '' : 'disabled')}`;
  return `<div class="hero"><div class="eyebrow">YOUR QUIZ ROOM</div><h1>Settings.</h1></div><div class="card">${cohost}<h3>Backups</h3><p class="muted">Export your decks, theme and media before large changes. Session results remain in the local data folder.</p>${button('Export complete backup', 'backup')}${button('Restore backup', 'restore')}</div>`;
}
function renderGuest() {
  const root = $('#app');
  if (!room) {
    root.innerHTML = `<main class="login"><div class="eyebrow">THE QUIZ ROOM</div><h1>Join the quiz.</h1><p>One phone per team. Enter your team name to join this quiz.</p><label for="teamname">Team name</label><input id="teamname" maxlength="40" placeholder="Team Chai"><div class="toolbar">${button('Join the quiz →', 'join', '', true)}</div></main>`;
    return;
  }
  if (stage) {
    const b = room.boards[room.board];
    const joinLink = location.origin + '/#join/' + room.id + '/' + room.join;
    const synchronizing =
      room.stageView !== 'join' &&
      !room.buzzerCheck &&
      !room.winnerReveal &&
      !room.scoreboard &&
      buzzerSynchronizing(room);
    const screen =
      room.stageView === 'join'
        ? `<section class="stage-lobby"><div class="stage-join">${logoHTML(room.theme.logo, room.theme.icon)}<div class="eyebrow">JOIN THE QUIZ</div><h1>${esc(room.title)}</h1><p>Scan the code with one phone per team.</p><div class="qr stage-qr" data-qr="${esc(joinLink)}"></div><p class="tiny muted">Your host will start the board shortly.</p></div></section>`
        : synchronizing
          ? buzzerSyncHTML(room)
          : room.buzzerCheck
            ? buzzerCheckHTML(room)
            : room.winnerReveal
              ? winnerHTML(room)
              : room.scoreboard
                ? standingsHTML(room)
                : `${room.question ? questionHTML(room.question, room) : boardHTML(b, room.used)}<div class="row">${room.queue.length ? 'First to buzz: ' + esc(room.queue[0]) : ''}</div>`;
    const stageHeader =
      room.stageView === 'join'
        ? ''
        : `<div class="row between"><div>${logoHTML(room.theme.logo, room.theme.icon)}<div class="eyebrow">${esc(room.theme.title)}</div><h2>${esc(room.buzzerCheck ? 'Buzzer Check' : room.title)}</h2></div><span class="pill">${room.arming ? `Preparing ${room.readyCount}/${room.teamCount}` : room.open && releaseStarted(room) ? 'Buzzers open' : room.releaseAt && !releaseStarted(room) ? 'Starting together…' : 'Buzzers closed'}</span></div>`;
    root.innerHTML = `<main class="stage-main">${stageHeader}${screen}</main>`;
    hydrate();
    return;
  }
  const t = room.teams.find((t) => t.id === room.teamId),
    queued = room.queue.includes(t?.name),
    attempted = room.attempted?.includes(t?.id),
    released = releaseStarted(room),
    can = room.open && released && !room.paused && !queued && !attempted;
  if (room.buzzerCheck) {
    root.innerHTML = `<main class="phone"><div style="padding:20px">${logoHTML(room.theme.logo, room.theme.icon)}<div class="eyebrow">BUZZER CHECK</div><span class="pill" id="guestconnection">Connected</span><h1 style="font-size:42px;margin:28px 0 12px">${esc(t?.name)}</h1><p>No points—this is only a sound check.</p><button class="buzz" data-a="buzz" ${can ? '' : 'disabled'}>${queued ? 'HEARD!' : attempted ? 'DONE' : can ? 'TEST BUZZ' : 'WAIT'}</button><h3>${queued || attempted ? 'Buzzer received.' : can ? 'Tap once so the host can hear your team.' : 'Waiting for the host to start the check.'}</h3></div></main>`;
    hydrate();
    return;
  }
  if (room.winnerReveal) {
    root.innerHTML = `<main class="phone"><section class="phone-celebration">${confettiHTML('phone-confetti')}<div class="eyebrow">QUIZ COMPLETE</div><h1>Celebrate!</h1><p>A winner has been crowned on the TV.</p>${ownScoreHTML(t)}<div class="winner-sparkles" aria-hidden="true">✦ &nbsp; ✧ &nbsp; ✦</div></section></main>`;
    hydrate();
    return;
  }
  const buzzerLabel = room.arming
    ? room.ready
      ? 'ARMED'
      : 'PREPARING'
    : room.releaseAt && !released
      ? 'GET READY'
      : queued
        ? 'YOU’RE IN'
        : attempted
          ? 'DONE'
          : can
            ? 'BUZZ'
            : 'WAIT';
  const buzzerStatus = room.arming
    ? room.ready
      ? `Your buzzer is armed · ${room.readyCount} of ${room.teamCount} teams ready`
      : 'Preparing your buzzer…'
    : room.releaseAt && !released
      ? 'All teams ready — opening together…'
      : queued
        ? 'Queue position ' + (room.queue.indexOf(t.name) + 1)
        : attempted
          ? 'Your turn is complete for this question.'
          : room.paused
            ? 'Quiz paused'
            : can
              ? 'Buzzers open - go for it!'
              : 'Waiting for the host';
  root.innerHTML = `<main class="phone"><div style="padding:20px">${logoHTML(room.theme.logo, room.theme.icon)}<div class="eyebrow">${esc(room.theme.title)}</div><span class="pill" id="guestconnection">Connected</span><h1 style="font-size:42px;margin:28px 0 12px">${esc(t?.name)}</h1><div class="eyebrow">YOUR SCORE</div><div style="font:64px system-ui;color:var(--accent)">${t?.score ?? 0}</div><button class="buzz" data-a="buzz" ${can ? '' : 'disabled'}>${buzzerLabel}</button><h3>${buzzerStatus}</h3><p class="tiny muted">One phone per team.</p>${ownScoreHTML(t)}</div></main>`;
  hydrate();
}
async function refreshRoom() {
  if (!room || room.ended) return;
  try {
    const next = await api('room/' + room.id);
    if (next.rev !== room.rev || (!room._expired && Date.now() >= next.expires)) {
      announceNewBuzzes(next);
      announceWinner(next);
      if (Date.now() >= next.expires) next._expired = true;
      room = next;
      render();
    }
    $('#connection') && ($('#connection').textContent = 'CONNECTED');
    $('#guestconnection') && ($('#guestconnection').textContent = 'Connected');
  } catch (e) {
    if (e.status === 410) {
      clearInterval(timer);
      room = null;
      $('#app').innerHTML =
        '<main class="login"><div class="eyebrow">THANKS FOR PLAYING</div><h1>That’s a wrap.</h1><p>This quiz has ended. Your team access has expired.</p></main>';
    } else {
      $('#connection') && ($('#connection').textContent = 'RECONNECTING');
      $('#guestconnection') && ($('#guestconnection').textContent = 'Reconnecting — wait');
      document.querySelectorAll('.buzz').forEach((b) => (b.disabled = true));
    }
  }
}
let liveSocket, liveReconnect;
function startPoll() {
  clearInterval(timer);
  clearTimeout(liveReconnect);
  if (liveSocket) {
    liveSocket.onclose = null;
    liveSocket.close();
    liveSocket = null;
  }
  timer = setInterval(
    () => {
      if (!busy) refreshRoom();
      else refreshPending = true;
    },
    me.local ? 750 : 1000,
  );
  if (!me.local || !room || room.ended) return;
  const connect = () => {
    if (!me.local || !room || room.ended) return;
    const socket = new WebSocket(
      (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/live',
    );
    liveSocket = socket;
    socket.onopen = () =>
      socket.send(JSON.stringify({ roomId: room.id, token: cred, guest: guest || stage }));
    socket.onmessage = () => {
      if (!busy) refreshRoom();
      else refreshPending = true;
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (liveSocket === socket) liveReconnect = setTimeout(connect, 500);
    };
  };
  connect();
}

async function importCSVFolder(fileList) {
  const files = [...fileList];
  const csv = files.find(
    (file) => file.webkitRelativePath?.endsWith('/questions.csv') || file.name === 'questions.csv',
  );
  if (!csv) throw Error('Choose a folder containing questions.csv and an optional media/ folder');
  const prefix = csv.webkitRelativePath?.slice(0, -'questions.csv'.length) || '';
  const types = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    webm: 'video/webm',
  };
  const media = {};
  const assets = files.filter((file) => {
    const relative = file.webkitRelativePath?.slice(prefix.length) || '';
    return relative.startsWith('media/') && types[relative.split('.').pop().toLowerCase()];
  });
  for (let index = 0; index < assets.length; index++) {
    const file = assets[index];
    const relative = file.webkitRelativePath.slice(prefix.length);
    const type = types[relative.split('.').pop().toLowerCase()];
    if (file.size > 10 * 1024 * 1024) throw Error(`Media exceeds 10 MB: ${relative}`);
    toast(`Uploading media ${index + 1}/${assets.length}…`);
    const url = await dataURL(file);
    media[relative] = (await api('upload', { type, data: url.split(',')[1] })).key;
  }
  const result = await api('deck/import', { csv: await csv.text(), media });
  w = await api('workspace');
  render();
  toast(`Imported ${result.title}`);
}

async function action(a, el) {
  if (busy) return;
  busy = true;
  try {
    if (a === 'local-login') {
      await api('local/login', { accessCode: $('#accesscode').value });
      await boot();
    } else if (a === 'logout') {
      await api('local/logout', {});
      location.reload();
    } else if (a === 'view') {
      clearInterval(timer);
      room = null;
      view = el.dataset.v;
      w = await api('workspace');
      sessions = await api('sessions');
      render();
    } else if (a === 'new') {
      const title = prompt('Name your quiz deck');
      if (title) {
        const categories = Array.from({ length: 5 }, (_, i) => `Category ${i + 1}`);
        const rows = [10, 20, 30, 40, 50];
        const d = {
          id: uuid(),
          rev: 0,
          title,
          group: 'Friends',
          description: '',
          archived: false,
          theme: null,
          buzzerMedia: '',
          boards: [
            {
              id: uuid(),
              title: 'Board 1',
              categories,
              rows,
              questions: categories.flatMap((_, col) =>
                rows.map((points, row) => ({
                  id: uuid(),
                  col,
                  row,
                  points,
                  prompt: '',
                  answer: '',
                  hint: '',
                  notes: '',
                  type: 'text',
                  media: '',
                  answerType: 'text',
                  answerMedia: '',
                })),
              ),
            },
          ],
        };
        w.decks.push(d);
        w = await api('workspace/save', { rev: w.rev, decks: w.decks });
        editing = structuredClone(d);
        view = 'edit';
        render();
      }
    } else if (a === 'importcsv') {
      const input = document.createElement('input');
      input.type = 'file';
      input.setAttribute('webkitdirectory', '');
      input.multiple = true;
      input.onchange = () => importCSVFolder(input.files).catch((error) => toast(error.message));
      input.click();
    } else if (a === 'edit') {
      editing = structuredClone(w.decks.find((d) => d.id === el.dataset.id));
      slot = null;
      view = 'edit';
      render();
    } else if (a === 'slot') {
      slot = el.dataset.id;
      render();
    } else if (a === 'savedeck') {
      const clean = structuredClone(editing);
      delete clean.bi;
      const i = w.decks.findIndex((d) => d.id === clean.id);
      w.decks[i] = clean;
      w = await api('workspace/save', { rev: w.rev, decks: w.decks });
      toast('Deck saved');
    } else if (a === 'category') {
      const b = currentBoard(),
        c = prompt('Category name', b.categories[el.dataset.col]);
      if (c) {
        b.categories[el.dataset.col] = c;
        render();
      }
    } else if (a === 'renameboard') {
      const b = currentBoard(),
        v = prompt('Board title', b.title);
      if (v) {
        b.title = v;
        render();
      }
    } else if (a === 'resize') {
      const cols = Number(prompt('Number of categories (1–8)', currentBoard().categories.length)),
        rows = Number(prompt('Number of value rows (1–6)', currentBoard().rows.length));
      if (cols >= 1 && cols <= 8 && rows >= 1 && rows <= 6) {
        const b = currentBoard();
        b.categories = Array.from(
          { length: cols },
          (_, i) => b.categories[i] || 'Category ' + (i + 1),
        );
        b.rows = Array.from({ length: rows }, (_, i) => b.rows[i] || (i + 1) * 10);
        b.questions = Array.from({ length: cols }, (_, col) =>
          Array.from(
            { length: rows },
            (_, row) =>
              b.questions.find((q) => q.col === col && q.row === row) || {
                id: uuid(),
                col,
                row,
                points: b.rows[row],
                prompt: '',
                answer: '',
                hint: '',
                notes: '',
                type: 'text',
                media: '',
                answerType: 'text',
                answerMedia: '',
              },
          ),
        ).flat();
        slot = null;
        render();
      }
    } else if (a === 'addboard') {
      const b = structuredClone(currentBoard());
      b.id = uuid();
      b.title = 'New board';
      b.questions.forEach((q) => {
        q.id = uuid();
        q.prompt = '';
        q.answer = '';
        q.notes = '';
        q.type = 'text';
        q.media = '';
        q.answerType = 'text';
        q.answerMedia = '';
      });
      editing.boards.push(b);
      editing.bi = editing.boards.length - 1;
      slot = null;
      render();
    } else if (a === 'clearbuzzer') {
      editing.buzzerMedia = '';
      render();
    } else if (a === 'clearmedia') {
      const q = currentBoard().questions.find((q) => q.id === slot);
      q[el.dataset.kind === 'answer' ? 'answerMedia' : 'media'] = '';
      render();
    } else if (a === 'preset') {
      w.brand = {
        ...w.brand,
        ...me.presets[el.dataset.key],
        title: 'The Quiz Room',
        tagline: 'Your questions. Your people.',
      };
      render();
    } else if (a === 'clearasset') {
      w.brand[el.dataset.key] = '';
      render();
    } else if (a === 'savetheme') {
      w.brand.title = 'The Quiz Room';
      w.brand.tagline = 'Your questions. Your people.';
      w = await api('workspace/save', { rev: w.rev, brand: w.brand });
      toast('Theme saved');
      render();
    } else if (a === 'cohost') {
      w = await api('workspace/save', { rev: w.rev, cohost: $('#cohost').value });
      toast('Co-host permissions saved');
    } else if (a === 'start') {
      const deck = w.decks.find((d) => d.id === el.dataset.id);
      const title = prompt(
        'Session name (shown to teams and on TV)',
        `${deck.title} · ${new Date().toLocaleDateString()}`,
      );
      if (title === null) return;
      if (!title.trim()) throw Error('Enter a session name');
      room = await api('room/create', { deck: deck.id, title: title.trim() });
      sessions = await api('sessions');
      view = 'host';
      render();
      startPoll();
    } else if (a === 'room') {
      room = await api('room/' + el.dataset.id);
      view = 'host';
      render();
      startPoll();
    } else if (a === 'copy') {
      await navigator.clipboard.writeText(roomLinks().join);
      toast('Invitation copied');
    } else if (a === 'backup') {
      const keys = new Set(
        [
          w.brand.logo,
          w.brand.background,
          ...w.decks.flatMap((d) => [
            d.theme?.logo,
            d.theme?.background,
            d.buzzerMedia,
            ...d.boards.flatMap((b) => b.questions.flatMap((q) => [q.media, q.answerMedia])),
          ]),
        ].filter(Boolean),
      );
      const assets = {};
      for (const key of keys) {
        const r = await fetch('/api/asset/' + key);
        const blob = await r.blob();
        assets[key] = await dataURL(blob);
      }
      download('quiz-room-backup.json', { schema: 1, workspace: w, assets });
      toast('Backup exported');
    } else if (a === 'restore') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async () => {
        try {
          const v = JSON.parse(await input.files[0].text());
          if (!confirm('Restore these decks and theme? Existing decks will be replaced.')) return;
          const map = {};
          for (const [key, url] of Object.entries(v.assets || {})) {
            const mm = url.match(/^data:([^;]+);base64,(.+)$/);
            if (mm) map[key] = (await api('upload', { type: mm[1], data: mm[2] })).key;
          }
          const str = JSON.stringify(v.workspace);
          const restored = JSON.parse(str.replace(/[0-9a-f-]{36}/g, (k) => map[k] || k));
          w = await api('workspace/save', {
            rev: w.rev,
            brand: restored.brand,
            decks: restored.decks,
          });
          render();
          toast('Imported successfully');
        } catch (e) {
          toast(e.message);
        }
      };
      input.click();
    } else if (a === 'restorearchive') {
      w.decks.forEach((d) => (d.archived = false));
      w = await api('workspace/save', { rev: w.rev, decks: w.decks });
      render();
    } else if (a === 'deckmenu') {
      const d = w.decks.find((d) => d.id === el.dataset.id),
        choice = prompt('Type duplicate, archive, or restore', 'duplicate');
      if (choice === 'duplicate') {
        const x = structuredClone(d);
        x.id = uuid();
        x.title += ' (copy)';
        w.decks.push(x);
      } else if (choice === 'archive') d.archived = true;
      else if (choice === 'restore') w.decks.forEach((x) => (x.archived = false));
      else return;
      w = await api('workspace/save', { rev: w.rev, decks: w.decks });
      render();
    } else if (a === 'join') {
      let client = localStorage.getItem('quiz-client');
      if (!client) localStorage.setItem('quiz-client', (client = uuid()));
      const t = await api('room/' + joinId + '/join', {
        invite,
        name: $('#teamname').value,
        client,
        resume: localStorage.getItem('quiz-team-' + joinId) || '',
      });
      cred = t.token;
      localStorage.setItem('quiz-team-' + joinId, cred);
      room = await api('room/' + joinId);
      render();
      startPoll();
    } else if (a === 'buzz') {
      const data = { epoch: room.epoch, question: room.current, commandId: uuid() };
      playBuzzer(room.teamId);
      room = await api('room/' + room.id + '/buzz', data);
      render();
    } else if (room) {
      if (a === 'end' && !confirm('End this quiz and revoke all guest access now?')) return;
      if (
        a === 'replace' &&
        !confirm(
          'Revoke this phone? A new captain can join with the same team name and keep its score.',
        )
      )
        return;
      let data = { commandId: uuid() };
      if (a === 'select') data.question = el.dataset.id;
      if (a === 'kick' || a === 'replace') data.team = el.dataset.id;
      if (a === 'resolve') data.outcome = el.dataset.outcome;
      if (a === 'check') data.mode = el.dataset.mode;
      if (a === 'score') {
        const team = room.teams.find((t) => t.id === $('#scoreteam').value);
        if (!team) throw Error('Wait for a team to join');
        data = {
          ...data,
          team: team.id,
          amount: Number($('#points').value) * (el.dataset.mode === 'subtract' ? -1 : 1),
          mode: el.dataset.mode === 'set' ? 'set' : 'delta',
          expectedScore: team.score,
        };
      }
      room = await api('room/' + room.id + '/' + a, data);
      if (a === 'end') sessions = await api('sessions');
      render();
    }
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
    if (refreshPending) {
      refreshPending = false;
      refreshRoom();
    }
  }
}
document.addEventListener('click', (e) => {
  enableBuzzerAudio();
  const el = e.target.closest('[data-a]');
  if (el) action(el.dataset.a, el);
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.deck) editing[el.dataset.deck] = el.value;
  if (el.dataset.q) {
    const q = currentBoard().questions.find((q) => q.id === slot);
    q[el.dataset.q] = el.dataset.q === 'points' ? Number(el.value) : el.value;
  }
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'boardpick') {
    editing.bi = Number(el.value);
    slot = null;
    render();
  }
  if (el.id === 'liveboard') {
    room = await api('room/' + room.id + '/board', { board: Number(el.value), commandId: uuid() });
    render();
  }
  if (el.dataset.upload && el.files[0]) {
    try {
      const f = el.files[0];
      if (f.size > 10 * 1024 * 1024) throw Error('Maximum file size 10 MB');
      toast('Uploading…');
      const url = await dataURL(f),
        r = await api('upload', { type: f.type, data: url.split(',')[1] });
      if (el.dataset.upload === 'buzzer') {
        editing.buzzerMedia = r.key;
      } else if (el.dataset.upload === 'question' || el.dataset.upload === 'answer') {
        const q = currentBoard().questions.find((q) => q.id === slot);
        const answer = el.dataset.upload === 'answer';
        q[answer ? 'answerMedia' : 'media'] = r.key;
        q[answer ? 'answerType' : 'type'] = f.type.split('/')[0];
      } else w.brand[el.dataset.upload] = r.key;
      render();
      toast('Uploaded — save your changes');
    } catch (e) {
      toast(e.message);
    }
  }
});
function dataURL(blob) {
  return new Promise((ok, err) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = err;
    r.readAsDataURL(blob);
  });
}
function download(name, obj) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }),
  );
  a.download = name;
  a.click();
}
async function boot() {
  const parts = location.hash.slice(1).split('/');
  guest = parts[0] === 'join';
  stage = parts[0] === 'stage';
  try {
    me = await api('me');
    if (guest || stage) {
      joinId = parts[1];
      invite = parts[2];
      cred = stage ? invite : localStorage.getItem('quiz-team-' + joinId) || '';
      if (cred) {
        try {
          room = await api('room/' + joinId);
        } catch (e) {
          if (e.status === 410) throw e;
          cred = '';
          localStorage.removeItem('quiz-team-' + joinId);
        }
      }
      render();
      if (room) startPoll();
    } else {
      if (me.host) {
        w = await api('workspace');
        sessions = await api('sessions');
        const active = activeSession();
        if (active) {
          room = await api('room/' + active.id);
          view = 'host';
        }
      }
      render();
      if (room) startPoll();
    }
  } catch (e) {
    $('#app').innerHTML =
      `<main class="login"><div class="eyebrow">THE QUIZ ROOM</div><h1>${e.status === 410 ? 'That’s a wrap.' : 'A moment, please.'}</h1><p>${esc(e.message)}</p><a class="button" href="/">Return home</a></main>`;
  }
}
window.addEventListener('hashchange', () => location.reload());
boot();
