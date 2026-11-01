/**
 * security: not in legacy. How a client plays a lesson's media (contract:
 * protected media, 2026-11-01): `vdocipher` when the lesson has a VdoCipher
 * video (fetch `/lessons/:id/playback`), `url` when it has a content URL,
 * else null. Additive field on every lesson response.
 */
export type Playback = 'vdocipher' | 'url' | null;

export function lessonPlayback(l: {
  video_id?: string | null;
  content_url?: string | null;
}): Playback {
  if (l.video_id) return 'vdocipher';
  if (l.content_url) return 'url';
  return null;
}
