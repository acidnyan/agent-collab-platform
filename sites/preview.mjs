import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const policy = Object.fromEntries((await readFile(path.join(directory, '_headers'), 'utf8')).split('\n').slice(1).filter((line) => line.trim()).map((line) => {
  const colon = line.indexOf(':'); return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
}));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
for (const [target, port] of [['site', 4173], ['invite', 4174]]) {
  const root = path.join(directory, 'dist', target);
  const server = createServer(async (req, res) => {
    // No request logging. This server never inspects query values or fragments.
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = path.resolve(root, '.' + pathname);
      if (!file.startsWith(root + path.sep) && file !== root) throw new Error('OUTSIDE_ROOT');
      if (pathname.endsWith('/') || !path.extname(file)) file = path.join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { ...policy, 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { ...policy, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`${target}: http://127.0.0.1:${port}${target === 'invite' ? '/i' : '/'}`));
  const close = () => server.close();
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
