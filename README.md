# model-hub

A self-hosted 3D model library. Point it at a directory containing one
subfolder per project (STL/3MF files); it keeps each project's history in a
real git repo, generates thumbnails, and gives you a searchable, taggable
web UI to browse, upload new versions, and restore old ones.

## Running with Docker

```bash
docker compose up -d
```

Edit `docker-compose.yml` first: set the bind mount under `volumes` to your
actual library directory. The app is then at `http://localhost:4000`.

By default there's no login (single-user mode). To put it behind OIDC
(Authelia, Authentik, Keycloak, etc.), uncomment and fill in the
`OIDC_*`/`SESSION_SECRET` environment variables in `docker-compose.yml` —
see `apps/server/.env.example` for what each one does.

If your library lives on an NFS/SMB mount, set
`LIBRARY_WATCH_USE_POLLING: "true"`, since inotify events are often
unreliable across network filesystems; a periodic full-library scan runs
regardless as a backstop.

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
