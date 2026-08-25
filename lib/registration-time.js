'use strict';

const TIME_ZONE = 'America/Denver';

function parseWallClock(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) throw new Error(`Unrecognized startDatetime: ${iso}`);

  const parts = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
  const normalized = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ));
  if (
    normalized.getUTCFullYear() !== parts.year ||
    normalized.getUTCMonth() + 1 !== parts.month ||
    normalized.getUTCDate() !== parts.day ||
    normalized.getUTCHours() !== parts.hour ||
    normalized.getUTCMinutes() !== parts.minute ||
    normalized.getUTCSeconds() !== parts.second
  ) {
    throw new Error(`Invalid startDatetime wall clock: ${iso}`);
  }
  return parts;
}

function tzOffsetMs(utcMs, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - utcMs;
}

function zonedWallToUtcMs(parts, timeZone = TIME_ZONE) {
  const wallAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let guess = wallAsUtc;
  for (let i = 0; i < 3; i++) {
    guess = wallAsUtc - tzOffsetMs(guess, timeZone);
  }
  return guess;
}

function registrationOpenMs(startDatetime) {
  // PushPress encodes the local class wall-clock time with a trailing Z.
  // Treat its date/time fields as America/Denver local time, subtract seven
  // calendar days at the same wall time, then convert the result to an instant.
  const c = parseWallClock(startDatetime);
  const shifted = new Date(Date.UTC(
    c.year,
    c.month - 1,
    c.day - 7,
    c.hour,
    c.minute,
    c.second,
  ));
  return zonedWallToUtcMs({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  });
}

function formatLocalWall(iso) {
  const c = parseWallClock(iso);
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second));
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(d);
  return `${date} at ${time} MT`;
}

function formatInstantLocal(ms, timeZone = TIME_ZONE) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

function formatInstantLocalDate(ms, timeZone = TIME_ZONE) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(ms));
}

function localDateKey(ms, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function scheduleKey(event) {
  return `${event.uuid}|${event.startDatetime}`;
}

module.exports = {
  TIME_ZONE,
  formatInstantLocal,
  formatInstantLocalDate,
  formatLocalWall,
  localDateKey,
  parseWallClock,
  registrationOpenMs,
  scheduleKey,
  tzOffsetMs,
  zonedWallToUtcMs,
};
