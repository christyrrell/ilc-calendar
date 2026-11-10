// Host-agnostic request handlers. Each returns { status, headers, body }.
// The landing page is static (public/index.html); these serve only data.
import { config, getEvents, buildIcs, filterEvents, listCalendars } from './ics.js';

// CDN: fresh for 1h, then refreshed in the background. If the function errors (503 below),
// Vercel's CDN keeps serving the last good copy for up to 7 days (stale-if-error).
const ICS_CACHE = 'public, max-age=900, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=604800';

function parseSlugs(searchParams) {
  const raw = searchParams.getAll('cal').join(',');
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function unavailable(err, contentType, body) {
  console.error(`[ilc-calendar] feed unavailable: ${err.message}`);
  return {
    status: 503,
    headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Retry-After': '900' },
    body,
  };
}

export async function calendarResponse(url, deps = {}) {
  const u = new URL(url, 'http://localhost');
  const slugs = parseSlugs(u.searchParams);
  const cfg = deps.cfg || config;
  try {
    const { events, stale } = await getEvents(cfg, deps.now || new Date(), deps.fetchImpl || fetch);
    const chosen = filterEvents(events, slugs);
    // A category filter that matches nothing (typo, or the church renamed/removed the category)
    // must not produce an empty 200: that would erase the events from subscribers' calendars.
    if (slugs.length && chosen.length === 0) {
      return {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        body: 'No events found for the requested calendar category. See the subscription page for current categories.\n',
      };
    }
    const names = slugs.length ? listCalendars(chosen).map((c) => c.name) : [];
    const calName = names.length ? `${cfg.calName}: ${names.join(', ')}` : undefined;
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="ilc-calendar.ics"',
        'Cache-Control': stale ? 'public, max-age=300, s-maxage=300' : ICS_CACHE,
      },
      body: buildIcs(chosen, { cfg, calName, now: deps.now }),
    };
  } catch (err) {
    // Never return an empty 200: subscribers would lose every event. A 503 makes clients keep their copy.
    return unavailable(err, 'text/plain; charset=utf-8',
      'Church calendar source is temporarily unavailable. Your calendar app will retry.\n');
  }
}

// Metadata for the landing page: calendar name, source link, and category list.
export async function calendarsResponse(deps = {}) {
  const cfg = deps.cfg || config;
  try {
    const { events, stale } = await getEvents(cfg, deps.now || new Date(), deps.fetchImpl || fetch);
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': stale ? 'public, max-age=300, s-maxage=300' : ICS_CACHE,
      },
      body: JSON.stringify({
        name: cfg.calName,
        source: `${cfg.upstreamBase}/public_calendar?ui=${encodeURIComponent(cfg.churchUi)}`,
        calendars: listCalendars(events),
      }),
    };
  } catch (err) {
    return unavailable(err, 'application/json; charset=utf-8', JSON.stringify({ error: 'source unavailable' }));
  }
}

// Adapter for Node's (req, res) — used by both server.js and Vercel Node functions.
export function send(res, { status, headers, body }) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body);
}
