import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildIcs, zonedToUtc, decodeHtml, slugify, foldLine, escapeText,
  filterEvents, listCalendars, getEvents, _resetCache, config,
} from '../lib/ics.js';
import { calendarResponse, calendarsResponse } from '../lib/handlers.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/events.json', import.meta.url)));
const NOW = new Date('2026-11-10T17:00:00Z');
const unfold = (s) => s.replace(/\r\n /g, '');
const vevents = (ics) => unfold(ics).split('BEGIN:VEVENT').slice(1);
const find = (ics, summary) => vevents(ics).find((v) => v.includes(`SUMMARY:${summary}\r\n`));

beforeEach(() => _resetCache());

test('DST-aware conversion for America/Chicago', () => {
  // CDT (UTC-5)
  assert.equal(zonedToUtc('2026-10-14', '19:00:00', 'America/Chicago').toISOString(), '2026-10-15T00:00:00.000Z');
  // DST ends 2026-11-01 02:00 → CST (UTC-6) for a 10:30 service that morning
  assert.equal(zonedToUtc('2026-11-01', '10:30:00', 'America/Chicago').toISOString(), '2026-11-01T16:30:00.000Z');
  // DST starts 2027-03-14 02:00 → CDT evening meeting
  assert.equal(zonedToUtc('2027-03-14', '18:30:00', 'America/Chicago').toISOString(), '2027-03-14T23:30:00.000Z');
  // Winter
  assert.equal(zonedToUtc('2026-11-29', '09:00:00', 'America/Chicago').toISOString(), '2026-11-29T15:00:00.000Z');
});

test('timed events emit UTC start/end', () => {
  const ics = buildIcs(fixture, { now: NOW });
  const v = find(ics, 'Contemporary Worship Service');
  assert.match(v, /DTSTART:20261101T163000Z\r\n/);
  assert.match(v, /DTEND:20261101T173000Z\r\n/);
});

test('all-day events: DATE values with exclusive end', () => {
  const ics = buildIcs(fixture, { now: NOW });
  const single = find(ics, 'General Election');
  assert.match(single, /DTSTART;VALUE=DATE:20261103\r\n/);
  assert.match(single, /DTEND;VALUE=DATE:20261104\r\n/);
  const multi = find(ics, 'Vacation Bible School');
  assert.match(multi, /DTSTART;VALUE=DATE:20270620\r\n/);
  assert.match(multi, /DTEND;VALUE=DATE:20270625\r\n/); // inclusive 6/24 → exclusive 6/25
});

test('recurring instances get unique, date-keyed UIDs', () => {
  const ics = buildIcs(fixture, { now: NOW });
  const uids = vevents(ics).map((v) => v.match(/UID:(.+?)\r\n/)[1]);
  assert.equal(uids.length, fixture.length);
  assert.equal(new Set(uids).size, uids.length);
  assert.ok(uids.includes('xge8c5krwpccn3b3s2rai4jceo9d7zkg-20261004@ilc-calendar'));
  assert.ok(uids.includes('xge8c5krwpccn3b3s2rai4jceo9d7zkg-20261011@ilc-calendar'));
});

test('UIDs are stable regardless of upstream ordering', () => {
  const a = buildIcs(fixture, { now: NOW });
  const b = buildIcs([...fixture].reverse(), { now: NOW });
  assert.equal(a, b);
});

test('same-day UID collisions get a suffix', () => {
  const dup = { ...fixture[0], start: '2026-11-29 11:00:00', start_time: '11:00:00', end: '2026-11-29 12:00:00', end_time: '12:00:00' };
  const ics = buildIcs([fixture[0], dup], { now: NOW });
  const uids = vevents(ics).map((v) => v.match(/UID:(.+?)\r\n/)[1]);
  assert.deepEqual(uids, ['i5xkkx0urpn5jabsolezacs0h5z687tw-20261129@ilc-calendar', 'i5xkkx0urpn5jabsolezacs0h5z687tw-20261129-2@ilc-calendar']);
});

test('HTML entities decoded and iCal text escaped', () => {
  assert.equal(decodeHtml('8th &amp; 9th &#39;x&#x27; <br>y'), "8th & 9th 'x'\ny");
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  const ics = buildIcs(fixture, { now: NOW });
  assert.match(find(ics, 'Confirmation'), /DESCRIPTION:Confirmation classes for 8th & 9th graders.\r\n/);
  assert.match(find(ics, 'Sunday School'), /LOCATION:Education Wing\\, IMAC \(Basement\)\r\n/);
  assert.match(find(ics, 'General Election'), /LOCATION:Fellowship Hall & Kitchen\r\n/);
  assert.ok(!ics.includes('&amp;'));
});

