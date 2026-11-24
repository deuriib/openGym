# Deploying openGym to Railway (API) and Vercel (web)

This is a **split deployment**: the API runs as a long-lived container on Railway, and the
browser app is a static build on Vercel. It is not the arrangement
[SELF_HOSTING.md](SELF_HOSTING.md) describes, so read the two constraints below before changing
anything here.

The coordination doctrine (phases, gates, who signs off) lives in the `split-paas-deployment`
runbook in the agency-agents checkout: `strategy/runbooks/scenario-split-paas-deployment.md`.

## Why the app cannot simply be split in two

| Constraint | Where it comes from | What it means here |
| --- | --- | --- |
| **One origin** | Passkeys are bound to `RP_ID`; the session cookie is `__Host-gymsid`; the API never sends `Access-Control-Allow-Credentials` | The browser must load the app and call `/api` on the **same hostname**. Vercel proxies `/api/*` to Railway (`vercel.json`), and the API is never called from the browser directly |
| **No database** | Everything lives in `data/` (`db.json`, `uploads/`, `shared/`, `secret`) | The Railway service needs a **volume mounted at `/data`**, and **exactly one replica** |

Everything else (nginx replaced by Vercel, media staged by the build, headers re-declared) follows
from those two.

## Topology

```text
browser ──► app.opengy.app            (Vercel: static build + headers + /api rewrite)
                 │
                 └── /api/* ──────► api.opengy.app   (Railway: node server.js :3000)
                                          └── volume /data
```

`api.opengy.app` is reached server-side by the proxy only. `ORIGIN` and `RP_ID` name the **web**
host, because that is what the browser types and what WebAuthn binds to.

> **Settle the hostname before the first profile is created.** Changing it later invalidates every
> passkey (self-hosting guide, "Passkeys fail even though RP_ID looks right"). `www.` and the apex
> are different hosts to WebAuthn: pick one.

| Variable | Value here |
| --- | --- |
| `SITE_URL` (web) | `https://app.opengy.app` |
| `API_URL` (Railway) | `https://api.opengy.app` |
| `RP_ID` (Railway) | `app.opengy.app` — bare host: no scheme, no port, no slash |
| `ORIGIN` (Railway) | `https://app.opengy.app` — scheme, no trailing slash |

Both are set in `vercel.json` (the rewrite destination) and in
`.github/workflows/deploy-web.yml` (`SITE_URL`, `API_URL`). Change all three together.

## Railway (API)

1. New project → deploy from this repository, branch `main`, builder **Dockerfile**
   (`railway.json` pins `api/Dockerfile`; a tested Dockerfile beats a generated buildpack).
2. **Add a volume, mount it at `/data`.** Without it every profile, session and upload is lost on
   the next deploy.
3. Variables:

   | Variable | Value | Why |
   | --- | --- | --- |
   | `DATA_DIR` | `/data` | Must match the mount, or data lands on the ephemeral disk |
   | `PORT` | `3000` | The port the API listens on |
   | `ORIGIN` | `https://app.opengy.app` | The address people type |
   | `RP_ID` | `app.opengy.app` | Passkey scope |
   | `RP_NAME` | `openGym` | Shown by the passkey prompt |
   | `TRUST_PROXY` | `1` | The proxy overwrites `X-Forwarded-For`, so the sign-in throttle can use it |
   | `FIRST_USER_ADMIN` | `1` | The first profile becomes admin — register yours before sharing the URL |
   | `PASSWORD_LOGIN` | `1` | Optional: needed only if someone cannot use a passkey |

4. Custom domain `api.opengy.app`. Healthcheck `/api/health` is already in `railway.json`.
5. **Keep replicas at 1.** Two containers over one `db.json` is data loss, not scaling.
6. Enable **Wait for CI** so a red `tests-ok` blocks the deploy.

The AI Coach is off in this deployment: the default image target has no AI runtime, so there is no
`/coach-auth` volume either. Turning it on later means building the `coach` target
(`API_TARGET=coach`, see `docker-compose.yml`) and mounting a second volume.

## Vercel (web)

1. New project from this repository, **root directory = repository root** (the build reaches
   `api/coach/core/` and `catalogue/media/` through sibling paths).
2. **Disable Vercel's Git integration.** GitHub Actions is the only production deployer
   (`.github/workflows/deploy-web.yml`); two deployers mean every merge deploys twice and a failed
   check no longer blocks anything.
3. Custom domain `app.opengy.app`.
4. No build-time environment variables: the app derives its API base from its own location
   (`frontend/src/lib/app-base.js`), and `VITE_*` values are baked at build time.

