// Core: fetch events from a ChurchTrac public calendar and render RFC 5545 iCalendar.
// Zero dependencies; runs on Node 18+ (global fetch, Intl).

export const config = {
  churchUi: process.env.CHURCHTRAC_UI || 'F05D55DF',
  tz: process.env.CAL_TZ || 'America/Chicago',
  calName: process.env.CAL_NAME || 'Immanuel Lutheran Church',
  calDesc: process.env.CAL_DESC || 'Events from the Immanuel Lutheran Church (Waukee) ChurchTrac calendar',
  upstreamBase: 'https://www.churchtrac.com',
  pastDays: 30,
  futureDays: 400,
  cacheTtlMs: 60 * 60 * 1000,          // refetch upstream at most hourly
  maxStaleMs: 7 * 24 * 60 * 60 * 1000, // serve last good copy for up to a week if upstream is down
};

// ---------- upstream ----------

export function upstreamUrl(cfg, start, end) {
  const q = new URLSearchParams({ source: 'public', church_ui: cfg.churchUi, calendar: '0', start, end });
  return `${cfg.upstreamBase}/calendar_events?${q}`;
}

export async function fetchEvents(cfg, start, end, fetchImpl = fetch) {
  const res = await fetchImpl(upstreamUrl(cfg, start, end), {
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'ILC-Calendar-Feed/1.0 (ics subscription bridge)',
      // ChurchTrac's front end 403s Node fetch's default `Accept-Language: *` (and curl's default UA).
      // Verified 2026-11-10: same request with a concrete language returns 200.
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('upstream returned non-JSON'); }
  if (!Array.isArray(data)) throw new Error('upstream JSON is not an array');
  // A 13+ month window with zero events is almost certainly an upstream fault, not reality.
  // Treat it as failure so subscribers' calendars are never wiped.
  if (data.length === 0) throw new Error('upstream returned zero events');
  return data;
}

const cache = { data: null, fetchedAt: 0 };

export function dateWindow(now, cfg) {
  const day = 86_400_000;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  return { start: iso(now.getTime() - cfg.pastDays * day), end: iso(now.getTime() + cfg.futureDays * day) };
}

export async function getEvents(cfg = config, now = new Date(), fetchImpl = fetch) {
  const age = now.getTime() - cache.fetchedAt;
  if (cache.data && age < cfg.cacheTtlMs) return { events: cache.data, stale: false };
  const { start, end } = dateWindow(now, cfg);
  try {
    const data = await fetchEvents(cfg, start, end, fetchImpl);
    cache.data = data;
    cache.fetchedAt = now.getTime();
    return { events: data, stale: false };
  } catch (err) {
    if (cache.data && age < cfg.maxStaleMs) {
      console.warn(`[ilc-calendar] upstream failed (${err.message}); serving cached copy aged ${Math.round(age / 60000)} min`);
      return { events: cache.data, stale: true };
    }
    throw err;
  }
}

export function _resetCache() { cache.data = null; cache.fetchedAt = 0; }

// ---------- text helpers ----------

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, ent) => {
      if (ent[0] === '#') {
        const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return NAMED[ent.toLowerCase()] ?? m;
    })
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

export function slugify(s) {
  return decodeHtml(s).toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function escapeText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Fold to 75 octets per RFC 5545 §3.1 without splitting UTF-8 sequences.
export function foldLine(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = '';
      curBytes = 0;
      limit = 74; // continuation lines start with a space
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// ---------- time helpers ----------

function tzOffsetMs(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - date.getTime();
}

// Convert a wall-clock date/time in `tz` to a UTC Date (DST-aware).
export function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [H = 0, M = 0, S = 0] = (timeStr || '00:00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, H, M, S);
  const off1 = tzOffsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

const fmtUtc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const fmtDate = (s) => s.replace(/-/g, '');

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ---------- rendering ----------

export function listCalendars(events) {
  const map = new Map();
  for (const e of events) {
    const name = decodeHtml(e.calendar);
    if (!name) continue;
    const slug = slugify(name);
    const entry = map.get(slug) || { slug, name, count: 0 };
    entry.count++;
    map.set(slug, entry);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function filterEvents(events, slugs) {
  if (!slugs || slugs.length === 0) return events;
  const want = new Set(slugs);
  return events.filter((e) => want.has(slugify(e.calendar)));
}

export function buildIcs(events, { cfg = config, now = new Date(), calName } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ILC Calendar//ChurchTrac ICS Bridge//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calName || cfg.calName)}`,
    `X-WR-CALDESC:${escapeText(cfg.calDesc)}`,
    `X-WR-TIMEZONE:${cfg.tz}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  const dtstamp = fmtUtc(now);

  // Deterministic order so UID collision suffixes are stable between fetches.
  const sorted = [...events].sort((a, b) =>
    String(a.start).localeCompare(String(b.start)) || String(a.UID).localeCompare(String(b.UID)));
  const seen = new Map();

  for (const e of sorted) {
    if (!e || !e.start_date) continue;
    const title = decodeHtml(e.title) || '(untitled)';
    const location = decodeHtml(e.location);
    const notes = decodeHtml(e.notes);
    const category = decodeHtml(e.calendar);

    // ChurchTrac gives every instance of a recurring series the same UID.
    // Make one per instance, keyed on the date (not time) so a time change updates in place.
    const base = String(e.UID || `id${e.id}`).split('@')[0];
    let uid = `${base}-${fmtDate(e.start_date)}`;
    const n = (seen.get(uid) || 0) + 1;
    seen.set(uid, n);
    if (n > 1) uid += `-${n}`;

    lines.push('BEGIN:VEVENT', `UID:${uid}@ilc-calendar`, `DTSTAMP:${dtstamp}`);

    if (e.allDay) {
      // ChurchTrac all-day end dates are inclusive; iCal DTEND is exclusive.
      const endIncl = e.end_date && e.end_date >= e.start_date ? e.end_date : e.start_date;
      lines.push(`DTSTART;VALUE=DATE:${fmtDate(e.start_date)}`, `DTEND;VALUE=DATE:${fmtDate(addDays(endIncl, 1))}`);
    } else {
      const start = zonedToUtc(e.start_date, e.start_time, cfg.tz);
      let end = e.end_time ? zonedToUtc(e.end_date || e.start_date, e.end_time, cfg.tz) : null;
      if (!end || end <= start) end = new Date(start.getTime() + 60 * 60 * 1000);
      lines.push(`DTSTART:${fmtUtc(start)}`, `DTEND:${fmtUtc(end)}`);
    }

    lines.push(`SUMMARY:${escapeText(title)}`);
    if (location) lines.push(`LOCATION:${escapeText(location)}`);
    if (notes && notes !== title) lines.push(`DESCRIPTION:${escapeText(notes)}`);
    if (category) lines.push(`CATEGORIES:${escapeText(category)}`);
    if (e.link && /^https?:\/\//i.test(e.link)) lines.push(`URL:${e.link}`);
    // Subscribing to the church calendar shouldn't mark the subscriber as busy.
    lines.push('TRANSP:TRANSPARENT', 'STATUS:CONFIRMED', 'END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
