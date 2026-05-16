# EYRA Backend Copilot Instructions

- Stack: Node.js, Express 5, MongoDB, CommonJS modules.
- Prefer small, targeted changes that preserve existing API shapes unless the task requires otherwise.
- Reuse existing service and controller structure under `src/services`, `src/controllers`, and `src/routes`.
- Use the structured logger in `src/utils/logger.js`; do not introduce new `console.log` calls in application code.
- Keep payment flows conservative: validate inputs, preserve idempotency assumptions, and do not weaken rate limits or webhook checks.
- Do not re-enable debug-only routes or production bypasses.
- Favor existing middleware patterns for auth, validation, and permissions.
- Keep error responses consistent with nearby route/controller conventions.
- When changing sockets or live features, avoid duplicate counters, duplicate event listeners, and production-insecure auth fallbacks.
- Add or update the smallest useful verification step when touching critical payment or auth paths.
- Working style: default to implementation, not explanation.
- Assume full authority for routine workspace changes; do not ask for confirmation before normal file edits, searches, or safe commands.
- If the request is clear, inspect the code, apply the change directly, and verify it.
- Do not stop to present a plan unless explicitly requested or the task is ambiguous.
- Keep responses short, avoid repeated summaries, and do not offer multiple alternatives unless asked.
- Prefer the smallest effective change and report only changed files, a short result, and any blocker.

## Security Rule — MANDATORY on every JS file change
After editing any file, check the changed code for the following and fix immediately if found:
- Hardcoded secrets, tokens, API keys, or connection strings.
- Raw user input used directly in MongoDB queries (injection risk — use Mongoose schema types or explicit cast).
- Auth bypasses, rate-limit removals, or debug-only routes left enabled.
- Missing `await` on async DB calls followed by response sends.
- Any `$where` or `$function` operator with user-controlled data.

## Translation Rule — MANDATORY on every JS file change
After editing any `.js` file that contains user-facing string responses (`message:`, `error:`, SnackBar-equivalent API responses):
- Strings returned to the client should be neutral or use translation keys if the project uses i18n.
- Do NOT mix Turkish and English in the same response object (e.g. `{ message: 'Kullanıcı bulunamadı' }` and `{ message: 'Not found' }` in the same controller is inconsistent — pick one and keep it consistent per endpoint).
These two checks (translation consistency + security) apply to EVERY file touched in a session.

## Terminal Management
- ALL AI agents must use ONLY ONE persistent terminal session.
- REUSE the existing terminal - do NOT spawn new terminals.
- If terminal fails: kill it, create ONE new one, continue.
- NEVER run multiple terminals in parallel - use one sync terminal for all work.
- This persists across workspace reloads and closes.
