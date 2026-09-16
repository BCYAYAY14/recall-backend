# Recall sync protocol 1

The frozen wire format between Recall (Mac, iPhone), the read-only web viewer
and this backend. `src/protocol.ts` is the machine-checked half; the fixtures
in `fixtures/` pin the parts two languages must agree on. A change to anything
here is protocol 2.

Zero em dashes. A table beats a paragraph.

## 1. Principles

| # | Rule |
| --- | --- |
| P1 | Local SQLite on each device is authoritative for editing. The backend sequences and adjudicates; it never invents content |
| P2 | One library per deployment. One `LibraryDO` holds the op log and the current rows; its sequence is the only order |
| P3 | Every operation is idempotent by `op_id`. Every apply is idempotent by `seq` |
| P4 | The WebSocket is an optimisation. HTTP alone is a complete client |
| P5 | No credential, share token or note text in a URL path, a log line or a `sync_run` row |

## 2. Timestamps

On the wire a time is exactly `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC, three fraction
digits). Anything else is refused. Last write wins compares milliseconds with a
**tie to the server** (Recall landmine 83). `fixtures/isnewer.json` is generated
from Recall's `ISODate.swift` and both suites reproduce every verdict.

## 3. Rows, lanes and columns

Eleven lanes: `folder`, `notebook`, `note`, `card`, `grade_event`, `media`,
`occlusion`, `dictionary`, `font`, `settings`, `device`. `note_version` and `kv`
are never lanes.

A row travels as two objects:

| Part | Holds | The server |
| --- | --- | --- |
| `env` | Routing, structure, schedule, `deleted_at` | Reads it (shares, digests, orphan sweeps) |
| `content` | Text, labels, snapshots, LaTeX, words, the settings bag | Never needs to read it (so it could become ciphertext later) |

Each lane's columns and types are in `LANES` in `src/protocol.ts`.

| Rule | Detail |
| --- | --- |
| Full rows | An `upsert` carries EVERY column of its lane in `env` and `content`. A column the lane does not define is refused (`unknown_column`), never stored |
| Null is a clear | A nullable column set to `null` is a deliberate clear. There is no "absent means leave it" in protocol 1 (Recall landmines 81, 175, 188 in JSON form) |
| Ids | Lowercase hyphenated UUIDs everywhere, including foreign keys in `env` |
| Tombstone | `kind: "tombstone"`, `env` complete with `deleted_at` set, **no `content`**. The stored row keeps `env` and an empty `content` |
| Undelete | An `upsert` with `deleted_at: null` and full content, stamped newer |
| Append-only | `grade_event` refuses tombstones; its `updated_at` must equal `env.reviewed_at`. A second op for an existing grade id is a `duplicate` |
| `settings` | One row per device (`id` is the device id), `content.values` a string map. No tombstones |

## 4. Canonical JSON, the payload digest and the operation id

```
payload        = { "content": <content>, "env": <env> }     (tombstone: { "env": <env> })
payload_digest = lowercase hex sha256 of canonical(payload), UTF-8
op_id          = uuidv5("c31e75f6-172f-4c64-a83b-94df6e707132",
                        device_id "|" lane "|" row_id "|" updated_at_ms "|" payload_digest)
```

`updated_at_ms` is the decimal millisecond count. Canonical JSON: keys sorted by
UTF-8 bytes; no whitespace; strings escape only `"` `\` and code points below
U+0020 (`\b \t \n \f \r`, else `\u00xx` lowercase); numbers in ECMAScript
`Number::toString` form with `-0` written `0`; no NaN or infinity.
`fixtures/canonical-json.json` pins 200 payloads and five op ids.

**Only clients compute it.** The Worker never hashes a payload (the free plan's
10 ms CPU limit, plan finding F-20).

### The acknowledgement rule

A client captures `(updated_at, payload_digest)` per row when it builds a
batch. An `applied` or `duplicate` ack cleans a row **only if the row still
carries both**, compared inside one local write transaction. `stale`,
`conflict`, `rejected` and a missing ack never clean. Nothing is persisted: a
relaunch rebuilds the batch and the unchanged row yields the same `op_id`.

## 5. Sequence, cursor and continuity

