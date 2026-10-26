import fs from 'node:fs/promises';
import { build } from 'esbuild';

await fs.mkdir('.build', { recursive: true });
await fs.mkdir('dist/server', { recursive: true });
await fs.mkdir('dist/.openai', { recursive: true });
const [template, styles, qr, application] = await Promise.all([
  fs.readFile('client/index.html', 'utf8'),
  fs.readFile('client/styles.css', 'utf8'),
  fs.readFile('node_modules/qrcode-generator/qrcode.js', 'utf8'),
  fs.readFile('client/app.js', 'utf8'),
]);
// Function replacements preserve literal $ sequences in source code.
const html = template
  .replace('/*APP_STYLES*/', () => styles)
  .replace('/*QR_LIBRARY*/', () => qr.replaceAll('</script', '<\\/script'))
  .replace('/*APP_SCRIPT*/', () => application.replaceAll('</script', '<\\/script'));
await fs.writeFile('.build/app.html', html);
await build({
  entryPoints: ['worker/index.js'],
  outfile: 'dist/server/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  loader: { '.html': 'text' },
});
try {
  await fs.copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await fs.writeFile('dist/.openai/hosting.json', JSON.stringify({ d1: null, r2: 'BUCKET' }));
}
console.log('Built shared local / Sites application');
