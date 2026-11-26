import { randomBytes } from 'node:crypto';

/** not in legacy: strict playback protection (docs/video-hls-contract.md). */
export const KEY_WINDOW_MS = 10 * 60_000;
export const MAX_KEY_FETCHES = 3;
export const MAX_PER_HOUR = 20;
export const MAX_PER_DAY = 100;
export const RETENTION_DAYS = 180;
const MAX_SEGMENT_MS = 6 * 3600_000;

/** 128 random bits as 32 hex characters. */
export const newSessionId = () => randomBytes(16).toString('hex');

/** created + video duration + 30 min, capped at 6 h; 6 h when the duration is unknown. */
export function segmentsUntil(created: Date, durationSec?: number | null) {
  const ms =
    durationSec && durationSec > 0
      ? Math.min(durationSec * 1000 + 30 * 60_000, MAX_SEGMENT_MS)
      : MAX_SEGMENT_MS;
  return new Date(created.getTime() + ms);
}

/** True when the user already has too many sessions in the last hour or day. */
export const overPlaybackLimit = (lastHour: number, lastDay: number) =>
  lastHour >= MAX_PER_HOUR || lastDay >= MAX_PER_DAY;

/** "dd Mon yyyy HH:mm IST", whatever the process time zone. */
export function istStamp(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.day} ${p.month} ${p.year} ${p.hour}:${p.minute} IST`;
}