| Term | Meaning |
| --- | --- |
| `seq` | Assigned by the DO, strictly increasing, never reused. The newest op is never compacted |
| cursor | The highest `seq` a device has applied. Written in the SAME local transaction as the rows |
| `ops` frame | `{from, to, more, ops}`: every op with `from <= seq <= to`. Compaction may leave seqs inside a range with no op; the range is still covered |
| continuity | A client applies a frame only when `from <= cursor + 1`, then sets `cursor = max(cursor, to)`. A frame with `from > cursor + 1` is a gap: discard it and pull from the cursor |
| own ops | A client discards the CONTENT of ops whose `op_id` it issued, but advances its cursor across them |
| `retained_from` | The lowest seq still in the log. A cursor with `cursor + 1 < retained_from` must bootstrap (`resync: true`) |

## 6. Frames

All frames are JSON objects with a `t` field. The WebSocket and HTTP forms carry
identical bodies.

### 6.1 hello

```jsonc
// client
{ "t": "hello", "pv": 1, "device": "<uuid>", "since": 41822, "schema": 219, "app": "1.0.0" }
// server
{ "t": "hello_ok", "pv": 1, "pv_min": 1, "pv_max": 1, "seq": 41977, "retained_from": 38210,
  "resync": false, "reason": null, "schema": 219, "limits": { "ops_per_batch": 500, "bytes_per_batch": 1048576 },
  "server_time": "2026-09-16T11:02:14.318Z", "budget": { ... } }
```

`resync` is true with `reason: "retention_gap"` when `since + 1 < retained_from`
and `since < seq`. `device` must equal the device the credential names, or the
frame is refused (`403 device_mismatch`).

### 6.2 push and push_ack

```jsonc
{ "t": "push", "batch": "<uuid>", "ops": [ { "op_id", "lane", "id", "kind", "updated_at", "base_seq", "env", "content" } ] }
{ "t": "push_ack", "batch": "<uuid>", "seq": 41979, "results": [ <outcome>, ... ], "budget": { ... } }
```

