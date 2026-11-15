import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { FileBucket } from '../server/file-bucket.js';
import { columns, deckFromCSV, deckToCSV, parseCSV, stringifyCSV } from '../shared/deck-csv.js';
import { seed } from '../shared/seed.js';

test('CSV preserves quoted answers, board positions and media paths', () => {
  const row = Object.fromEntries(columns.map((name) => [name, '']));
  Object.assign(row, {
    'Deck Title': 'Friends',
    'Board Number': '1',
    'Board Name': 'Round 1',
    'Category Number': '1',
    'Category Name': 'Sounds',
    'Question Number': '1',
    Points: '10',
    Question: 'Name this song, if you can.',
    Answer: 'A "quoted" answer\nwith a second line',
    'Question Media': 'media/song.mp3',
    'Answer Media': 'media/cover.png',
    'Buzzer Sound': 'media/buzz.wav',
    'Category Icon': '♫',
  });
  const source = stringifyCSV([columns, columns.map((name) => row[name])]);
  const deck = deckFromCSV(source);
  assert.equal(deck.boards[0].questions[0].answer, row.Answer);
  assert.equal(deck.boards[0].questions[0].media, 'media/song.mp3');
  assert.equal(deck.buzzerMedia, 'media/buzz.wav');
  assert.equal(parseCSV(deckToCSV(deck))[1][8], row.Answer);
  assert.throws(
    () =>
      deckFromCSV(
        stringifyCSV([columns, columns.map((name) => row[name]), columns.map((name) => row[name])]),
      ),
    /Duplicate question slot/,
  );
});

test('CSV import and export copy every referenced media file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'quiz-csv-'));
  try {
    const dataDirectory = path.join(root, 'data');
    const bundle = path.join(root, 'bundle');
    await mkdir(path.join(bundle, 'media'), { recursive: true });
    const bucket = new FileBucket(path.join(dataDirectory, 'objects'));
    await bucket.put('workspace', JSON.stringify(seed()));
    const source = await readFile(
      new URL('../examples/quiz-template.csv', import.meta.url),
      'utf8',
    );
    const values = parseCSV(source);
    const media = {
      'Question Media': 'media/question.png',
      'Answer Media': 'media/answer.png',
      'Buzzer Sound': 'media/buzz.wav',
      Logo: 'media/logo.png',
      Background: 'media/background.png',
    };
    for (const [name, relative] of Object.entries(media)) {
      values[1][columns.indexOf(name)] = relative;
      values[2][columns.indexOf(name)] = relative;
      await writeFile(path.join(bundle, relative), Buffer.from(relative));
    }
    await writeFile(path.join(bundle, 'questions.csv'), stringifyCSV(values));
    const env = { ...process.env, QUIZ_DATA_DIR: dataDirectory };
    execFileSync(
      process.execPath,
      ['scripts/deck-csv.mjs', 'import', path.join(bundle, 'questions.csv')],
      { env },
    );
    const workspace = JSON.parse(await (await bucket.get('workspace')).text());
    const deck = workspace.decks.at(-1);
    assert.equal(deck.boards[0].questions[0].type, 'image');
    assert.equal(deck.boards[0].questions[0].answerType, 'image');
    assert.equal(
      (await bucket.get('asset/' + deck.buzzerMedia)).httpMetadata.contentType,
      'audio/wav',
    );
    const output = path.join(root, 'output');
    execFileSync(process.execPath, ['scripts/deck-csv.mjs', 'export', output, deck.title], { env });
    const exported = deckFromCSV(await readFile(path.join(output, 'questions.csv'), 'utf8'));
    assert.equal(exported.boards[0].questions.length, 2);
    for (const relative of [
      exported.buzzerMedia,
      exported.theme.logo,
      exported.theme.background,
      exported.boards[0].questions[0].media,
      exported.boards[0].questions[0].answerMedia,
    ])
      assert((await readFile(path.join(output, relative))).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CSV import rejects media symlinks outside the selected folder', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'quiz-csv-link-'));
  try {
    const bundle = path.join(root, 'bundle');
    const dataDirectory = path.join(root, 'data');
    await mkdir(path.join(bundle, 'media'), { recursive: true });
    await new FileBucket(path.join(dataDirectory, 'objects')).put(
      'workspace',
      JSON.stringify(seed()),
    );
    const outside = path.join(root, 'outside.png');
    await writeFile(outside, 'outside');
    await symlink(outside, path.join(bundle, 'media', 'question.png'));
    const values = parseCSV(
      await readFile(new URL('../examples/quiz-template.csv', import.meta.url), 'utf8'),
    );
    values[1][columns.indexOf('Question Media')] = 'media/question.png';
    await writeFile(path.join(bundle, 'questions.csv'), stringifyCSV(values));
    const result = spawnSync(
      process.execPath,
      ['scripts/deck-csv.mjs', 'import', path.join(bundle, 'questions.csv')],
      { env: { ...process.env, QUIZ_DATA_DIR: dataDirectory }, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Media path escapes CSV folder/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
