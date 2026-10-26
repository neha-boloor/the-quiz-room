import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalApp, lanOrigin } from './app.js';
const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const portArgument = process.argv.indexOf('--port');
const port = Number(portArgument >= 0 ? process.argv[portArgument + 1] : process.env.PORT || 3000);
const app = await createLocalApp({
  dataDirectory: path.resolve(process.env.QUIZ_DATA_DIR || path.join(root, '.quiz-data')),
  password: process.env.QUIZ_HOST_PASSWORD,
  advertisedOrigin: process.env.QUIZ_PUBLIC_ORIGIN,
});
await app.listen(port, process.env.QUIZ_BIND || '0.0.0.0');
console.log(
  `Quiz app: http://localhost:${port}\nTeam phones: ${process.env.QUIZ_PUBLIC_ORIGIN || lanOrigin(port)}`,
);
if (app.accessCode)
  console.log(
    `\nNew host access code: ${app.accessCode}\nKeep it for you and your co-host. Guests only need the quiz QR.\n`,
  );
console.log('Data stays in your local .quiz-data directory. No cloud connection required.');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