test('description omitted when it duplicates the title', () => {
  const v = find(buildIcs(fixture, { now: NOW }), 'Holiday Worship Service');
  assert.ok(!v.includes('DESCRIPTION:'));
});

test('lines are CRLF and folded to <=75 octets, UTF-8 safe', () => {
  const long = 'é'.repeat(100);
  const folded = foldLine(`DESCRIPTION:${long}`);
  for (const l of folded.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), `DESCRIPTION:${long}`);
  const ics = buildIcs(fixture, { now: NOW });
  assert.ok(!/[^\r]\n/.test(ics), 'bare LF found');
  for (const l of ics.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, l);
});

test('calendar slugs and filtering', () => {
  assert.equal(slugify('Education Classes &amp; Events'), 'education-classes-events');
  const cals = listCalendars(fixture).map((c) => c.slug);
  assert.ok(cals.includes('worship-services'));
  const only = filterEvents(fixture, ['worship-services']);
  assert.equal(only.length, 2);
});

test('structure: required properties present', () => {
  const ics = buildIcs(fixture, { now: NOW });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  for (const v of vevents(ics)) {
    for (const p of ['UID:', 'DTSTAMP:', 'DTSTART', 'DTEND', 'SUMMARY:']) assert.ok(v.includes(p), `${p} missing`);
  }
});

test('upstream request sends headers ChurchTrac requires', async () => {
  let seen;
  const spy = async (url, init) => { seen = { url, headers: init.headers }; return new Response(JSON.stringify(fixture)); };
  await getEvents(config, NOW, spy);
  assert.match(seen.url, /church_ui=F05D55DF/);
  assert.equal(seen.headers['Accept-Language'], 'en-US,en;q=0.9'); // default "*" is 403'd
  assert.match(seen.headers['User-Agent'], /^ILC-Calendar-Feed\//); // curl/node default UAs are 403'd
});

// ---- failure handling: never serve an empty 200 ----

const okFetch = async () => new Response(JSON.stringify(fixture), { status: 200 });
const badFetch = async () => new Response('oops', { status: 500 });
const emptyFetch = async () => new Response('[]', { status: 200 });

test('upstream error with no cache → 503, not an empty calendar', async () => {
  const r = await calendarResponse('/calendar.ics', { fetchImpl: badFetch, now: NOW });
  assert.equal(r.status, 503);
  assert.equal(r.headers['Cache-Control'], 'no-store');
});

test('upstream returning zero events is treated as a failure', async () => {
  const r = await calendarResponse('/calendar.ics', { fetchImpl: emptyFetch, now: NOW });
  assert.equal(r.status, 503);
});

test('upstream error after a good fetch → serve stale copy', async () => {
  await getEvents(config, NOW, okFetch);
  const later = new Date(NOW.getTime() + 2 * 3600_000);
  const r = await calendarResponse('/calendar.ics', { fetchImpl: badFetch, now: later });
  assert.equal(r.status, 200);
  assert.match(r.body, /Holiday Worship Service/);
  assert.match(r.headers['Cache-Control'], /max-age=300/);
});

test('?cal= filter with healthy upstream returns 200 with only that category', async () => {
  const r = await calendarResponse('/calendar.ics?cal=holidays,worship-services', { fetchImpl: okFetch, now: NOW });
  assert.equal(r.status, 200);
  assert.equal(vevents(r.body).length, 2);
  assert.match(r.body, /X-WR-CALNAME:Immanuel Lutheran Church: Worship Services/);
});

// ---- /calendars.json and the static landing page ----

test('calendars.json lists categories with slugs, name, and source', async () => {
  const r = await calendarsResponse({ fetchImpl: okFetch, now: NOW });
  assert.equal(r.status, 200);
  assert.match(r.headers['Content-Type'], /application\/json/);
  const data = JSON.parse(r.body);
  assert.equal(data.name, 'Immanuel Lutheran Church');
  assert.equal(data.source, 'https://www.churchtrac.com/public_calendar?ui=F05D55DF');
  const worship = data.calendars.find((c) => c.slug === 'worship-services');
  assert.deepEqual(worship, { slug: 'worship-services', name: 'Worship Services', count: 2 });
  assert.ok(data.calendars.some((c) => c.name === 'Education Classes & Events')); // entities decoded
});

test('calendars.json returns 503 JSON when upstream is down', async () => {
  const r = await calendarsResponse({ fetchImpl: badFetch, now: NOW });
  assert.equal(r.status, 503);
  assert.deepEqual(JSON.parse(r.body), { error: 'source unavailable' });
});

test('landing page is static, data-driven, and never uses innerHTML', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /fetch\('\/calendars\.json'\)/);
  assert.match(html, /href="\/calendar\.ics"/); // works without JavaScript
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html));
});
