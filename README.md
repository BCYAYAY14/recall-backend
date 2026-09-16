# recall-backend

The Cloudflare backend for [Recall](https://github.com/BCYAYAY14), a personal
notes app that yields FSRS flashcards: one Worker carrying the sync API, a
hibernating WebSocket, and the read-only web viewer; a Durable Object per
library for the ordered document store; D1 for the control plane; R2 (optional)
for content-addressed attachments.

| File | What it is |
| --- | --- |
| `PROTOCOL.md` | The frozen wire format, protocol 1 |
| `src/` | The Worker and its Durable Objects |
| `client/reference-client.ts` | The reference client every suite drives |
| `tools/conformance.ts` | The protocol conformance suite |
| `fixtures/` | Cross-language fixtures: `isNewer` verdicts (generated from Recall's Swift) and canonical JSON |

```bash
npm ci
npm test
```

Deployment and Bring Your Own Cloudflare instructions arrive with CF-9.
