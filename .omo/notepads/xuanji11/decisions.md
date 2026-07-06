# Phase 6 — Local Auth bcrypt Migration

- Use `bcrypt.hash(password, 10)` for all new admin password hashes, including `auth.changePassword`, by changing only the shared `hashPassword` helper.
- Keep deterministic scrypt only as a legacy verification fallback for 128-character hex hashes that do not start with `$2`; bcrypt hashes are verified first with `bcrypt.compare`.
- On successful legacy verification, immediately persist a bcrypt replacement to `system_settings.admin_password_hash` so migration happens during normal login without forcing password resets.
- Derive `signLocalToken` expiry from `Session.maxAgeMs` as `${Math.floor(Session.maxAgeMs / 1000)}s` so JWT lifetime matches the 365-day session cookie max age.
