# recall-backend

The Cloudflare backend for Recall, a personal notes app that yields FSRS
flashcards: one Worker carrying the sync API, a hibernating WebSocket and the
read-only web viewer; a Durable Object per library for the ordered document
store; D1 for the control plane; R2 (optional) for content-addressed
attachments. You deploy it into YOUR OWN Cloudflare account. Recall never holds
a Cloudflare token and cannot create or delete anything in your account.

## Deploy your own (about 20 minutes)

**Pictures are optional, and so is a payment method.** This deploys in
notes-only mode: every note, card, review and setting syncs; pictures, drawings
and fonts stay on the device that made them. Notes-only needs no card and
cannot bill. Attachment storage (R2) needs a payment method on the account and
is a separate, later step (below).

You need a GitHub or GitLab account (the deploy clones this repository into it)
and a Cloudflare account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/BCYAYAY14/recall-backend)

| Step | What you do | Where | Minutes |
| --- | --- | --- | --- |
| 1 | Create or sign in to a Cloudflare account | cloudflare.com | 3 |
| 2 | Press **Deploy to Cloudflare** above | this page | 1 |
| 3 | Authorize GitHub or GitLab, name the Worker, and type a setup code: a long random value, at least 12 characters | the deploy flow | 4 |
| 4 | Wait for the build, then copy the `workers.dev` address | Cloudflare | 3 |
| 5 | **Within one hour of the deploy**: in Recall on the Mac, Settings, Sync, Cloudflare. Paste the address, choose Setup, paste the setup code, Connect | Recall | 2 |
| 6 | Recall checks the backend: reachable, the protocol matches, the server clock within 60 seconds of the device's, notes-only or attachments | Recall | 1 |
| 7 | Write down the eight recovery codes Recall shows once | anywhere but the device | 2 |
| 8 | On the iPhone: New pairing code on the Mac, then choose Pairing and enter it in the same sheet on the phone | Recall | 1 |

The setup code works once. After an hour, or after a claim, it is dead until
you change it in the Worker's settings and redeploy.

## What a deployment holds

| Resource | Created by the deploy | Holds |
| --- | --- | --- |
| Worker `recall` | yes | the API, the WebSocket, the web viewer (Static Assets) |
| Durable Objects `LibraryDO`, `BudgetDO`, `LimiterDO` | yes | the library's op log and rows; the attachment safety counters; rate limits |
| D1 `recall-meta` | yes, with its migrations applied by `npm run deploy` | devices, pairing and recovery codes (hashed), shares, attachment index, sync records (counts only) |
| R2 `recall-media` | only with `wrangler.attachments.jsonc` | attachment bytes, content addressed |

## Health

`GET /v1/health` answers without a credential and carries no secret: protocol
range, schema, build, deploy time, service status (`r2` is `ok`, `absent` or
`disabled`), whether it is claimed, and the server time (stamped fresh on
every answer; the probes behind it are cached 10 s).

## Attachments (R2), later

Only after you have added a payment method and decided you want pictures to
sync. The Worker's attachment safety limits (a monthly byte and operation wall,
a per-minute breaker, `SAFETY_MAX`) are on by default and fail closed.

1. Enable R2 on the account (Cloudflare dashboard, R2).
2. In your fork, replace `wrangler.jsonc` with `wrangler.attachments.jsonc`
   (identical apart from one bucket binding; `test/unit/config.spec.ts` keeps
   them so).
3. Push. Workers Builds redeploys and creates the bucket.
4. Recall's Cloudflare sheet reads **Attachments: On**, and files start to
   follow their rows.

Switch attachments off at any time without redeploying: set the Worker
variable `R2_ENABLED` to `false` in the dashboard.

## Restoring a snapshot

With attachments on, the library writes a gzipped NDJSON snapshot to R2 every
day at 03:17 UTC and keeps the newest 14 dates. The ordinary recovery is the
Mac: its library is authoritative and bootstraps the backend upward. The
snapshot is for a library object that lost its rows (a Cloudflare incident):

1. `GET /v1/admin/snapshots` with a device token lists the dates kept.
2. `POST /v1/admin/restore` with `{"date": "YYYY-MM-DD", "confirm": "restore <your host>"}`
   (no `date` takes the newest) restores it. A library that still has rows
   refuses (`409 not_empty`): nothing is ever overwritten.
3. The restore starts a new epoch, so every device bootstraps from it on its
   next sync; edits a device made since that date push up as usual, and so
   does every row a device synced after that date that the snapshot lacks
   (each device offers it again). The restored library keeps its id, so its
   next daily snapshot and attachment sweep run as before.

## Upgrading

Pull this repository's changes into your fork and push; Workers Builds
redeploys. The backend keeps `pv_min` for at least two releases after raising
`pv_max`, so an older Recall keeps syncing, and Recall names which side is
older when they no longer overlap. No update is automatic: it is your account.

## Leaving

| Action | How |
| --- | --- |
| Export everything | `GET /v1/export` with a device token streams every lane as NDJSON (gzip). Recall's own `.rcl` archive and JSON export are complete without it |
| Move to another account | Deploy a fresh backend, connect Recall on the Mac with its setup code; the Mac's library is authoritative and uploads itself |
| Remove the deployment | Remove every device in Recall's Cloudflare sheet, then delete the Worker, the D1 database and (if you made one) the R2 bucket in the Cloudflare dashboard. Recall never deletes a Cloudflare resource |

## Development

| File | What it is |
| --- | --- |
| `PROTOCOL.md` | The frozen wire format, protocol 1 |
| `src/` | The Worker and its Durable Objects |
| `assets/` | The read-only web viewer, served from the same origin (`WEB.md`) |
| `client/reference-client.ts` | The reference client every suite drives |
| `tools/conformance.ts`, `tools/conformance-cli.ts` | The protocol conformance suite, in the runtime and against a deployment |
| `tools/soak.ts` | The synthetic soak with fault injection and digest checks |
| `fixtures/` | Cross-language fixtures: `isNewer` verdicts (generated from Recall's Swift) and canonical JSON |
| `wrangler.jsonc`, `wrangler.attachments.jsonc` | Notes-only, and the same plus one R2 binding |

```bash
npm ci
npm test                                   # asset gate, unit suite, Workers runtime suite
npx wrangler dev                           # notes-only, local
npx wrangler dev -c wrangler.attachments.jsonc   # with an emulated bucket, local, no account
```

Zero runtime dependencies in the Worker. Development dependencies are pinned
exactly with a lockfile.
