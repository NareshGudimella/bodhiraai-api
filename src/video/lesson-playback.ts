/**
 * security: not in legacy. How a client plays a lesson's media (contract:
 * protected media, 2026-11-01; docs/video-hls-contract.md): `hls` when the
 * lesson has a self-hosted encrypted-HLS video (fetch `/lessons/:id/playback`),
 * `url` when it has a content URL, else null. Additive field on every lesson
 * response. `processing` while the `video-transcode` job runs
 * (`/lessons/:id/playback` answers 409 `video_processing` meanwhile; a lesson
 * whose job gave up is null here and answers 409 `video_failed`).
 */
export type Playback = 'hls' | 'url' | 'processing' | null;

export function lessonPlayback(l: {
  video_hls_path?: string | null;
  content_url?: string | null;
  video_status?: string | null;
}): Playback {
  if (l.video_status === 'processing') return 'processing';
  if (l.video_hls_path) return 'hls';
  if (l.content_url) return 'url';
  return null;
}
