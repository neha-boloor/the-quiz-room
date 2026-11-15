import { validateDeck } from './validation.js';

export const columns = [
  'Deck Title',
  'Board Number',
  'Board Name',
  'Category Number',
  'Category Name',
  'Question Number',
  'Points',
  'Question',
  'Answer',
  'Hint',
  'Host Notes',
  'Question Media',
  'Answer Media',
  'Buzzer Sound',
  'Logo',
  'Background',
  'Category Icon',
  'Category Description',
];

export function parseCSV(source) {
  const rows = [];
  let row = [],
    cell = '',
    quoted = false;
  const input = source.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') {
      if (cell) throw Error('Invalid CSV quote');
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (quoted) throw Error('Unclosed CSV quote');
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function stringifyCSV(rows) {
  return (
    rows
      .map((row) =>
        row
          .map((value) => {
            const text = String(value ?? '');
            return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
          })
          .join(','),
      )
      .join('\r\n') + '\r\n'
  );
}

const positive = (value, name, max) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw Error(`${name} must be 1–${max}`);
  return n;
};

export function deckFromCSV(source) {
  const [header, ...records] = parseCSV(source);
  if (!header || !records.length) throw Error('CSV needs a header and at least one question');
  for (const name of columns) if (!header.includes(name)) throw Error(`Missing column: ${name}`);
  if (new Set(header).size !== header.length) throw Error('Duplicate CSV header');
  const rows = records.map((values, index) => {
    if (values.length !== header.length)
      throw Error(`CSV row ${index + 2} has the wrong number of cells`);
    return Object.fromEntries(header.map((name, i) => [name, values[i].trim()]));
  });
  const title = rows[0]['Deck Title'];
  if (!title || rows.some((r) => r['Deck Title'] !== title))
    throw Error('Use one deck title per CSV');
  const boards = new Map(),
    slots = new Set();
  for (const r of rows) {
    const bn = positive(r['Board Number'], 'Board Number', 10);
    const cn = positive(r['Category Number'], 'Category Number', 8);
    const qn = positive(r['Question Number'], 'Question Number', 6);
    const points = Number(r.Points);
    if (!Number.isFinite(points) || points < 0 || points > 10000)
      throw Error('Points must be 0–10000');
    if (!r['Board Name'] || !r['Category Name'] || !r.Question || !r.Answer)
      throw Error('Board Name, Category Name, Question and Answer are required');
    const slot = `${bn}:${cn}:${qn}`;
    if (slots.has(slot)) throw Error(`Duplicate question slot ${slot}`);
    slots.add(slot);
    if (!boards.has(bn))
      boards.set(bn, {
        title: r['Board Name'],
        categories: new Map(),
        rows: new Map(),
        questions: [],
      });
    const board = boards.get(bn);
    if (board.title !== r['Board Name']) throw Error(`Conflicting name for board ${bn}`);
    const category = board.categories.get(cn);
    const guide = [r['Category Name'], r['Category Icon'], r['Category Description']];
    if (category && category.some((value, i) => value !== guide[i]))
      throw Error(`Conflicting category ${bn}:${cn}`);
    board.categories.set(cn, guide);
    if (board.rows.has(qn) && board.rows.get(qn) !== points)
      throw Error(`Conflicting points for row ${bn}:${qn}`);
    board.rows.set(qn, points);
    board.questions.push({
      id: crypto.randomUUID(),
      col: cn - 1,
      row: qn - 1,
      points,
      prompt: r.Question,
      answer: r.Answer,
      hint: r.Hint,
      notes: r['Host Notes'],
      type: r['Question Media'] ? 'image' : 'text',
      media: r['Question Media'],
      answerType: r['Answer Media'] ? 'image' : 'text',
      answerMedia: r['Answer Media'],
    });
  }
  const ordered = [...boards].sort(([a], [b]) => a - b);
  if (ordered.some(([number], index) => number !== index + 1))
    throw Error('Board numbers must be consecutive from 1');
  const deck = {
    id: crypto.randomUUID(),
    rev: 0,
    title,
    group: 'Friends',
    description: '',
    archived: false,
    theme: null,
    buzzerMedia: rows[0]['Buzzer Sound'],
    boards: ordered.map(([, board]) => {
      const cats = [...board.categories].sort(([a], [b]) => a - b);
      const values = [...board.rows].sort(([a], [b]) => a - b);
      if (cats.some(([n], i) => n !== i + 1) || values.some(([n], i) => n !== i + 1))
        throw Error('Category and question numbers must be consecutive from 1');
      return {
        id: crypto.randomUUID(),
        title: board.title,
        categories: cats.map(([, c]) => c[0]),
        categoryIcons: cats.map(([, c]) => c[1]),
        categoryDescriptions: cats.map(([, c]) => c[2]),
        rows: values.map(([, points]) => points),
        questions: board.questions,
      };
    }),
  };
  for (const field of ['Buzzer Sound', 'Logo', 'Background'])
    if (rows.some((r) => r[field] !== rows[0][field])) throw Error(`Use one ${field} per deck`);
  if (rows[0].Logo || rows[0].Background)
    deck.theme = { logo: rows[0].Logo, background: rows[0].Background };
  return validateDeck(deck);
}

export function deckToCSV(deck, mediaPath = (key) => key) {
  const rows = [columns];
  deck.boards.forEach((board, bi) =>
    board.questions.forEach((q) => {
      const values = [
        deck.title,
        bi + 1,
        board.title,
        q.col + 1,
        board.categories[q.col],
        q.row + 1,
        q.points,
        q.prompt,
        q.answer,
        q.hint,
        q.notes,
        mediaPath(q.media),
        mediaPath(q.answerMedia),
        mediaPath(deck.buzzerMedia),
        mediaPath(deck.theme?.logo),
        mediaPath(deck.theme?.background),
        board.categoryIcons?.[q.col],
        board.categoryDescriptions?.[q.col],
      ];
      rows.push(values);
    }),
  );
  return stringifyCSV(rows);
}

export function deckMediaRefs(deck) {
  const result = [];
  const add = (owner, field, kind) => {
    if (owner?.[field]) result.push({ owner, field, kind });
  };
  add(deck, 'buzzerMedia', 'audio');
  add(deck.theme, 'logo', 'image');
  add(deck.theme, 'background', 'image');
  for (const board of deck.boards)
    for (const question of board.questions) {
      add(question, 'media', 'any');
      add(question, 'answerMedia', 'any');
    }
  return result;
}
