const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
let me = {},
  w,
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
  busy = false,
  lastRev = -1,
  assetURLs = {};
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
async function api(path, data) {
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
  if (!r.ok) {
    const e = new Error(b.error || 'Request failed');
    e.status = r.status;
    throw e;
  }
  return b;
}
function applyTheme(t) {
  if (!t) return;
  for (const [k, v] of Object.entries({
    accent: t.accent,
    bg: t.bg,
    surface: t.surface,
    text: t.text,
    radius: (t.radius || 0) + 'px',
    font: t.font || 'Georgia',
  }))
    document.body.style.setProperty('--' + k, v);
  document.title = t.title || 'The Quiz Room';
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
function mediaHTML(key, type = 'image') {
  return key
    ? `<${type === 'audio' ? 'audio' : type === 'video' ? 'video' : 'img'} data-media="${esc(key)}" class="media" ${type !== 'image' ? 'controls' : ''} alt="Question media"></${type === 'audio' ? 'audio' : type === 'video' ? 'video' : 'img'}>`
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
function logoHTML(key) {
  return key ? `<img data-media="${esc(key)}" class="logo" alt="Quiz club logo">` : '';
}
function shell(content) {
  const nav = [
    ['decks', '◈', 'Quiz decks'],
    ['themes', '✦', 'Theme studio'],
    ['parties', '◷', 'Party history'],
    ['settings', '⚙', 'Settings'],
  ];
  return `<div class="shell"><aside class="sidebar"><div class="brand">${logoHTML(w.brand.logo)}<small>YOUR PRIVATE QUIZ CLUB</small>${esc(w.brand.title)}</div>${nav.map(([v, i, label]) => button(i + ' &nbsp; ' + label, 'view', `data-v="${v}" style="${view === v ? 'background:var(--surface);color:var(--accent)' : ''}"`)).join('')}<footer><span class="pill">Your quiz club</span><p class="tiny muted" style="margin-top:18px">Made for the people<br>who make your evenings.</p></footer></aside><main class="main"><div class="top"><span>${view === 'host' ? 'LIVE HOST DESK' : 'THE STUDIO'} <span class="muted">/ Your quiz club</span></span><span class="pill">${esc(me.local ? 'Local host' : me.email || 'Host')} · Private</span>${me.local ? button('Sign out', 'logout') : ''}</div>${content}</main></div>`;
}
function render() {
  applyTheme(room ? room.theme : w?.brand);
  if (guest || stage) {
    renderGuest();
    return;
  }
  if (!me.host) {
    $('#app').innerHTML =
      `<div class="login"><div class="eyebrow">THE QUIZ ROOM</div><h1>Good company.<br>Great questions.</h1><p class="muted">A private quiz studio for your quiz club. Joining a party? Scan the QR shown by your host.</p>${me.local ? `<label for="accesscode">Host access code</label><input id="accesscode" type="password" autocomplete="current-password"><div class="toolbar">${button('Host sign in', 'local-login', '', true)}</div><p class="tiny muted">Use the private code printed in the terminal on first setup.</p>` : `<a class="button primary" href="/signin-with-chatgpt?return_to=/" target="_top">Host sign in</a>`}</div>`;
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
  return `<div class="row between"><div class="hero"><div class="eyebrow">LET'S MAKE A NIGHT OF IT</div><h1>Your next great<br>quiz starts here.</h1><p>Build a board, make it yours, and bring everyone together. A different deck for every crowd.</p></div><div class="row">${button('+ New deck', 'new', '', true)}${button('Import deck', 'import')}${w.decks.some((d) => d.archived) ? button('Restore archived', 'restorearchive') : ''}</div></div><div class="grid">${w.decks
    .filter((d) => !d.archived)
    .map(
      (d, i) =>
        `<article class="card deck"><div class="deck-art">${esc(d.title)}</div><div class="eyebrow">${esc(d.group || 'YOUR PEOPLE')}</div><h3>${esc(d.title)}</h3><p class="muted tiny">${d.boards.length} boards · ${d.boards.reduce((n, b) => n + b.questions.length, 0)} questions</p><div class="row">${button('Host quiz ↗', 'start', `data-id="${d.id}"`, true)}${button('Edit', 'edit', `data-id="${d.id}"`)}${button('⋯', 'deckmenu', `data-id="${d.id}" aria-label="Deck options"`)}</div></article>`,
    )
    .join(
      '',
    )}</div><div class="notice tiny">✦ Your household look applies everywhere. Open Theme studio to upload your logo, change backgrounds, colours and typography.</div>`;
}
function themesView() {
  const t = w.brand;
  return `<div class="hero"><div class="eyebrow">MAKE IT UNMISTAKABLY YOURS</div><h1>Set the atmosphere.</h1><p>One identity, across your studio, TV board and team phones. Changes apply to future parties; live games keep their chosen look.</p></div><div class="split"><section class="card"><div class="row">${Object.entries(
    me.presets,
  )
    .map(([key, t]) => button(t.name, 'preset', `data-key="${key}"`))
    .join(
      '',
    )}</div><div class="formgrid">${field('Site title', 'title', t.title)}${field('Tagline', 'tagline', t.tagline)}${['accent', 'bg', 'surface', 'text'].map((k) => `<div><label>${{ accent: 'Accent', bg: 'Background', surface: 'Card & tile surface', text: 'Text colour' }[k]}</label><input type="color" data-theme="${k}" value="${esc(t[k])}"></div>`).join('')}<div><label>Heading font</label><select data-theme="font">${['Georgia', 'Arial', 'Verdana', 'Trebuchet MS', 'Courier New'].map((f) => `<option ${t.font === f ? 'selected' : ''}>${f}</option>`).join('')}</select></div><div><label>Corner radius</label><input type="range" data-theme="radius" min="0" max="32" value="${t.radius}"></div><div><label>Logo (PNG, JPG, WebP)</label><input type="file" data-upload="logo" accept="image/png,image/jpeg,image/webp">${button('Remove logo', 'clearasset', 'data-key="logo"')}</div><div><label>Background image</label><input type="file" data-upload="background" accept="image/png,image/jpeg,image/webp">${button('Remove background', 'clearasset', 'data-key="background"')}</div><div><label>Background overlay</label><input type="range" data-theme="overlay" min="0" max="95" value="${t.overlay ?? 75}"></div></div><div class="toolbar">${button('Save household theme', 'savetheme', '', true)}</div></section><aside><div class="preview">${t.logo ? logoHTML(t.logo) : '<div class="eyebrow">✦ YOUR LOGO HERE</div>'}<h2>${esc(t.title)}</h2><p class="muted">${esc(t.tagline)}</p><div class="board" style="grid-template-columns:repeat(3,1fr)">${[10, 20, 30].map((x) => `<button class="tile">${x}</button>`).join('')}</div><div class="score"><div class="team">Team Chai<strong>120</strong></div></div>${button('Your team buzzer', 'noop', '', true)}</div><p class="tiny muted" style="margin-top:16px">Preview · Branding applies to app screens. ChatGPT's sign-in screen is managed by the platform.</p></aside></div>`;
}
function field(label, key, value, attr = '') {
  return `<div><label for="f-${key}">${label}</label><input id="f-${key}" data-theme="${key}" value="${esc(value)}" ${attr}></div>`;
}
function currentBoard() {
  return editing.boards[editing.bi || 0];
}
function editorView() {
  const b = currentBoard(),
    q = b.questions.find((q) => q.id === slot) || b.questions[0];
  slot = q?.id;
  return `<div class="row between"><div><div class="eyebrow">DECK BUILDER</div><h2>${esc(editing.title)}</h2></div><div class="row">${button('← Decks', 'view', 'data-v="decks"')}${button('Save deck', 'savedeck', '', true)}${button('Export', 'export')}</div></div><div class="formgrid"><div><label>Deck title</label><input data-deck="title" value="${esc(editing.title)}"></div><div><label>Friend group</label><input data-deck="group" value="${esc(editing.group)}"></div></div><div class="row toolbar"><label>Board</label><select id="boardpick" style="width:auto">${editing.boards.map((x, i) => `<option value="${i}" ${i === (editing.bi || 0) ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select>${button('+ Add board', 'addboard')}${button('Rename board', 'renameboard')}${button('Resize grid', 'resize')}${button('Deck appearance', 'decktheme')}</div><div class="split"><section>${boardHTML(b, [], true)}<p class="muted tiny">Choose a point tile to edit its question. Click a category title to rename it.</p></section><section class="card">${q ? `<div class="eyebrow">${esc(b.categories[q.col])} · ${q.points} POINTS</div><label>Question</label><textarea data-q="prompt">${esc(q.prompt)}</textarea><label>Answer (host only)</label><textarea data-q="answer">${esc(q.answer)}</textarea><label>Hint</label><input data-q="hint" value="${esc(q.hint)}"><label>Private host notes</label><textarea data-q="notes">${esc(q.notes)}</textarea><label>Points</label><input data-q="points" type="number" min="0" value="${q.points}"><label>Media type</label><select data-q="type">${['text', 'image', 'audio', 'video'].map((t) => `<option ${q.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select><label>Attach question media (10 MB maximum)</label><input type="file" data-upload="question" accept="image/png,image/jpeg,image/webp,audio/mpeg,audio/wav,video/mp4,video/webm">${mediaHTML(q.media, q.type)}${button('Clear media', 'clearmedia')}` : 'No question selected'}</section></div>`;
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
function scoreHTML(r) {
  return `<div class="score">${r.teams.map((t) => `<div class="team">${esc(t.name)}<strong>${t.score}</strong></div>`).join('') || '<p class="muted">Waiting for teams to join…</p>'}</div>`;
}
function questionHTML(q, r, host = false) {
  return `<div class="question"><div class="eyebrow">${q.points || ''} ${q.points ? 'POINTS' : ''}</div><h2>${esc(q.prompt)}</h2>${mediaHTML(q.media, q.type)}${r.hint && q.hint ? `<p>Hint: ${esc(q.hint)}</p>` : ''}${r.reveal || (q.answer && stage) ? `<div class="answer">${esc(q.answer)}</div>` : ''}</div>${host ? `<div class="notice"><div class="eyebrow">PRIVATE · HOST ONLY</div><strong>Answer: ${esc(q.answer)}</strong>${q.hint ? `<p>Hint: ${esc(q.hint)}</p>` : ''}${q.notes ? `<p class="tiny muted">${esc(q.notes)}</p>` : ''}</div>` : ''}`;
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
    links = roomLinks();
  return `<div class="row between"><div><div class="eyebrow">${room.ended ? 'SAVED RESULTS' : 'LIVE PARTY'} · <span id="connection">CONNECTED</span></div><h2>${esc(room.title)}</h2></div><div class="row">${!room.ended ? `<a class="button" target="_blank" href="${links.stage}">Open TV display ↗</a>${button('End quiz', 'end', 'class="danger"')}` : '<span class="pill">Guest access expired</span>'}</div></div>${scoreHTML(room)}${!room.ended ? `<div class="split"><section><div class="row toolbar"><select id="liveboard" style="width:auto">${room.deck.boards.map((b, i) => `<option value="${i}" ${i === room.board ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}</select><span class="pill">${room.paused ? 'Paused' : room.open ? 'Buzzers open' : 'Buzzers closed'}</span></div>${q ? questionHTML(q, room, true) : boardHTML(b, room.used)}<div class="row toolbar">${q ? button(room.open ? 'Close buzzers' : 'Open buzzers', room.open ? 'close' : 'open', '', true) + button('Show hint', 'hint') + button('Reveal answer', 'reveal') + button('← Board', 'back') : ''}${button(room.paused ? 'Resume' : 'Pause', 'pause')}</div><section class="card"><h3>Points desk</h3><div class="row"><select id="scoreteam" style="width:auto;flex:1">${room.teams.map((t) => `<option value="${t.id}">${esc(t.name)} (${t.score})</option>`).join('')}</select><input id="points" type="number" value="${q?.points || 10}" style="width:100px" aria-label="Points amount"></div><div class="row toolbar">${button('+ Add', 'score', 'data-mode="add"', true)}${button('− Subtract', 'score', 'data-mode="subtract"')}${button('Set total', 'score', 'data-mode="set"')}${button('Undo last', 'undo')}</div><div class="tiny muted">Manual points · only hosts can change scores.</div></section></section><aside><section class="card"><div class="eyebrow">ONE PHONE PER TEAM</div><h3>Scan. Team up. Buzz.</h3><div class="qr" data-qr="${links.join}"></div><div class="row toolbar">${button('Copy invitation', 'copy')}${button(room.locked ? 'Unlock joining' : 'Lock joining', 'lock')}</div><p class="tiny muted">Show this QR to your friends. It expires when you end this quiz.</p></section><section class="card" style="margin-top:16px"><h3>Buzz order</h3>${room.queue.map((t, i) => `<div class="ledger">${i + 1}. ${esc(room.teams.find((z) => z.id === t)?.name || 'Removed team')} ${i === 0 ? '<span class="pill">Answering</span>' : ''}</div>`).join('') || '<p class="muted">Ready when they are.</p>'}${room.queue.length ? button('Next queued team →', 'next') : ''}</section><section class="card" style="margin-top:16px"><h3>Team devices</h3>${room.teams.map((t) => `<div class="row between ledger">${esc(t.name)}${button('Replace phone', 'replace', `data-id="${t.id}"`)}</div>`).join('')}</section></aside></div>` : ''}<h3 style="margin-top:32px">Score history</h3>${
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
  return `<div class="hero"><div class="eyebrow">GOOD TIMES, SAVED</div><h1>Party history.</h1><p>Reopen a host desk or review saved results.</p></div>${w.rooms.map((r) => `<div class="card row between" style="margin:12px 0"><div><h3>${esc(r.title)}</h3><span class="muted tiny">${new Date(r.time).toLocaleString()} · ${esc(r.group)}</span></div>${button('Open host desk', 'room', `data-id="${r.id}"`)}</div>`).join('') || '<p>No parties yet. Host your first deck.</p>'}`;
}
function settingsView() {
  return `<div class="hero"><div class="eyebrow">YOUR PRIVATE CLUB</div><h1>Your private quiz club.</h1></div><div class="card"><h3>Co-host access</h3>${me.local ? '<p class="notice">Local mode: you and your co-host use the private host access code. Team phones join only through the QR. ChatGPT sign-in is not required.</p>' : ''}<p class="muted">Only your account and the ChatGPT account entered below can edit decks or host games. Guests only receive temporary team access.</p><label>Co-host ChatGPT account email</label><input id="cohost" type="email" value="${esc(w.cohost)}" ${!me.owner || me.local ? 'disabled' : ''}><div class="toolbar">${button('Save co-host', 'cohost', me.owner && !me.local ? '' : 'disabled', true)}</div><h3>Backup</h3><p class="muted">Export includes decks, theme settings and uploaded media. Keep a copy before large edits.</p>${button('Export complete backup', 'backup')}${button('Restore backup', 'restore')}<div class="notice tiny">Scores sync from the server approximately every second. Buzzes are accepted and ordered by the server immediately. No extra service account or subscription is required. Local mode also sends live updates over WebSockets.</div></div>`;
}
function renderGuest() {
  const root = $('#app');
  if (!room) {
    root.innerHTML = `<main class="login"><div class="eyebrow">THE QUIZ ROOM</div><h1>Your team.<br>Your moment.</h1><p>One phone per team. Enter your team name to join this quiz.</p><label for="teamname">Team name</label><input id="teamname" maxlength="40" placeholder="Team Chai"><div class="toolbar">${button('Join the quiz →', 'join', '', true)}</div></main>`;
    return;
  }
  if (stage) {
    const b = room.boards[room.board];
    root.innerHTML = `<main style="padding:40px"><div class="row between"><div>${room.theme.logo ? logoHTML(room.theme.logo) : ''}<div class="eyebrow">${esc(room.theme.title)}</div><h2>${esc(room.title)}</h2></div><span class="pill">${room.open ? 'Buzzers open' : 'Buzzers closed'}</span></div>${room.question ? questionHTML(room.question, room) : boardHTML(b, room.used)}${scoreHTML(room)}<div class="row">${room.queue.length ? 'First to buzz: ' + esc(room.queue[0]) : ''}</div></main>`;
    hydrate();
    return;
  }
  const t = room.teams.find((t) => t.id === room.teamId),
    queued = room.queue.includes(t?.name),
    can = room.open && !room.paused && !queued;
  root.innerHTML = `<main class="phone"><div style="padding:20px">${room.theme.logo ? logoHTML(room.theme.logo) : ''}<div class="eyebrow">${esc(room.theme.title)}</div><span class="pill" id="guestconnection">Connected</span><h1 style="font-size:42px;margin:28px 0 12px">${esc(t?.name)}</h1><div class="eyebrow">YOUR SCORE</div><div style="font:64px Georgia;color:var(--accent)">${t?.score ?? 0}</div><button class="buzz" data-a="buzz" ${can ? '' : 'disabled'}>${queued ? 'YOU’RE IN' : can ? 'BUZZ' : 'WAIT'}</button><h3>${queued ? 'Queue position ' + (room.queue.indexOf(t.name) + 1) : room.paused ? 'Quiz paused' : can ? 'Buzzers open — go for it!' : 'Waiting for the host'}</h3><p class="tiny muted">One phone. One team. Make it count.</p>${scoreHTML(room)}</div></main>`;
  hydrate();
}
async function refreshRoom() {
  if (!room || room.ended) return;
  try {
    const next = await api('room/' + room.id);
    if (next.rev !== room.rev) {
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
let liveSocket;
function startPoll() {
  clearInterval(timer);
  if (liveSocket) liveSocket.close();
  timer = setInterval(
    () => {
      if (!busy) refreshRoom();
    },
    me.local ? 3000 : 1000,
  );
  if (!me.local || !room || room.ended) return;
  liveSocket = new WebSocket(
    (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/live',
  );
  liveSocket.onopen = () =>
    liveSocket.send(JSON.stringify({ roomId: room.id, token: cred, guest: guest || stage }));
  liveSocket.onmessage = () => {
    if (!busy) refreshRoom();
  };
  liveSocket.onerror = () => {};
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
      render();
    } else if (a === 'new') {
      const title = prompt('Name your quiz deck');
      if (title) {
        const d = structuredClone(w.decks[0]);
        d.id = uuid();
        d.title = title;
        d.archived = false;
        d.boards.forEach((b) => {
          b.id = uuid();
          b.questions.forEach((q) => (q.id = uuid()));
        });
        w.decks.push(d);
        w = await api('workspace/save', { rev: w.rev, decks: w.decks });
        editing = structuredClone(d);
        view = 'edit';
        render();
      }
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
      });
      editing.boards.push(b);
      editing.bi = editing.boards.length - 1;
      slot = null;
      render();
    } else if (a === 'clearmedia') {
      currentBoard().questions.find((q) => q.id === slot).media = '';
      render();
    } else if (a === 'decktheme') {
      const use = prompt('Deck preset: night, celebration, classic; or inherit', 'inherit');
      editing.theme = me.presets[use] ? { ...me.presets[use] } : null;
      toast('Deck appearance updated — save deck');
    } else if (a === 'preset') {
      w.brand = { ...w.brand, ...me.presets[el.dataset.key] };
      render();
    } else if (a === 'clearasset') {
      w.brand[el.dataset.key] = '';
      render();
    } else if (a === 'savetheme') {
      w = await api('workspace/save', { rev: w.rev, brand: w.brand });
      toast('Household theme saved');
      render();
    } else if (a === 'cohost') {
      w = await api('workspace/save', { rev: w.rev, cohost: $('#cohost').value });
      toast('Co-host permissions saved');
    } else if (a === 'start') {
      room = await api('room/create', { deck: el.dataset.id });
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
    } else if (a === 'export') {
      download(editing.title + '.json', { schema: 1, deck: editing });
    } else if (a === 'backup') {
      const keys = new Set(
        [
          w.brand.logo,
          w.brand.background,
          ...w.decks.flatMap((d) => [
            d.theme?.logo,
            d.theme?.background,
            ...d.boards.flatMap((b) => b.questions.map((q) => q.media)),
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
    } else if (a === 'restore' || a === 'import') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async () => {
        try {
          const v = JSON.parse(await input.files[0].text());
          if (a === 'restore') {
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
          } else {
            const d = v.deck;
            d.id = uuid();
            w.decks.push(d);
            w = await api('workspace/save', { rev: w.rev, decks: w.decks });
          }
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
      render();
    }
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
  }
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (el) action(el.dataset.a, el);
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.theme) {
    w.brand[el.dataset.theme] = ['radius', 'overlay'].includes(el.dataset.theme)
      ? Number(el.value)
      : el.value;
    applyTheme(w.brand);
  }
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
      if (el.dataset.upload === 'question') {
        const q = currentBoard().questions.find((q) => q.id === slot);
        q.media = r.key;
        q.type = f.type.split('/')[0];
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
      if (me.host) w = await api('workspace');
      render();
    }
  } catch (e) {
    $('#app').innerHTML =
      `<main class="login"><div class="eyebrow">THE QUIZ ROOM</div><h1>${e.status === 410 ? 'That’s a wrap.' : 'A moment, please.'}</h1><p>${esc(e.message)}</p><a class="button" href="/">Return home</a></main>`;
  }
}
window.addEventListener('hashchange', () => location.reload());
boot();
