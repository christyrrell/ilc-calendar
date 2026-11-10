// Standalone server for self-hosting (e.g. Mac Mini behind a Cloudflare Tunnel).
//   PORT=8787 node server.js
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { calendarResponse, calendarsResponse, send } from './lib/handlers.js';

const port = Number(process.env.PORT || 8787);
const indexHtml = readFileSync(new URL('./public/index.html', import.meta.url));

http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, { status: 405, headers: { Allow: 'GET, HEAD' }, body: '' });
    if (path === '/' || path === '/index.html') {
      return send(res, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, body: indexHtml });
    }
    if (path === '/calendar.ics') return send(res, await calendarResponse(req.url));
    if (path === '/calendars.json') return send(res, await calendarsResponse());
    if (path === '/healthz') return send(res, { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'ok\n' });
    send(res, { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'not found\n' });
  } catch (err) {
    console.error(err);
    send(res, { status: 500, headers: { 'Content-Type': 'text/plain' }, body: 'error\n' });
  }
}).listen(port, () => console.log(`ilc-calendar listening on http://localhost:${port}`));
