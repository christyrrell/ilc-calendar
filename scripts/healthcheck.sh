#!/usr/bin/env bash
# Checks that the live feed is serving real events. Exits non-zero on any problem.
#   scripts/healthcheck.sh [base-url]
set -euo pipefail
BASE="${1:-https://ilc-calendar.vercel.app}"
# A unique query string bypasses the CDN cache, so this exercises the function
# (and, when its in-memory copy is over an hour old, ChurchTrac itself).
BUST="healthcheck=$(date +%s)"
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

code=$(curl -sS -m 30 -o "$tmp" -w '%{http_code} %{content_type}' "$BASE/calendar.ics?$BUST") || fail "feed request failed"
[[ "$code" == "200 text/calendar"* ]] || fail "feed returned: $code"
grep -q '^BEGIN:VCALENDAR' "$tmp" || fail "feed is not an iCalendar file"
events=$(grep -c '^BEGIN:VEVENT' "$tmp" || true)
(( events >= 10 )) || fail "feed has only $events events"
uids=$(grep '^UID:' "$tmp" | sort -u | wc -l | tr -d ' ')
[[ "$uids" == "$events" ]] || fail "$events events but $uids unique UIDs"
# At least one event must start today or later (UTC), or the source has gone stale.
today=$(date -u +%Y%m%d)
latest=$(grep -oE '^DTSTART[^:]*:[0-9]{8}' "$tmp" | grep -oE '[0-9]{8}$' | sort | tail -1)
[[ "$latest" > "$today" || "$latest" == "$today" ]] || fail "no upcoming events (latest start $latest)"

code=$(curl -sS -m 30 -o "$tmp" -w '%{http_code}' "$BASE/calendars.json?$BUST") || fail "calendars.json request failed"
[[ "$code" == "200" ]] || fail "calendars.json returned $code"
grep -q '"slug"' "$tmp" || fail "calendars.json lists no categories"

code=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' "$BASE/") || fail "landing page request failed"
[[ "$code" == "200" ]] || fail "landing page returned $code"

echo "OK: $events events, latest start $latest"
