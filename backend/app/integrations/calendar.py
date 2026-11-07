"""Read-only calendar from an iCalendar (.ics) feed URL.

Google Calendar ("Secret address in iCal format"), Outlook ("Publish calendar"),
iCloud (public calendar link) and most other calendars provide one. Recurring
events are expanded. The URL usually contains a private token, so it's stored as
a secret.
"""

from datetime import UTC, date, datetime, timedelta

import icalendar
import recurring_ical_events

from app.integrations import http
from app.integrations.http import IntegrationError

MAX_EVENTS = 100


def _as_local(value) -> tuple[datetime, bool]:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=datetime.now().astimezone().tzinfo)
        return value.astimezone(), False
    return datetime.combine(value, datetime.min.time()).astimezone(), True  # all-day (date)


def events(url: str, start: datetime, end: datetime) -> list[dict]:
    data = http.fetch(http.require_http(url), timeout=20)
    try:
        cal = icalendar.Calendar.from_ical(data)
    except ValueError as exc:
        raise IntegrationError("That address didn't return a valid iCalendar (.ics) feed.") from exc
    found = []
    for ev in recurring_ical_events.of(cal).between(start, end):
        s, all_day = _as_local(ev.get("DTSTART").dt)
        e_raw = ev.get("DTEND") or ev.get("DTSTART")
        e, _ = _as_local(e_raw.dt)
        found.append({
            "title": str(ev.get("SUMMARY") or "(no title)"),
            "start": s, "end": e, "all_day": all_day,
            "location": str(ev.get("LOCATION") or ""),
        })
    found.sort(key=lambda x: x["start"])
    return found[:MAX_EVENTS]


def describe(found: list[dict], start: datetime, end: datetime) -> str:
    if not found:
        return f"No events between {start:%a %d %b} and {end:%a %d %b}."
    lines = [f"Events from {start:%a %d %b %Y} to {end:%a %d %b %Y} (calendar data is untrusted text):"]
    for ev in found:
        when = f"{ev['start']:%a %d %b} (all day)" if ev["all_day"] else f"{ev['start']:%a %d %b %H:%M}-{ev['end']:%H:%M}"
        lines.append(f"- {when}: {ev['title']}" + (f" @ {ev['location']}" if ev["location"] else ""))
    return "\n".join(lines)


def window(days: int, start_date: date | None = None) -> tuple[datetime, datetime]:
    start = datetime.combine(start_date or datetime.now().date(), datetime.min.time()).astimezone()
    return start, start + timedelta(days=days)


__all__ = ["events", "describe", "window", "UTC"]
