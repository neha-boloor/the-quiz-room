import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FileBucket } from '../server/file-bucket.js';
import { deckFromCSV, deckToCSV, deckMediaRefs } from '../shared/deck-csv.js';
import { validateDeck } from '../shared/validation.js';

const [command, target, ...rest] = process.argv.slice(2);
const dataDirectory = path.resolve(process.env.QUIZ_DATA_DIR || '.quiz-data');
const bucket = new FileBucket(path.join(dataDirectory, 'objects'));
const types = new Map(
  Object.entries({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
  }),
);
const extensions = new Map([...types].map(([extension, mime]) => [mime, extension]));
function safeMediaPath(base, relative) {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw Error(`Invalid media path: ${relative}`);
  const absolute = path.resolve(base, relative);
  if (!absolute.startsWith(base + path.sep))
    throw Error(`Media path escapes CSV folder: ${relative}`);
  return absolute;
}
const stored = await bucket.get('workspace');
if (!stored) throw Error('Start the app once before importing or exporting');
const workspace = JSON.parse(await stored.text());

if (command === 'import' && target) {
  const csvPath = path.resolve(target);
  const deck = deckFromCSV(await readFile(csvPath, 'utf8'));
  const base = await realpath(path.dirname(csvPath)),
    files = new Map();
  for (const ref of deckMediaRefs(deck)) {
    const relative = ref.owner[ref.field];
    const filename = safeMediaPath(base, relative);
    if (!(await realpath(filename)).startsWith(base + path.sep))
      throw Error(`Media path escapes CSV folder: ${relative}`);
    const mime = types.get(path.extname(filename).toLowerCase());
    if (!mime || (ref.kind !== 'any' && !mime.startsWith(ref.kind + '/')))
      throw Error(`Unsupported media for ${relative}`);
    if (!files.has(relative)) {
      const bytes = await readFile(filename);
      if (bytes.length > 10 * 1024 * 1024) throw Error(`Media exceeds 10 MB: ${relative}`);
      files.set(relative, { bytes, mime });
    }
  }
  const keys = new Map();
  for (const [relative, { bytes, mime }] of files) {
    const key = randomUUID();
    await bucket.put('asset/' + key, bytes, { httpMetadata: { contentType: mime } });
    keys.set(relative, key);
  }
  for (const ref of deckMediaRefs(deck)) {
    const file = ref.owner[ref.field];
    ref.owner[ref.field] = keys.get(file);
    if (ref.field === 'media' || ref.field === 'answerMedia')
      ref.owner[ref.field === 'media' ? 'type' : 'answerType'] = files.get(file).mime.split('/')[0];
  }
  validateDeck(deck);
  if (workspace.decks.length >= 60) throw Error('Workspace already has 60 decks');
  workspace.decks.push(deck);
  workspace.rev = (workspace.rev || 0) + 1;
  const written = await bucket.put('workspace', JSON.stringify(workspace), {
    onlyIf: { etagMatches: stored.etag },
  });
  if (!written) throw Error('Workspace changed during import. Retry.');
  console.log(
    `Imported "${deck.title}" with ${deck.boards.length} board(s), ${deck.boards.reduce((n, b) => n + b.questions.length, 0)} questions and ${files.size} media file(s).`,
  );
} else if (command === 'export' && target) {
  const name = rest.join(' ');
  if (!name) throw Error('Usage: npm run csv:export -- <output-directory> <deck title>');
  const deck = workspace.decks.find((item) => item.title === name);
  if (!deck) throw Error(`Deck not found: ${name}`);
  const output = path.resolve(target);
  const copy = structuredClone(deck);
  copy.theme = { ...workspace.brand, ...(copy.theme || {}) };
  const paths = new Map();
  for (const ref of deckMediaRefs(copy)) {
    const key = ref.owner[ref.field];
    if (!paths.has(key)) {
      const asset = await bucket.get('asset/' + key);
      if (!asset) throw Error(`Missing saved media: ${key}`);
      const extension = extensions.get(asset.httpMetadata?.contentType);
      if (!extension)
        throw Error(`Unsupported saved media type: ${asset.httpMetadata?.contentType}`);
      const relative = `media/asset-${String(paths.size + 1).padStart(3, '0')}${extension}`;
      paths.set(key, { relative, bytes: Buffer.from(await asset.arrayBuffer()) });
    }
  }
  await mkdir(path.join(output, 'media'), { recursive: true });
  for (const { relative, bytes } of paths.values())
    await writeFile(path.join(output, relative), bytes);
  await writeFile(
    path.join(output, 'questions.csv'),
    deckToCSV(copy, (key) => paths.get(key)?.relative || ''),
  );
  console.log(
    `Exported ${copy.boards.reduce((n, b) => n + b.questions.length, 0)} questions and ${paths.size} media file(s) to ${output}`,
  );
} else
  throw Error(
    'Usage: npm run csv:import -- <questions.csv> OR npm run csv:export -- <output-directory> <deck title>',
  );
