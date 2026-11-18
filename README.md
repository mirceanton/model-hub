# model-hub

A self-hosted 3D model library (STL/3MF/OBJ/STEP). Point it at a directory containing
one subfolder per project and it adopts what's already there — no import
step, no re-organizing required. Every project's file history lives in a
real git repo, kept in sync transparently whether a new version comes
through the web UI or you just drop files onto the share yourself. Tags,
descriptions, and thumbnails live in a small local SQLite database
alongside it.

> [!WARNING]
> **AI Slop / Vibe Coded Project** — This project was "built" with heavy AI
> assistance to scratch a personal itch. The code works for my use case, but
> it has not been hardened, audited, or battle-tested. Deploy at your own
> risk, preferably not exposed to the open internet. No warranties, no
> support guarantees, no promises.

## 📸 Screenshots

<table>
  <tr>
    <td align="center"><b>Library</b></td>
    <td align="center"><b>Project detail</b></td>
    <td align="center"><b>Upload a new version</b></td>
  </tr>
  <tr>
    <td><img src=".img/dashboard.png" alt="Library grid with tag filters" width="320"/></td>
    <td><img src=".img/project-detail.png" alt="Project detail: viewer, tags, description, git history" width="320"/></td>
    <td><img src=".img/upload-version.png" alt="Upload new version dialog" width="320"/></td>
  </tr>
  <tr>
    <td align="center">Search and filter by tag</td>
    <td align="center">3D viewer, tags, and full git history per project</td>
    <td align="center">Every upload is a commit</td>
  </tr>
</table>

## Features

- **Non-destructive adoption** — point `LIBRARY_ROOT` at a directory you
  already have; each subfolder becomes a project as-is, nothing is moved,
  renamed, or restructured.
- **Real version history, not a blob store** — every project directory is a
  real git working tree. Upload a new version from the UI, and it's a
  commit with your description as the message. Edit files directly over
  NFS/SMB instead, and a periodic scan (plus an optional live watcher)
  picks up the change and commits it automatically — the History tab
  visually distinguishes "you did this" from "we noticed this changed on
  disk." Any past version can be restored as a new commit.
- **Local SQLite metadata** — tags, descriptions, and thumbnail state live
  in a single SQLite file. The filesystem + git are always the source of
  truth for file content; the database is just a cache/index on top, so it
  can be safely deleted and rebuilt from what's on disk.
- **Automatic thumbnails** — a headless Chromium instance renders each
  project's primary model and writes a thumbnail to disk, using the exact
  same STL/3MF/OBJ/STEP loading code as the interactive 3D viewer.
- **Tags & search** — organize and filter your library by tag, with
  case-insensitive dedup.
- **OIDC auth, optional** — plug in Authelia, Authentik, Keycloak, or any
  standard OIDC provider. Leave it unconfigured and the app runs in
  single-user mode with no login screen at all.
- **Sleek, modern UI** — React + shadcn/ui, dark mode included, with an
  interactive react-three-fiber viewer for STL/3MF/OBJ/STEP files.

## Running with Docker

```bash
docker compose up -d
```

Edit `docker-compose.yml` first: set the bind mount under `volumes` to your
actual library directory. The app is then at `http://localhost:4000`.

Pre-built images are published to `ghcr.io/mirceanton/model-hub` on every
release; `docker-compose.yml` builds from source by default, but you can
point it at `ghcr.io/mirceanton/model-hub:latest` instead.

By default there's no login (single-user mode). To put it behind OIDC
(Authelia, Authentik, Keycloak, etc.), uncomment and fill in the
`OIDC_*`/`SESSION_SECRET` environment variables in `docker-compose.yml` —
see `apps/server/.env.example` for what each one does.

If your library lives on an NFS/SMB mount, set
`LIBRARY_WATCH_USE_POLLING: "true"`, since inotify events are often
unreliable across network filesystems; a periodic full-library scan runs
regardless as a backstop.

`GET /metrics` exposes Prometheus-format metrics (thumbnail queue depth,
sync scan duration, HTTP request counts, etc.) and, like `GET /healthz`,
is unauthenticated by design — even when OIDC is enabled — so it stays
scrapeable without a session or token. If this instance is reachable
beyond a trusted network, firewall `/metrics` off at the network level.

## API tokens (scripting/automation)

For scripts that need API access without a browser session — e.g. a slicer
post-processing hook that pushes a new model version after every successful
print — create a personal API token from the **API Tokens** page in the UI.
The plaintext value is shown exactly once, at creation; only its hash is
ever stored. A token authenticates as you, with your current role, and can
be revoked at any time from the same page.

```bash
curl -H "Authorization: Bearer mh_pat_<your token>" \
  http://localhost:4000/api/models
```

This works the same whether or not OIDC is configured — in single-user mode
every request already succeeds regardless, so a token there is mostly
useful for keeping scripts forward-compatible with a future move to OIDC.

## MCP endpoint (AI agents)

`POST /api/mcp` exposes the library as an [MCP](https://modelcontextprotocol.io)
server (Streamable HTTP, stateless, JSON responses) so agents — e.g. a
homelab assistant — can manage models conversationally: list/search models,
create models, upload/download files (base64), version history, diff and
restore, tags, projects/pins, trash and purge. 27 tools, all thin wrappers
over the same REST routes the UI uses — identical validation and behavior.

Authentication is the same as the REST API: on OIDC-protected instances send
a personal API token as `Authorization: Bearer <token>` (create one on the
**API Tokens** page). Tool access follows the token's role — viewer reads,
editor creates/uploads/edits, admin deletes/purges — and every tool call
re-authenticates as the token's user, so the MCP surface can never elevate
privileges. Single-user mode stays open like the rest of the API.

```jsonc
// MCP client config (url-mode / streamable-http)
{
  "mcpServers": {
    "model-hub": {
      "url": "https://modelhub.example.com/api/mcp",
      "headers": { "Authorization": "Bearer mh_pat_<your token>" }
    }
  }
}
```

The endpoint is stateless: no `initialize` handshake is required, each POST
is self-contained, and GET/DELETE return 405 (no SSE stream). That makes it
safe behind load balancers and trivially proxyable (e.g. LiteLLM's url-mode
MCP registration). File transfers are bounded by `MCP_MAX_FILE_BYTES`
(default 25 MiB) and `MCP_MAX_FILES_PER_CALL` (default 5); larger files get
a `tooLarge` error pointing at the REST download path instead. Set
`MCP_ENABLED=false` to turn the endpoint off entirely.

## Development

Monorepo (pnpm workspaces): `apps/server` (Fastify API + sync engine +
thumbnail pipeline), `apps/web` (Vite/React frontend), `packages/shared`
(shared TS types).

```bash
pnpm install
cp apps/server/.env.example apps/server/.env   # then edit LIBRARY_ROOT/DATABASE_PATH
pnpm --filter @model-hub/server dev             # API on :4000
pnpm --filter @model-hub/web dev                # web on :5173, proxies /api to :4000
```

Run tests with `pnpm test` (server unit tests) or `pnpm --filter @model-hub/web build`
for a production build/typecheck of the frontend.

See `CLAUDE.md` for the full architecture.
