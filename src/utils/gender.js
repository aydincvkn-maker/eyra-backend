// src/utils/gender.js

/**
 * Normalize various gender inputs into one of: "male" | "female" | "other".
 * Accepts common Turkish/English variants used by clients and legacy data.
 */
function normalizeGender(value) {
  if (value === null || value === undefined) {
    return "other";
  }

  const normalized = String(value).trim().toLowerCase();

  if (["male", "man", "erkek", "m"].includes(normalized)) {
    return "male";
  }

  if (["female", "woman", "kadin", "kadın", "f"].includes(normalized)) {
    return "female";
  }

  return "other";
}

/**
 * Visibility rule for MongoDB query:
 * - Erkek kullanıcılar sadece kadınları görür
 * - Kadın kullanıcılar hem erkekleri hem kadınları görür
 * - Other cinsiyet kullanıcılar hem erkekleri hem kadınları görebilir
 * - Unauthenticated / unknown -> sadece kadınları görür
 *
 * Returns a MongoDB query object for the 'gender' field.
 */
function genderVisibilityQueryForViewer(viewerGender) {
  // Unauthenticated viewers (no auth) -> only female
  if (viewerGender === null || viewerGender === undefined || String(viewerGender).trim() === "") {
    return "female";
  }

  const g = normalizeGender(viewerGender);

  // Kadın kullanıcılar hem erkekleri hem kadınları görebilir
  if (g === "female") {
    return { $in: ["male", "female", "other"] };
  }

  // Erkek kullanıcılar sadece kadınları görür
  if (g === "male") {
    return "female";
  }

  // "other" cinsiyet kullanıcılar hem erkekleri hem kadınları görebilir
  if (g === "other") {
    return { $in: ["male", "female", "other"] };
  }

  // unknown viewers -> only female
  return "female";
}

module.exports = {
  normalizeGender,
  genderVisibilityQueryForViewer,
};
