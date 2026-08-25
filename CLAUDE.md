# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted 3D model library (STL/3MF/OBJ). Point it at a `LIBRARY_ROOT`
directory with one subfolder per model; the app git-syncs each model
directory's contents transparently (whether changes come through the web UI
or someone editing files directly over NFS/SMB), tracks metadata (tags,
thumbnails, favorites) in SQLite, and renders thumbnails headlessly via
Playwright. A separate, DB-only **Projects** feature lets you group models
together, each pinned to a specific git commit — see the Projects section
below.

pnpm workspace monorepo:
- `apps/server` — Fastify API, git sync engine, thumbnail pipeline, OIDC auth.
- `apps/web` — Vite/React frontend (Tailwind v4 + shadcn/ui, react-three-fiber viewer).
- `packages/shared` — TS types shared between server and web.

## Commands

```bash
pnpm install

# Dev (two servers; web proxies /api to the server)
pnpm --filter @model-hub/server dev   # :4000 — needs LIBRARY_ROOT/DATABASE_PATH set,
                                       # see apps/server/.env.example
pnpm --filter @model-hub/web dev      # :5173

# Typecheck (both packages use `tsc -b` project references)
pnpm --filter @model-hub/server lint
pnpm --filter @model-hub/web lint     # oxlint, not tsc — see below for typecheck

# Tests (server only; vitest)
pnpm --filter @model-hub/server test
pnpm --filter @model-hub/server test:watch

# Single test file
pnpm --filter @model-hub/server exec vitest run src/lib/tags.test.ts

# Production build
pnpm --filter @model-hub/shared build && pnpm --filter @model-hub/server build
pnpm --filter @model-hub/web build    # also typechecks via `tsc -b && vite build`

# DB migrations (after editing apps/server/src/db/schema.ts)
pnpm --filter @model-hub/server db:generate

# Docker (builds + runs the whole app as one container)
docker compose up -d
```

`apps/web`'s `lint` script is oxlint (not a typechecker); typecheck it via
`pnpm --filter @model-hub/web build` or `npx tsc -b` from `apps/web`.

## Architecture

### Sync engine (`apps/server/src/sync/`)