`results` is in the order of `ops`. The DO sequences ops parents first (lane
order, then a note's parent before its children) inside ONE transaction.

| Condition, in order | Outcome | Stored |
| --- | --- | --- |
| Op fails validation | `rejected` with `reason` | nothing; the rest of the frame continues |
| `op_id` already in the log | `duplicate`, original `seq` | nothing |
| No stored row | `applied`, new `seq` | op and row |
| `updated_at` newer than stored (ms, tie to server) | `applied`, new `seq` | op and row. If the op's `base_seq < stored.seq`, the stored revision came from ANOTHER device and differs, it is a concurrent overwrite: a `conflict` row keeps the replaced revision, the ack carries `conflict_id`, and the op carries `replaced: {updated_at, device}` so the device holding that revision keeps a version even though its row was clean (plan F-22) |
| Same `updated_at` and payload identical to stored (a re-push) | `applied`, the stored row's `seq` | nothing |
| Same `updated_at`, payload differs, `base_seq >= stored.seq` (a successor from a device that saw the row) | `applied`, new `seq` | op and row |
| Older `updated_at`, `base_seq >= stored.seq` (a skewed clock on an unchanged base) | `stale`, `winner` | nothing |
| Not newer, `base_seq < stored.seq` (a concurrent edit; a tie goes to the server) | `conflict`, `winner`, `conflict_id` | a `conflict` row with the loser |

`base_seq` is the `seq` of the row the client last saw (0 if never). A client
adopts a `winner` through its ordinary applier; on `conflict` it also keeps its
own text as a kept version.

A revoked device's frame is refused whole before any `seq` is allocated
(`bye` / HTTP 401 `revoked`).

### 6.3 ops and ack

```jsonc
{ "t": "ops", "from": 41978, "to": 41979, "more": false, "ops": [ <wire row with seq and op_id> ] }
{ "t": "ack", "seq": 41979 }
```

A wire row: `{seq, op_id, lane, id, kind, updated_at, env, content, replaced?}` with the
FULL row state after that op. A client whose row carries exactly `replaced.updated_at`
keeps its content as a kept version before adopting the op. The server stores the ack cursor at most once per
10 seconds per device.

### 6.4 control

```jsonc
{ "t": "limit", "service": "do_rows_written", "resets_at": "...", "message": "..." }
{ "t": "bye", "reason": "revoked" | "auth" | "protocol" | "superseded" }
{ "t": "error", "reason": "bad_frame" }
```

`ping` is answered by the runtime's auto response and never wakes the object.

## 7. HTTP

Authenticated calls carry `Authorization: Bearer <device token>`. Every JSON
error is `{ "error": <code>, "message": <sentence> }`.

| Method and path | Auth | Body or query | Answer |
| --- | --- | --- | --- |
| `GET /v1/health` | none | | health (section 8) |
| `GET /v1/version` | none | | `{pv_min, pv_max, schema, build}` |
| `POST /v1/hello` | device | hello frame | hello_ok |
| `POST /v1/push` | device, full | push frame | push_ack |
| `GET /v1/pull?since=&limit=` | device | limit 1..1000, default 500 | ops frame |
| `POST /v1/ack` | device | `{seq}` | `{ok}` |
| `GET /v1/snapshot?after_lane=&after_id=&limit=` | device | | `{pinned_seq, rows, more, next}` ordered by (lane, id) |
| `GET /v1/digest` | device | | per-lane digest (section 9) |
| `GET /v1/sync` | device | WebSocket upgrade | frames |
| `POST /v1/claim` | setup code | `{code, device_id, label, platform, reclaim?}` | `{token, library_id, recovery_codes}` |
| `POST /v1/pair/begin` | device, full | | `{code, expires_in}` |
| `POST /v1/pair/claim` | pairing code | `{code, device_id, label, platform}` | `{token, library_id, scope}` |
| `POST /v1/recover` | recovery code | `{code, device_id, label, platform}` | `{token, library_id}` |
| `POST /v1/device/rotate` | device | | `{token}`; the old token works 60 s |
| `GET /v1/devices` | device, full | | `{devices}` |
| `DELETE /v1/devices/<id>` | device, full | | `{ok}`; the DO closes that device's sockets at once |
| `POST /v1/shares` | device | `{notebook_id, expires_at?}` | `{id, token, url}` |
| `GET /v1/shares` | device | | `{shares}` without tokens |
| `DELETE /v1/shares/<id>` | device | | `{ok}` |
| `POST /v1/share/resolve` | share token in body | `{token}` | the shared document |
| `POST /v1/share/blob` | share token in body | `{token, sha}` | bytes |
| `POST /v1/blob/begin` | device, full | `{sha, bytes, mime}` | `{status: have | put | multipart | disabled | absent | budget | refused, ...}` |
| `PUT /v1/blob/put/<sha>` | device, full | bytes | `{ok}` |
| `PUT /v1/blob/part/<sha>/<n>` | device, full | bytes | `{ok, n}` |
| `POST /v1/blob/commit` | device, full | `{sha}` | `{ok}` |
| `GET /v1/blob/<sha>` | device | | bytes |
| `GET /v1/admin/conflicts` | device, full | | recent conflicts, no payloads |
| `GET /v1/admin/runs` | device, full | | recent `sync_run` rows |
| `GET /v1/admin/budget` | device, full | | limits, usage, maxima, trips |
| `PUT /v1/admin/limits` | device, full | `{key: value}` | refused above `SAFETY_MAX` |
| `POST /v1/admin/r2/disable`, `/enable` | device, full | | `{r2_enabled}` |

Status codes: 400 invalid, 401 no or dead credential (`reason: auth | revoked`),
403 scope or device mismatch, 404, 409 already claimed, 410 window closed or
share expired or revoked, 413 too large, 426 protocol, 429 limit (same JSON as
the `limit` frame), 503 migration or a dependency down.

Scopes: `full` (Mac, iPhone) and `read_share` (a paired browser: hello, pull,
snapshot, digest, blob download and shares; never push).

## 8. Health

```jsonc
{ "ok": true, "protocol": { "min": 1, "max": 1 }, "schema": 219, "build": "<version id prefix>",
  "deployed_at": "...", "services": { "do": "ok", "d1": "ok", "r2": "ok" | "absent" | "disabled" },
  "claimed": true, "time": "..." }
```

No secret, no account id, no library id. Cacheable for 10 seconds.

## 9. Digest

Per lane: `live` (rows with `deleted_at` null), `tombstones`, `max_updated_at`,
`id_xor` (XOR of the 16 UUID bytes of every live row, lowercase hex) and
`content_sha` (sha256 over the lines `id|updated_at|canonical(payload)\n` of
every row sorted by id, computed in the DO). A client computes the same over its
own store; a mismatch names the lane.

## 10. Versioning

`pv_min..pv_max` is advertised by `hello_ok`, `/v1/version` and `/v1/health`. A
client outside the range stops and names which side is older. A client refuses
a backend whose `pv_min` is lower than it previously saw from that host
(downgrade). The backend keeps `pv_min` for at least two releases after raising
`pv_max`.
