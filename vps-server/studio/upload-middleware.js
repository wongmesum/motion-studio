import busboy from 'busboy';
import { UPLOAD_LIMITS } from '../security/upload-policy.js';
import { AssetRejectedError } from './asset-store.js';

const FILE_FIELD_NAME = 'file';
const MAX_FORM_FIELDS = 4;
const MAX_FORM_FILES = 2;
const DEFAULT_STATUS = 400;

/**
 * Upload failures carry their own HTTP status so the route never has to inspect
 * Indonesian error text to decide between 413, 415 and a plain 400.
 */
export function statusForError(error) {
  return Number.isInteger(error?.status) ? error.status : DEFAULT_STATUS;
}

export function toPublicAsset(record) {
  if (!record || typeof record !== 'object') return null;
  const { ownerKey: _ownerKey, ...rest } = record;
  return rest;
}

/**
 * Streams a single `file` part straight into the asset store. Nothing is buffered in
 * memory, and the store enforces the per-kind byte ceiling while bytes are arriving.
 */
export function createAssetUploadMiddleware({
  assetStore,
  actorFromRequest = (req) => req.adminActor,
  maxStreamBytes = UPLOAD_LIMITS.video.maxBytes + 1,
} = {}) {
  return function handleAssetUpload(req, res) {
    let actor;
    try {
      actor = actorFromRequest(req);
      if (typeof actor !== 'string' || actor.length === 0) {
        throw new AssetRejectedError('Sesi admin tidak valid');
      }
    } catch {
      return res.status(401).json({ error: 'Sesi admin tidak valid' });
    }

    let parser;
    try {
      parser = busboy({
        headers: req.headers,
        limits: { files: MAX_FORM_FILES, fields: MAX_FORM_FIELDS, fileSize: maxStreamBytes },
      });
    } catch {
      return res.status(400).json({ error: 'Berkas upload tidak valid' });
    }

    let rejection = null;
    let saved = null;
    let pending = null;
    let sawFile = false;
    let responded = false;

    const reject = (error) => {
      if (!rejection) rejection = error;
    };

    parser.on('file', (fieldName, stream, info) => {
      if (fieldName !== FILE_FIELD_NAME) {
        reject(new AssetRejectedError('Field berkas harus bernama "file"'));
        stream.resume();
        return;
      }
      if (sawFile) {
        reject(new AssetRejectedError('Hanya satu berkas yang dapat diunggah'));
        stream.resume();
        return;
      }
      sawFile = true;
      stream.on('error', () => {});
      stream.on('limit', () => {
        reject(new AssetRejectedError('Ukuran file melebihi batas yang diizinkan', { status: 413 }));
      });

      pending = assetStore
        .save(actor, {
          filename: info.filename,
          contentType: info.mimeType,
          stream,
        })
        .then((asset) => {
          saved = asset;
        })
        .catch((error) => {
          reject(error);
          // Drain the remainder so busboy can finish and the response is not stalled.
          stream.resume();
        });
    });

    parser.on('error', () => {
      reject(new AssetRejectedError('Berkas upload tidak valid'));
    });

    parser.on('close', async () => {
      if (responded) return;
      responded = true;
      try {
        await pending;
      } catch {
        // `pending` already records its failure through reject().
      }

      if (rejection) {
        // A stream cut off by the busboy ceiling may still have produced a stored file.
        if (saved) {
          await assetStore.remove(actor, saved.assetId).catch(() => {});
          saved = null;
        }
        return res.status(statusForError(rejection)).json({ error: rejection.message });
      }
      if (!saved) return res.status(400).json({ error: 'Berkas upload tidak ditemukan' });
      return res.status(201).json({ asset: toPublicAsset(saved) });
    });

    req.on('aborted', () => {
      parser.destroy();
    });
    req.pipe(parser);
    return undefined;
  };
}