`vercel.json` carries the parts nginx used to do:

- the `/api/:path*` rewrite that keeps one origin;
- the CSP (including the inline boot script's hash, which `frontend/src/lib/csp.test.js` keeps in
  step with `frontend/index.html`), frame, referrer and content-type headers;
- cache rules (`/assets/*` immutable, `sw.js` and `index.html` revalidated, media for 30 days);
- `Cross-Origin-Resource-Policy` on `/exercise-media/`.

The build runs `scripts/catalogue/stage-media.mjs` because the 180 px exercise media is not part of
the Vite bundle — the container copied it in, and a static host does not. The workflow fails the
deploy if the staged media is missing, which is the difference between a working app and a wall of
blank tiles.

## Phase 0: measure before you trust it

`scripts/deploy/spike.mjs` measures what the proxy does with bodies, headers, cookies and origins.
Run it against the deployed web host **before** relying on the deployment:

```bash
# 1. Sign in to the app in a browser, copy the session cookie, then:
node scripts/deploy/spike.mjs --base https://app.opengy.app \
  --cookie '__Host-gymsid=<value>' --upload-mb 100

# 2. Without a credential, everything except the body checks still runs:
node scripts/deploy/spike.mjs --base https://app.opengy.app
```

Exit codes: `0` everything measured and passed, `1` a check failed, `2` something could not be
measured. **A skipped check is not a pass** — the script refuses to report green on a skip. Evidence
lands in `docs/evidence/deploy-spike-<date>.json`.

What the results mean:

| Result | Meaning |
| --- | --- |
| upload `201` | the body crossed the proxy and was stored — good |
| upload `413` mentioning a payload limit | **the proxy caps the body**: videos above it never reach the API. Take the decision in the runbook's Key Decisions table (lower `MEDIA_VIDEO_MAX_MB`, turn uploads off with `MEDIA_UPLOADS=0`, or keep the web container) |
| upload `413` from the API | the API's own cap: raise it or lower `--upload-mb` |
| connection reset mid-body | the proxy cut the request — treat as a failure, not a slow upload |
| `headers`/`static-media` skipped | the base serves no shell (bare API); run it against the web host |

The same script is a regression test: run it after any change to the rewrite, the headers or a
platform's limits.

## Deploy pipeline

| Step | Where |
| --- | --- |
| Lint, typecheck, tests, images | `.github/workflows/test.yml` — the `tests-ok` job is the required check |
| API deploy | Railway on `main`, gated by **Wait for CI**, built from `api/Dockerfile` |
| Web deploy | `.github/workflows/deploy-web.yml` — **waits for the `Tests` run of the same commit to succeed**, then builds with Node 26 on the runner and runs `vercel deploy --prebuilt --prod` |

Both platforms gate on the same thing, but only Railway has a built-in "wait for CI". The web
workflow gets there with `on: workflow_run` on `Tests`, so a merge publishes nothing until
`tests-ok` is green for that commit. It has **no path filter on purpose**: a list of "files that
affect the web build" is a guess, and missing one (the catalogue that feeds `stage-media.mjs`, a
coach asset) makes production stale with nothing red to show for it. A redeploy of unchanged
content after a docs-only merge costs a few minutes; a silently missed deploy does not surface
until someone notices. Use **Run workflow** to redeploy by hand.

Required repository secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`. The workflow's
`production` environment is where a required reviewer approves each production deploy.

Deploy order matters: the API first. A fresh shell that cannot reach `/api` is not a deployment.

## Backups

Everything is in the volume: `db.json`, `uploads/`, `shared/`, `secret`, `vapid.json`. Lose
`secret` and every session and paired phone dies with it.

```bash
# from a shell inside the service (railway ssh), then copy the archive out
tar czf /data/opengym-$(date +%F).tar.gz -C /data --exclude=uploads .
```

The archive contains passkeys and every workout: treat it as personal data. `audit.log` adds
everyone's sign-in times. **Rehearse the restore**: unpack into a scratch service and sign in with
an existing passkey before trusting the schedule.

## Known limitations of this deployment

- **Vercel preview deployments cannot sign in.** They serve a different hostname, so `ORIGIN` and
  `RP_ID` do not match: writes are refused by design. Previews are for visual review (guest mode).
- **The AI Coach is off** — so the "long request through the proxy" risk is not exercised here.
  Turning the Coach on means re-running Phase 0 with a real slow request.
- **One replica.** The JSON store is single-writer.
- **The API's hostname is public.** It has to be, for the proxy to reach it; it answers
  `/api/health` without a session.
