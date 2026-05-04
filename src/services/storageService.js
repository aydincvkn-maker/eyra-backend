// src/services/storageService.js
//
// Centralized object storage abstraction. Currently backed by Cloudinary.
// All upload code paths (avatar, chat media, verification, posts, admin-chat)
// must go through this service so that local disk is never used in production.

const path = require("path");
const cloudinary = require("cloudinary").v2;
const { logger } = require("../utils/logger");

const ROOT_FOLDER = process.env.CLOUDINARY_ROOT_FOLDER || "eyra";

let _configured = false;
let _enabled = false;

function _configureFromEnv() {
  if (_configured) return _enabled;

  const url = process.env.CLOUDINARY_URL;
  if (url) {
    // SDK auto-parses CLOUDINARY_URL on import, but we call config() explicitly
    // so it works even if env was loaded after SDK import.
    cloudinary.config({ secure: true });
    _enabled = true;
  } else if (
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  ) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    _enabled = true;
  } else {
    _enabled = false;
    logger.warn(
      "[storage] Cloudinary credentials missing. Uploads will fail until CLOUDINARY_URL is set.",
    );
  }
  _configured = true;
  return _enabled;
}

function isEnabled() {
  return _configureFromEnv();
}

function _resourceTypeFor(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "video"; // Cloudinary uses 'video' for audio
  return "raw"; // pdf/doc/zip etc.
}

function _sanitizeId(value) {
  return (
    String(value || "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 80) || "file"
  );
}

/**
 * Upload a buffer to Cloudinary.
 *
 * @param {Buffer} buffer
 * @param {object} options
 * @param {string} options.folder - subfolder under ROOT_FOLDER (e.g. "avatars", "chat/images")
 * @param {string} [options.publicId] - desired public id (no extension)
 * @param {string} [options.mimeType]
 * @param {string} [options.originalName]
 * @returns {Promise<{ url: string, secureUrl: string, publicId: string, resourceType: string, bytes: number, format?: string }>}
 */
async function uploadBuffer(buffer, options = {}) {
  if (!_configureFromEnv()) {
    throw new Error("Storage not configured (CLOUDINARY_URL missing)");
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Empty upload buffer");
  }

  const folder = options.folder
    ? `${ROOT_FOLDER}/${String(options.folder).replace(/^\/+|\/+$/g, "")}`
    : ROOT_FOLDER;
  const resourceType = _resourceTypeFor(options.mimeType);
  const ext = options.originalName
    ? path.extname(options.originalName).replace(/^\./, "").toLowerCase()
    : undefined;

  const uploadOpts = {
    folder,
    resource_type: resourceType,
    overwrite: false,
    use_filename: false,
    unique_filename: true,
  };
  if (options.publicId) {
    uploadOpts.public_id = _sanitizeId(options.publicId);
    uploadOpts.unique_filename = false;
    uploadOpts.overwrite = true;
  }
  if (resourceType === "raw" && ext) {
    uploadOpts.format = ext;
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      uploadOpts,
      (err, result) => {
        if (err) {
          logger.error("[storage] upload failed", {
            folder,
            resourceType,
            error: err.message,
          });
          return reject(err);
        }
        resolve({
          url: result.secure_url || result.url,
          secureUrl: result.secure_url,
          publicId: result.public_id,
          resourceType: result.resource_type,
          bytes: result.bytes,
          format: result.format,
        });
      },
    );
    stream.end(buffer);
  });
}

/**
 * Delete an asset by publicId.
 * Pass resourceType when known (image/video/raw); defaults to "image".
 */
async function destroy(publicId, resourceType = "image") {
  if (!_configureFromEnv()) return { ok: false, skipped: true };
  if (!publicId) return { ok: false };
  try {
    const res = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      invalidate: true,
    });
    return {
      ok: res?.result === "ok" || res?.result === "not found",
      raw: res,
    };
  } catch (e) {
    logger.warn("[storage] destroy failed", { publicId, error: e.message });
    return { ok: false, error: e.message };
  }
}

/**
 * Best-effort extraction of a Cloudinary publicId from a stored URL.
 * Returns null if the URL is not a Cloudinary URL.
 */
function extractPublicId(url) {
  if (typeof url !== "string" || !url.includes("res.cloudinary.com")) {
    return null;
  }
  // .../upload/v123/folder/sub/name.ext  or  .../upload/folder/sub/name.ext
  const m = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?$/);
  return m ? m[1] : null;
}

module.exports = {
  isEnabled,
  uploadBuffer,
  destroy,
  extractPublicId,
};
