// Host-agnostic request handlers. Each returns { status, headers, body }.
import { config, getEvents, buildIcs, filterEvents, listCalendars } from './ics.js';

const ICS_CACHE = 'public, max-age=900, s-maxage=3600, stale-while-revalidate=86400';

function parseSlugs(searchParams) {
  const raw = searchParams.getAll('cal').join(',');
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export async function calendarResponse(url, deps = {}) {
  const u = new URL(url, 'http://localhost');
  const slugs = parseSlugs(u.searchParams);
  try {
    const { events, stale } = await getEvents(deps.cfg || config, deps.now || new Date(), deps.fetchImpl || fetch);
    const chosen = filterEvents(events, slugs);
    const names = slugs.length
      ? listCalendars(chosen).map((c) => c.name)
      : [];
    const calName = names.length ? `${config.calName}: ${names.join(', ')}` : undefined;
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="ilc-calendar.ics"',
        'Cache-Control': stale ? 'public, max-age=300, s-maxage=300' : ICS_CACHE,
      },
      body: buildIcs(chosen, { calName, now: deps.now }),
    };
  } catch (err) {
    console.error(`[ilc-calendar] feed unavailable: ${err.message}`);
    // Never return an empty 200: subscribers would lose every event. A 503 makes clients keep their copy.
    return {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '900' },
      body: 'Church calendar source is temporarily unavailable. Your calendar app will retry.\n',
    };
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function homeResponse(url, host, deps = {}) {
  let calendars = [];
  try {
    const { events } = await getEvents(deps.cfg || config, new Date(), deps.fetchImpl || fetch);
    calendars = listCalendars(events);
  } catch { /* render page without the per-calendar list */ }

  const httpsAll = `https://${host}/calendar.ics`;
  const webcal = (q = '') => `webcal://${host}/calendar.ics${q}`;
  const rows = calendars.map((c) => {
    const q = `?cal=${encodeURIComponent(c.slug)}`;
    return `<li><a href="${esc(webcal(q))}">${esc(c.name)}</a> <code>https://${esc(host)}/calendar.ics${esc(q)}</code></li>`;
  }).join('\n');

  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(config.calName)} — Calendar Subscription</title>
<style>
 body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#222}
 h1{font-size:1.5rem} .btn{display:inline-block;background:#2f5d8a;color:#fff;padding:.6rem 1rem;border-radius:6px;text-decoration:none}
 code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px;font-size:.85em;word-break:break-all}
 li{margin:.4rem 0} small{color:#666}
</style></head><body>
<h1>${esc(config.calName)} calendar</h1>
<p>Subscribe once and church events stay up to date in your own calendar app.</p>
<p><a class="btn" href="${esc(webcal())}">Subscribe to all events</a></p>
<p><strong>iPhone / Mac:</strong> tap the button above.<br>
<strong>Google Calendar:</strong> on a computer, open Google Calendar → Other calendars <b>+</b> → From URL, and paste:<br><code>${esc(httpsAll)}</code><br>
<strong>Outlook:</strong> Add calendar → Subscribe from web, and paste the same address.</p>
${rows ? `<h2>Just one category</h2><ul>\n${rows}\n</ul>
<p><small>Combine categories with commas, e.g. <code>?cal=worship-services,holidays</code></small></p>` : ''}
<p><small>Google refreshes subscribed calendars on its own schedule (often every 12–24 hours); Apple and Outlook check more often.
Events come from the church's <a href="https://www.churchtrac.com/public_calendar?ui=${esc(config.churchUi)}">public ChurchTrac calendar</a>.</small></p>
</body></html>`;

  return {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300, s-maxage=3600' },
    body,
  };
}

// Adapter for Node's (req, res) — used by both server.js and Vercel Node functions.
export function send(res, { status, headers, body }) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body);
}

export function hostOf(req) {
  return req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
}
