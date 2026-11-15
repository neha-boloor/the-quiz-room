import { fail } from './errors.js';
export function alive(r) {
  if (r.ended || Date.now() > r.expires)
    fail('This quiz has ended. Ask your host for a new invitation.', 410);
}
export function auth(r, t) {
  alive(r);
  if (!t) fail('Session access required', 403);
  if (t === r.stage) return { role: 'stage' };
  const team = r.teams.find((x) => x.token === t);
  if (!team) fail('Session access required', 403);
  return { role: 'team', team };
}
export function publicRoom(r, a) {
  const q = r.deck.boards.flatMap((b) => b.questions).find((q) => q.id === r.current);
  const readyTeams = r.readyTeams || [];
  return {
    id: r.id,
    rev: r.rev,
    title: r.title,
    theme: r.theme,
    buzzerMedia: r.deck.buzzerMedia || '',
    ended: r.ended,
    expires: r.expires,
    open: r.open,
    arming: !!r.arming,
    ready: a.role === 'team' && readyTeams.includes(a.team.id),
    readyCount: readyTeams.length,
    teamCount: r.teams.filter((team) => team.token).length,
    releaseAt: r.releaseAt || 0,
    serverNow: Date.now(),
    paused: r.paused,
    locked: r.locked,
    scoreboard: !!r.scoreboard,
    winnerReveal: !!r.winnerReveal,
    buzzerCheck: !!r.buzzerCheck,
    stageView: a.role === 'stage' ? r.stageView || 'board' : 'board',
    join: a.role === 'stage' ? r.join : '',
    epoch: r.epoch,
    attempted: r.attempts || [],
    queue: r.queue.map((t) => r.teams.find((x) => x.id === t)?.name).filter(Boolean),
    teams: (a.role === 'team' ? [a.team] : r.teams).map(({ id, name, score }) => ({
      id,
      name,
      score,
    })),
    teamId: a.team?.id,
    board: r.board,
    boards: r.deck.boards.map((b) => ({
      title: b.title,
      categories: b.categories,
      rows: b.rows,
      questions: b.questions.map((q) => ({ id: q.id, col: q.col, row: q.row, points: q.points })),
    })),
    used: r.used,
    current: r.current,
    question:
      a.role === 'stage' && q && !r.arming
        ? {
            prompt: q.prompt,
            type: q.type,
            media: q.media,
            hint: r.hint ? q.hint : '',
            answer: r.reveal ? q.answer : '',
            answerType: r.reveal ? q.answerType : '',
            answerMedia: r.reveal ? q.answerMedia : '',
          }
        : null,
  };
}
export function assetAllowed(r, key, a) {
  if ([r.theme.logo, r.theme.background].includes(key)) return true;
  if (key && r.deck.buzzerMedia === key && a.role === 'team') return true;
  if (a.role !== 'stage') return false;
  const q = r.deck.boards.flatMap((b) => b.questions).find((q) => q.id === r.current);
  return q?.media === key || (r.reveal && q?.answerMedia === key);
}
