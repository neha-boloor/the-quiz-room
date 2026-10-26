import { fail } from './errors.js';
export function theme(t) {
  const clean = {};
  for (const k of ['name', 'title', 'tagline', 'logo', 'background', 'font'])
    if (typeof t[k] === 'string' && t[k].length < 200) clean[k] = t[k];
  for (const k of ['accent', 'bg', 'surface', 'text'])
    if (/^#[0-9a-f]{6}$/i.test(t[k])) clean[k] = t[k];
  clean.radius = Math.max(0, Math.min(32, Number(t.radius) || 0));
  clean.overlay = Math.max(0, Math.min(95, Number(t.overlay) || 0));
  return clean;
}
export function validateDeck(d) {
  if (
    !d ||
    typeof d.title !== 'string' ||
    !d.title.trim() ||
    d.title.length > 150 ||
    !Array.isArray(d.boards) ||
    !d.boards.length ||
    d.boards.length > 10
  )
    fail('Invalid deck');
  for (const b of d.boards) {
    if (
      !Array.isArray(b.categories) ||
      b.categories.length < 1 ||
      b.categories.length > 8 ||
      !b.categories.every((c) => typeof c === 'string' && c.length < 100) ||
      !Array.isArray(b.rows) ||
      !b.rows.length ||
      b.rows.length > 6 ||
      !b.rows.every((x) => Number.isFinite(x) && x >= 0 && x <= 10000) ||
      !Array.isArray(b.questions) ||
      b.questions.length > 48
    )
      fail('Invalid board');
    for (const q of b.questions) {
      if (
        !Number.isInteger(q.col) ||
        q.col < 0 ||
        q.col >= b.categories.length ||
        !Number.isInteger(q.row) ||
        q.row < 0 ||
        q.row >= b.rows.length ||
        !Number.isFinite(q.points) ||
        q.points < 0 ||
        q.points > 10000
      )
        fail('Invalid question position/points');
      for (const k of ['prompt', 'answer', 'hint', 'notes', 'media'])
        if (typeof (q[k] ?? '') !== 'string' || (q[k] ?? '').length > 8000)
          fail('Invalid question');
    }
    if (new Set(b.questions.map((q) => q.col + ':' + q.row)).size !== b.questions.length)
      fail('Duplicate question slot');
  }
  return d;
}
