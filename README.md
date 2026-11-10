# ILC Calendar

A subscribable iCalendar (`.ics`) feed for Immanuel Lutheran Church's
[ChurchTrac public calendar](https://www.churchtrac.com/public_calendar?ui=F05D55DF),
which has no subscribe option of its own.

## How it works

ChurchTrac's public calendar page loads its events from a JSON endpoint:

```
GET https://www.churchtrac.com/calendar_events?source=public&church_ui=F05D55DF&calendar=0&start=YYYY-MM-DD&end=YYYY-MM-DD
```

This service fetches the window from 30 days ago to ~13 months ahead, converts it to
RFC 5545 iCalendar, and serves it at `/calendar.ics`. No dependencies.

Upstream quirks it handles (observed 2026-11-10):

| Quirk | Handling |
|---|---|
| Every instance of a recurring series shares one `UID` | Per-instance UID `<uid>-<YYYYMMDD>`; date-keyed so a time change updates in place |
| All-day `end_date` is **inclusive** (VBS 6/20–6/24) | `DTEND;VALUE=DATE` = end + 1 day (iCal is exclusive) |
| Times are floating local wall-clock | Converted to UTC via `America/Chicago`, DST-aware |
| HTML entities in titles/notes (`&amp;`) | Decoded; `<br>` → newline; tags stripped |
| Response `Content-Type` is `text/html` | Parsed as JSON regardless |

## Safety: never wipe subscribers' calendars

If ChurchTrac fails, times out, returns non-JSON, or returns **zero** events, the feed
answers **503** (not an empty 200). Calendar apps keep their existing copy and retry.
A warm process also keeps the last good copy for up to 7 days and serves it if upstream fails.

All events are `TRANSP:TRANSPARENT` so subscribing doesn't make you look busy.

## Endpoints

| Path | Purpose |
|---|---|
| `/` | Landing page with subscribe buttons and per-category links |
| `/calendar.ics` | All events |
| `/calendar.ics?cal=worship-services,holidays` | Only selected categories (slugs listed on `/`) |
| `/healthz` | Liveness (self-hosted server only) |

## Configuration (env vars, all optional)

| Var | Default |
|---|---|
| `CHURCHTRAC_UI` | `F05D55DF` |
| `CAL_TZ` | `America/Chicago` |
| `CAL_NAME` | `Immanuel Lutheran Church` |
| `CAL_DESC` | description string |
| `PORT` | `8787` (self-hosted only) |

## Run / test

```sh
npm test          # node --test, uses test/fixtures/events.json
npm start         # http://localhost:8787
```

## Deploy

**Vercel:** `api/calendar.js` and `api/home.js` are Node functions; `vercel.json` rewrites
`/calendar.ics` and `/`. Responses carry `s-maxage=3600, stale-while-revalidate=86400`, so
ChurchTrac is hit at most about once an hour no matter how many people subscribe.

**Self-hosted (Mac Mini):** `node server.js` under launchd, exposed with a Cloudflare Tunnel
ingress rule pointing a hostname at `http://localhost:8787`.

## Subscribing

- **iPhone / Mac:** open `webcal://<host>/calendar.ics` (the button on `/`).
- **Google Calendar:** on the web, Other calendars **+** → From URL → `https://<host>/calendar.ics`.
  Google refreshes subscriptions on its own schedule (often 12–24 h).
- **Outlook:** Add calendar → Subscribe from web.
