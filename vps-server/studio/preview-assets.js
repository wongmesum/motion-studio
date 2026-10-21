import crypto from 'crypto';

const DEFAULT_TTL_SECONDS = 600;

function sign(secret, assetId, actor, expiresMs) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${assetId}\n${actor}\n${expiresMs}`, 'utf8')
    .digest('hex');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), 'utf8');
  const rightBuffer = Buffer.from(String(right), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * A preview document is a sandboxed srcdoc iframe with no `allow-same-origin`, so its
 * subresource requests carry no session cookie. Instead of leaking the session, each
 * preview asset URL carries a short-lived HMAC over the asset id, owner actor, and expiry.
 * The signature is verifiable without a session and expires on its own.
 */
export function buildSignedPreviewAssetUrl({
  assetId,
  actor,
  secret,
  now = Date.now(),
  ttlSeconds = DEFAULT_TTL_SECONDS,
}) {
  const expiresMs = now + ttlSeconds * 1000;
  const signature = sign(secret, assetId, actor, expiresMs);
  const query = new URLSearchParams({ actor, expires: String(expiresMs), signature });
  return `/api/studio/preview-assets/${encodeURIComponent(assetId)}/content?${query.toString()}`;
}

/** Returns the actor when the request is a valid, unexpired signature; null otherwise. */
export function verifyPreviewAssetRequest({
  assetId,
  actor,
  expires,
  signature,
  secret,
  now = Date.now(),
}) {
  if (typeof assetId !== 'string' || typeof actor !== 'string' || typeof secret !== 'string') {
    return null;
  }
  // Fail closed: an empty key would let anyone mint a valid signature. Secret generation
  // guarantees a non-empty value, so this only rejects misconfigured deployments.
  if (!secret || !assetId || !actor) return null;
  const expiresMs = Number(expires);
  if (!Number.isInteger(expiresMs) || expiresMs <= now) return null;
  const expected = sign(secret, assetId, actor, expiresMs);
  if (!safeEqual(String(signature), expected)) return null;
  return actor;
}
