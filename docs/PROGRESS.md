# Build checklist

Legend: ✅ done & verified · 🟡 implemented but not fully verified (needs external credentials / manual check) · ⏳ in progress · ⬜ not started · ⛔ blocked

## Phase 0 — Inspection
- ✅ Repo inspected: untouched `create-next-app` scaffold (Next 16.3.8, React 19.2.8, Tailwind 4, gsap), no API, no env vars.
- ✅ Restructured into `frontend/` and `backend/`; root `.gitignore`, `docs/`.
- ✅ Tooling smoke-tested on this machine: `libpg-query` (real PostgreSQL parser, WASM) works; `embedded-postgres` (PG 18) works; `mongodb-memory-server` works. Docker daemon is **not** running here, so integration tests use embedded Postgres + in-memory MongoDB; `docker-compose.yml` is provided but not exercised.
- ⛔ External credentials missing (Google OAuth client, Groq key) — integrations are implemented against documented APIs and tested with fakes; marked 🟡 below.

## Phases
| # | Phase | Status |
|---|-------|--------|
| 1 | Auth, profiles, authorization | ⬜ |
| 2 | Events, rounds, dashboard | ⬜ |
| 3 | Challenge workspace + Monaco | ⬜ |
| 4 | Groq generation + validation | ⬜ |
| 5 | Isolated PostgreSQL execution + hidden tests | ⬜ |
| 6 | Scoring + ranking | ⬜ |
| 7 | Qualification + finalization | ⬜ |
| 8 | Socket.IO live leaderboard | ⬜ |
| 9 | Admin dashboard | ⬜ |
| 10 | Integration/security tests, Docker, docs | ⬜ |
