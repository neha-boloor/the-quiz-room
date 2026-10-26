import path from 'node:path';
import { initializeHost } from '../server/auth.js';
const result = await initializeHost(path.resolve(process.env.QUIZ_DATA_DIR || '.quiz-data'), {
  password: process.env.QUIZ_HOST_PASSWORD,
  reset: process.argv.includes('--reset'),
});
console.log(
  result.accessCode
    ? `Host access code: ${result.accessCode}\nKeep this private. It is for both hosts, not team phones.`
    : 'Host access already configured. Use --reset while the server is stopped to create a new code.',
);
