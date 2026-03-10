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
