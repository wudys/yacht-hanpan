import path from 'node:path';

const staticRoot = process.env.STATIC_ROOT;
if (!staticRoot) throw new Error('STATIC_ROOT is required');

const root = path.resolve(process.cwd(), staticRoot);
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1) throw new Error('PORT must be a positive integer');

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request: Request) {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      return new Response('not found', { status: 404 });
    }
    const file = Bun.file(absolute);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(path.join(root, 'index.html')));
  },
});

console.log(`static SPA listening on ${server.url}`);
