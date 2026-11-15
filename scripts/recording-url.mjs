/**
 * A durable recording URL. The journey command and the engine parser both
 * use this check. A presigned download expires, so it is not proof.
 */
const RECORDING = /^https:\/\/\S+$/i;
const RECORDING_SHAPE = /\.(?:png|jpe?g|webp|gif|mp4|webm|mov)(?:[?#]\S*)?$|\/artifacts\//i;
const POSTHOG_REPLAY = /^https:\/\/(?:[a-z0-9-]+\.)?posthog\.com\/(?:embedded\/|project\/\d+\/replay\/)\S+$/i;
const EXPIRING = /(?:X-Amz-|cloud-agent-artifacts\.s3)/i;

export function isDurableRecordingUrl(token) {
  const text = String(token ?? "").trim();
  if (!RECORDING.test(text) || EXPIRING.test(text)) return false;
  return RECORDING_SHAPE.test(text) || POSTHOG_REPLAY.test(text);
}
