# Deploy

For this radio fork, use [station deployment and recovery](station/docs/deploy.md).
It covers the station's overrides, room, Russian voices and guarded builds.
The general single-host install below describes the root compose files.

## Configuration and first boot

Install Docker with Compose on the host. In a source checkout, run:

```bash
./scripts/setup.sh
```

Edit the **root `.env`**, seeded from [`.env.example`](.env.example). Set
`ADMIN_USER`, `ADMIN_PASS` and `SITE_URL`. Keep it private and out of git.
Legacy `controller/.env` and `docker/.env` are no longer read by compose.
For a custom state location, set `STATE_DIR` in the root `.env` and ensure all
services mount that same directory. Keep SQLite on local disk.

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f controller broadcast
```

Only Caddy exposes a host port in `docker-compose.yml`: `CADDY_PORT`, default
**7700**, mapped to container port 80. Open `http://localhost:7700/onboarding`
and sign in with the admin credentials. The wizard tests Navidrome and LLM
access, then stores setup in `state/setup-config.json`, secrets in
`state/secrets.env` and runtime settings in `state/settings.json`. Environment
variables take precedence over wizard settings. Navidrome should be reachable
from inside the controller container; `localhost` there is the container itself.

Icecast source/admin/relay passwords are generated and persisted automatically
in `state/icecast-secrets.env` by the broadcast entrypoint. Explicit root `.env`
overrides remain supported; manual synchronisation between legacy env files is
unnecessary. Preserve the state directory across container replacement.

## Verify and expose

```bash
curl -fsS http://localhost:7700/api/health
curl -fsS http://localhost:7700/api/now-playing
curl -I http://localhost:7700/stream.mp3
```

Check that audio actually arrives and now-playing advances while the station
has listeners. A healthy API alone does not prove the mixer is playing.

For HTTPS and routing, follow [reverse-proxy recipes](docs/reverse-proxy.md).
An existing proxy can use `docker-compose.byo.yml`; replicate the route table
in `docker/Caddyfile` on one hostname, including blocked internal auth routes.
The web image defaults to same-origin `/api` and `/stream.mp3`.

[Built-in private station mode](docs/private-station.md) offers independent
player and stream locks. The UI lock leaves public metadata and stream access
available; stream authentication needs a mixer restart when enabled or disabled.
The station's current access policy is documented in the fork deployment guide.

## Updates and recovery

Before updating, export a WAL-safe backup through Admin → Settings → Backup;
cloud keys are redacted and must be restored separately. Preserve archives and,
for this fork, the room database and VAPID key too. See
[updating and rollback](docs/updating.md) for state migration limits.

Production images bake in source. Rebuilding controller/web changes their code;
`docker compose restart` alone runs the existing image. Avoid a broadcast
restart unless changing its image or startup settings, since it interrupts audio.
For this fork use the station guide's exact delivery/build commands.

The [legacy recipe](docs/archive/deploy-legacy.md) is retained only as history.
