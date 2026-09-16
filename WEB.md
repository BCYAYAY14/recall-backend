# The web viewer

`assets/` is Recall's read-only web viewer, served by the same Worker as the
API (Workers Static Assets, plan 10.1). It reads, practises and shares. It
never edits: a browser's device credential has `read_share` scope and the
server refuses its writes.

| Mode | How it starts | What it can do |
| --- | --- | --- |
| Paired | Type the eight digit code Recall shows under Settings, Sync, Pair a device | Read the whole library, practise cards, make and stop share links |
| Share link | Open `https://<backend>/#share=<token>` | Read one document and practise its cards; nothing else |
| Offline fixtures | `?fixture=shared`, `?fixture=signed`, `?fixture=injection` | The real page with its network swapped for synthetic rows (`js/fixture.js`); `fixture.html` links them |

There is no server field, no key and no `config.local.js`: the backend is the
page's own origin. A share link carries its token in the fragment, which the
browser never sends to a server, and the page sends it to the API in a POST
body, never in a path (finding F-14).

## Security

| Layer | What holds it |
| --- | --- |
| `assets/_headers` | CSP `default-src 'none'`, scripts, styles, fonts and connections from `'self'` only, images also `data:` and `blob:`, no framing, no referrer, HSTS, nosniff |
| No inline code | `tools/check-assets.ts` refuses an inline script, an inline handler, a `javascript:` URL, a third-party origin or an HTML string sink before any deploy |
| Rendering | Every note-derived value reaches the DOM through `textContent` or `setAttribute` on elements built node by node; drawings are SVG built node by node; a drawing's embedded picture must be base64 |
| Formulas | KaTeX 0.16.11 is vendored under `assets/vendor/katex` (the copy Recall bundles) with `trust: false`; `?fixture=injection` proves a `\href{javascript:...}` draws no link |
| Stored XSS | `?fixture=injection` puts hostile text in every field the renderer reads; the check is that it draws as text, adds no script, iframe, handler or `javascript:` URL, and logs no CSP violation |

## Caching and versions

HTML, JS and CSS are `Cache-Control: no-cache` (revalidated by ETag, so a new
deploy is picked up on the next load); KaTeX's files are immutable. On load
the page asks `/v1/version` and refuses a backend outside protocol 1, naming
which side is older.

## Known limits

The limits the Supabase viewer had carry over: maths in plain text stays text
until Recall renders it; settings defaults do not reach the web; an added font
draws for a paired browser only; SF Symbols draw the mark; table wrapping is
the browser's. New: an existing share link cannot be copied again later,
because the backend keeps only a hash of its token. Make a new link instead.
