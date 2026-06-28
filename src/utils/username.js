const USERNAME_PATTERN = /^[a-zA-Z0-9_.]+$/;

const normalizeUsername = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^a-zA-Z0-9_.]/g, "")
    .slice(0, 10);

const isValidUsername = (value) => {
  const username = String(value || "").trim();
  return (
    username.length >= 3 &&
    username.length <= 10 &&
    USERNAME_PATTERN.test(username)
  );
};

const createUniqueUsername = async (User, seed = "user") => {
  const normalizedSeed = normalizeUsername(seed);
  const base = normalizedSeed.length >= 3 ? normalizedSeed : "user";

  for (let attempt = 0; attempt < 25; attempt++) {
    const suffix =
      attempt === 0 ? "" : String(Math.floor(100 + Math.random() * 900));
    const prefix = base.slice(0, Math.max(3, 10 - suffix.length));
    const candidate = `${prefix}${suffix}`.slice(0, 10);

    if (!isValidUsername(candidate)) continue;

    const exists = await User.exists({ username: candidate });
    if (!exists) return candidate;
  }

  for (let attempt = 0; attempt < 25; attempt++) {
    const fallback = `u${Date.now().toString(36).slice(-6)}${attempt}`.slice(
      0,
      10,
    );
    const exists = await User.exists({ username: fallback });
    if (!exists) return fallback;
  }

  throw new Error("unique_username_unavailable");
};

module.exports = {
  normalizeUsername,
  isValidUsername,
  createUniqueUsername,
};
