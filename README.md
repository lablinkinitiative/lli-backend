# LabLink Initiative — CDP Backend API

Node.js/Express REST API with SQLite. Lives at `app.lablinkinitiative.org`.

**Version:** 2.0.0 | **Service:** `lablink-api.service` | **Port:** 3001 (nginx proxy)

---

## What This Is

The CDP (Career Development Platform) backend — student auth, program catalog with 390+ STEM opportunities, saved programs, and gap analyses. Lab management was removed in v2.0.0.

## Quick Start

```bash
npm install
DB_PATH=/path/to/lablink.db CDP_JWT_SECRET=your-secret node server.js
```

---

## API Reference

### Health
```
GET /health
```

### Auth
```
POST /api/cdp/auth/register    — Register student
POST /api/cdp/auth/login       — Login (returns JWT)
GET  /api/cdp/auth/me          — Current student info [auth]
GET  /api/cdp/auth/google      — Google OAuth start
GET  /api/cdp/auth/google/callback — Google OAuth callback
```

### Programs
```
GET /api/cdp/programs                  — List programs (paginated, filterable)
GET /api/cdp/programs/:slug            — Program detail (with tags)
GET /api/cdp/programs/tags/summary     — Available tag values for filter UI
GET /api/cdp/intern/opportunities      — Programs in intern-site format
GET /api/cdp/export/cdp-format         — Programs in CDP app format
```

**Filter params for `GET /api/cdp/programs`:**

| Param | Type | Example |
|-------|------|---------|
| `q` | string | `q=NIH` (search title/org/desc) |
| `type` | string | `type=fellowship` |
| `field` | string | `field=cs` |
| `sector` | string | `sector=federal_science` |
| `career_stage` | tag | `career_stage=undergraduate` |
| `benefits` | tag | `benefits=stipend` |
| `has_stipend` | bool | `has_stipend=true` |
| `remote` | bool | `remote=true` |
| `duration` | tag | `duration=summer` |
| `focus_type` | tag | `focus_type=computational` |
| `special` | tag | `special=underrepresented_minorities` |
| `keywords` | tag | `keywords=beginner_friendly` |
| `page` | int | `page=2` |
| `limit` | int | `limit=20` (max 200) |
| `sort` | string | `sort=title` |

### Student Profile
```
GET  /api/cdp/students/me/profile       — Get profile [auth]
PUT  /api/cdp/students/me/profile       — Update profile [auth]
GET  /api/cdp/students/me/full-data     — Full StudentData blob [auth]
PUT  /api/cdp/students/me/full-data     — Save full StudentData blob [auth]
```

### Saved Programs
```
GET    /api/cdp/students/me/saved-programs          — List saved [auth]
POST   /api/cdp/students/me/saved-programs/:id      — Save a program [auth]
DELETE /api/cdp/students/me/saved-programs/:id      — Remove saved [auth]
```

### Gap Analyses
```
GET  /api/cdp/students/me/gap-analyses   — List analyses [auth]
POST /api/cdp/students/me/gap-analyses   — Store an analysis [auth]
```

---

## Database

SQLite at `$DB_PATH` (default: `/home/agent/data/lablink.db`).

**Tables:**
- `cdp_students` — student accounts
- `cdp_programs` — 392 STEM programs (+ `tags` column for AI-generated tags, added 2026-03-04)
- `cdp_saved_programs` — bookmarks
- `cdp_gap_analyses` — readiness assessments

---

## Pipeline

The `pipeline/` directory contains the agent-native internship discovery pipeline:

```
pipeline/
├── run-pipeline.sh        — Full pipeline (9 sector agents → upsert → enrich → sync)
├── orchestrator.py        — Deploys 9 Claude subagents in parallel
├── upsert.py             — Normalizes and upserts programs to DB
├── enrich-tags.py        — AI tag enrichment for programs
├── run-enrichment.sh     — Batch enrichment (5 parallel workers)
├── sync-cdp-programs.sh  — Syncs DB → CDP frontend app
├── notify.py             — Posts pipeline results to Slack
├── sectors/              — Per-sector agent prompts
├── output/               — Pipeline JSON outputs + logs
├── OUTPUT_SCHEMA.md      — Required output format for sector agents
└── TAGS_SCHEMA.md        — Tag schema reference
```

**Run the full pipeline:**
```bash
./pipeline/run-pipeline.sh
```

**Run tag enrichment only:**
```bash
./pipeline/run-enrichment.sh              # 5 workers, all unenriched programs
python3 pipeline/enrich-tags.py --unenriched-only   # single worker
```

---

## Security

- `helmet.js` — X-Frame-Options, HSTS, X-Content-Type-Options
- `express-rate-limit` — 20 req/15min on auth, 200 req/15min general
- JWT auth (30-day tokens, Bearer header)
- CORS restricted to `*.lablinkinitiative.org`

---

## Deployment

```bash
sudo systemctl status lablink-api
sudo systemctl restart lablink-api
journalctl -u lablink-api -f
```

**nginx config:** `/etc/nginx/sites-enabled/lablink-api`
**SSL:** Let's Encrypt (auto-renews, expires 2026-05-31)

---

## Environment Variables

| Variable | Default | Required |
|----------|---------|---------|
| `PORT` | `3001` | No |
| `DB_PATH` | `./data/lablink.db` | Yes (use `/home/agent/data/lablink.db`) |
| `CDP_JWT_SECRET` | `dev-secret` | **Yes in prod** |
| `GOOGLE_CLIENT_ID` | — | For Google OAuth |
| `GOOGLE_CLIENT_SECRET` | — | For Google OAuth |
| `GOOGLE_CALLBACK_URL` | — | For Google OAuth |
