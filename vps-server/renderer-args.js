/**
 * Audio input arguments split out of renderer.js so the FFmpeg shape can be
 * asserted without spawning a real encoder.
 */
export function buildAudioInputArgs(audioPath) {
  if (!audioPath) return [];
  return [
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
  ];
}
