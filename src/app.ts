import { Hono } from 'hono';
import { routePath } from 'hono/route';
import { links, api, wantsJson } from './api/routes.ts';
import { auth } from './auth.ts';
import { RoomError } from './core/errors.ts';
import { mcpHandler } from './mcp/server.ts';
import { web } from './web/routes.ts';

export const app = new Hono({ strict: false });

// Logs route patterns and status codes only. Raw paths carry claim and watch codes.
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  if (process.env.QUIET_LOGS !== 'true') {
    console.log(`${c.req.method} ${routePath(c, -1) || '*'} ${c.res.status} ${Date.now() - start}ms`);
  }
});

app.use('*', async (c, next) => {
  await next();
  // Plain-text replies end with a newline so terminals print them cleanly.
  if ((c.res.headers.get('content-type') ?? '').startsWith('text/plain') && c.res.body) {
    const body = await c.res.text();
    c.res = new Response(body.endsWith('\n') ? body : `${body}\n`, c.res);
  }
  c.res.headers.set('x-content-type-options', 'nosniff');
  c.res.headers.set('referrer-policy', 'no-referrer');
  if ((c.res.headers.get('content-type') ?? '').startsWith('text/html')) {
    c.res.headers.set('x-frame-options', 'DENY');
    c.res.headers.set('cache-control', 'no-store');
  }
});

app.get('/healthz', (c) => c.text('ok'));
app.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));
app.all('/mcp', (c) => mcpHandler.fetch(c.req.raw));
app.route('/api', api);
app.route('/', links);
app.route('/', web);

app.notFound((c) => c.text('Not found.', 404));

app.onError((error, c) => {
  if (error instanceof RoomError) {
    return wantsJson(c) ? c.json({ error: error.code, message: error.message }, error.status) : c.text(error.message, error.status);
  }
  console.error('error', routePath(c, -1), error instanceof Error ? error.message : error);
  return c.text('Something went wrong.', 500);
});