`reconcile.ts`'s `reconcileModelCore` is the single idempotent function
that touches git for a model: ensures `.modelhub-id` (a UUID marker file —
the model's *true* identity, stable across renames) and `.gitignore`
exist, `git init`s if missing, commits any dirty working tree, refreshes the
`files` DB cache, and updates the model row. It's called from three
places — the periodic full-library scan (`scanner.ts`, the real backstop,
since inotify is unreliable over NFS/SMB), the debounced chokidar watcher
(`watcher.ts`, a snappier accelerator, not authoritative), and the
upload/restore routes — always through `reconcileModel`, which wraps it in
a per-path mutex (`queue.ts`) so git operations for one model never
overlap. Upload/restore hold that same lock across their own file write +
commit (calling `reconcileModelCore` directly, *not* the locked
`reconcileModel`, which would deadlock against itself).

Git identity varies by trigger: `AUTO_SYNC_IDENTITY` for scanner/watcher
commits, `LOCAL_UPLOAD_IDENTITY` for UI-driven ones (upload, restore) — this
is what lets the History tab visually distinguish "you did this" from "we
noticed this changed on disk."

A directory rename on disk is *not* a rename to the scanner — it's detected
by matching `.modelhub-id` against the DB's `fs_id` column, which is what
lets a model keep its git history, tags, and DB row across a rename.

### Thumbnails (`apps/server/src/thumbnails/`)

No separate worker service — deliberately. `browser.ts` keeps one warm
headless Chromium instance; `queue.ts` is a trivial in-process
bounded-concurrency queue (default concurrency 1, no Redis/BullMQ).
`generate.ts` drives Playwright to `${WEB_BASE_URL}/internal/render?...` (a
route in `apps/web`, lazy-loaded, never linked from the UI — reuses the same
STL/3MF/OBJ loading code as the interactive viewer via
`apps/web/src/components/model-mesh.tsx`), waits for a `window` flag the
render page sets once loaded, screenshots the canvas, and writes
`.thumbnails/thumb.png` into the model dir. `thumbnailStatus` tracks
pending/generating/ready/error; a boot-time sweep (`trigger.ts`) requeues
anything stuck in `generating` after a crash.

**Startup ordering matters**: the thumbnail pipeline must not start
dequeuing jobs until `app.listen()` has bound the port, because the render
page fetches model bytes back through this same API
(`/api/models/:id/files/*`). `index.ts` calls `initThumbnailPipeline`
*after* `listen()`, not before.

Some slicer-exported "sliced project" files (e.g. BambuStudio `.gcode.3mf`)
contain zero mesh geometry — only G-code + preview images. This is
detected (`EmptyGeometryError` in `model-mesh.tsx`) and surfaces as
`thumbnailStatus: "error"` with a clear message, not a blank thumbnail.

### Metrics (`apps/server/src/metrics/`, `GET /metrics`)

`GET /metrics` (`api/routes/metrics.ts`) exposes Prometheus text-exposition
format via `prom-client`, matching this app's "no heavyweight infra"
posture elsewhere: one process-wide `Registry` (`registry.ts`, also wired
to prom-client's default Node/process metrics), no push gateway, no
separate metrics process. `thumbnail-metrics.ts` exposes the thumbnail
queue's depth/in-flight (set directly by `queue.ts` as jobs move through
it) and completed/failed counters (incremented by `trigger.ts` based on
`generateThumbnail`'s returned outcome, since it deliberately never
rejects — see the Thumbnails section above). `sync-metrics.ts` exposes the
most recent full-library scan's duration, completion timestamp, and
models-changed count, recorded once per completed (non-skipped) pass of
`scanLibraryRoot`. `http-metrics.ts` registers an `onResponse` hook (first
thing in `app.ts`'s `buildApp`, so it wraps every route) for standard
request-count/duration-by-route metrics — labeled by
`request.routeOptions.url` (the matched route *pattern*, e.g.
`/api/models/:id`), never the raw URL, to keep label cardinality bounded.
See the Auth section below for why `/metrics` itself needs no auth.

### Auth (`apps/server/src/auth/`)

OIDC (Authorization Code + PKCE via `openid-client`'s functional v6 API) is
enabled only when `OIDC_ISSUER_URL`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`
are *all* set (`config.ts` fails fast at boot otherwise). When unset,
`guard.ts` resolves every request to one synthetic "local owner" user and
never rejects anything — the rest of the app never branches on auth mode.

The headless thumbnail worker's Playwright page has no user session. Its
requests to `/api/models/:id/files/*` get past the auth guard via a
per-boot random token (`internal-token.ts`) sent as a header, never exposed
to real clients. The frontend's `AuthGate` (redirects to `/auth/login` when
unauthenticated) deliberately does *not* wrap `/internal/render` for the
same reason — see `App.tsx`'s routing.

**`/healthz` and `/metrics` are unauthenticated by design**, even in OIDC
mode: `guard.ts`'s 401 check only fires for paths under `/api/` (`/api/
auth/me` excepted), and neither route lives under that prefix, so both
routes pass through `registerAuthGuard`'s `onRequest` hook untouched —
there's no explicit path allowlist to maintain. This is deliberate:
`/healthz` needs to answer without a session for container
healthchecks, and `/metrics` needs to be scrapeable by Prometheus without
a session or token, same as most self-hosted apps' metrics endpoints. If
this instance is reachable beyond a trusted network, firewall `/metrics`
(and ideally `/healthz`) off at the network level rather than relying on
app-level auth — nothing in this app puts either behind OIDC.

**Roles.** `users.role` is one of `admin` (full access, including user/role
management and instance settings) / `editor` (create/upload/edit/tag/
favorite models and projects, but no deletes, user management, or settings)
/ `viewer` (read-only: browse, view, download). The single-user-mode local
owner always resolves as `admin` (`session.ts`'s `ensureLocalOwner` enforces
this on every call, not just at row creation) — single-user mode is
otherwise unaffected by RBAC. An OIDC user's role is *not* a durable manual
assignment: it's recomputed from their current OIDC groups on every login
(`upsertOidcUser` → `resolveRoleFromGroups` in `lib/roles.ts`), so a group
change on the provider side takes effect next sign-in, not immediately.

Group→role mapping is admin-configurable in the DB (`oidc_group_role_mappings`
table + a singleton `auth_settings` row for the fallback role and the
groups-claim name), not env vars, so it's editable without a restart —
mirrors `config.ts`'s OIDC settings pattern but lives in SQLite instead. The
groups-claim name is configurable because providers vary (Authelia/
Authentik/Keycloak all name it differently); `auth.ts`'s callback reads it
straight off the ID token claims (no extra userinfo round-trip). A user
whose groups match no mapping gets the configured `defaultRole` (recommend
`viewer`) — deliberately never silently falls through to `admin`.

`guard.ts`'s `requireRole(minimumRole)` is a per-route Fastify preHandler
(403, not 401, on an authenticated-but-underprivileged request) — applied
so far only to the admin user-listing and role-mapping routes
(`api/routes/admin.ts`). It is *not* swept across the existing model/
project/tag/etc. routes yet; that's deliberately left to future PRs that
touch those routes anyway, to avoid one sprawling diff.

### Projects (grouping) (`apps/server/src/lib/project-pins.ts`, `apps/server/src/api/routes/projects.ts`)

A **Project** is a separate, DB-only entity from a **Model** (no filesystem
or git of its own) that bundles several models together, each pinned to a
specific commit of that model's own repo — the git-submodule analogy: a
Project is like a repo whose "submodules" point at exact SHAs.
`project-pins.ts`'s `resolvePinTarget` validates a requested sha against the
target model's own `getLog` (same pattern as the restore endpoint), or
defaults to that model's current `lastSyncedCommitSha` when omitted, both
for creating a pin and for the "bump to latest" quick action. Deliberately
**no snapshot/version history for the Project itself** — pins are a live,
editable set (like updating a submodule pointer in place), not an immutable
timeline; a `PinnedModel.isOutdated` flag (pinned sha vs. the model's
current sha) is the only "has this drifted" signal. Forgetting a model
cascades and silently drops any pins to it, matching a submodule whose
target repo has ceased to exist.

### Database

Drizzle ORM + `better-sqlite3` (WAL mode), migrations in
`apps/server/drizzle/`. `models`/`files` are the sync engine's source of
truth's *cache*, not the source of truth itself — the filesystem + git
always is. `tags`/`model_tags` are a simple many-to-many with
case-insensitive dedup handled in application code (`lib/tags.ts`), not a DB
collation. `models.favorite` is a plain boolean column (not a join table —
a single per-model flag, unlike the many-valued tags relation); the default
model list sort is favorites-first. `projects`/`project_model_pins` back the
Projects grouping feature described above. `users`/`sessions` back OIDC.

`apps/server/drizzle/0000_initial_schema.sql` is a **hand-written, squashed
baseline** (not drizzle-kit generated) covering the full pre-v1.0 schema in
one migration — it replaced several earlier incremental migrations when the
core `projects` entity was renamed to `models` (freeing "project" for the
new grouping feature above), since drizzle-kit's interactive rename-vs-
recreate prompt can't be driven non-interactively and preserving data across
that particular migration wasn't a requirement pre-v1.0. Future schema
changes should go back to the normal `db:generate` flow — this squash was a
one-time event, not an ongoing pattern.

### Deployment

Single multi-stage `Dockerfile`: build and runtime stages both use the
*exact same* `mcr.microsoft.com/playwright` base image tag (matching the
installed `playwright` npm version exactly) so better-sqlite3's native
addon never crosses a glibc version boundary. `pnpm --filter @model-hub/server
deploy --prod --legacy` extracts just the server + resolved prod deps
(workspace deps inlined as real files) into a self-contained directory,
avoiding a full `node_modules` copy that would include `apps/web`'s entire
dependency tree and every devDependency. The image is unavoidably large
(~4GB) because the base image bundles Chromium/Firefox/WebKit as separate
layers — deleting the unused browsers in a later layer doesn't reduce
pull/storage size (already-verified via `docker history`; don't
re-attempt this "optimization").

`STATIC_WEB_DIR` (set in the Docker image, unset in dev) makes the server
also serve the built SPA with client-side-routing fallback
(`apps/server/src/api/static.ts`) — this is what makes `WEB_BASE_URL`
default to the server's own origin in production while needing an explicit
override to the Vite dev server in local dev.
