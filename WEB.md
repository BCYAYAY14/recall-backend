# Recall on the web

`assets/` is Recall on the web, served by the same Worker as the API (Workers
Static Assets, plan 10.1). A paired browser is ONE MORE DEVICE with `full`
scope (PLAN-BETA-0.12 section 26, ruling W-0): it reads the library, studies
with FSRS grades, edits docs, sets deadlines and scheduling, and writes the
same rows through `/v1/push` that the Mac and the iPhone do. A share link stays
read only for ever.

| Mode | How it starts | What it can do |
| --- | --- | --- |
| Paired | Type the eight digit code Recall shows under Settings, Sync, Pair a device | Everything below, as a device with its own id on every grade and edit |
| Share link | Open `https://<backend>/#share=<token>` | Read one document and practise its cards; nothing is saved |
| Offline fixtures | `?fixture=shared`, `?fixture=signed`, `?fixture=injection` | The real page with its network swapped for synthetic rows (`js/fixture.js`); `fixture.html` links them |

There is no server field, no key and no `config.local.js`: the backend is the
page's own origin. A share link carries its token in the fragment, which the
browser never sends to a server, and the page sends it to the API in a POST
body, never in a path (finding F-14).

## Pages (Ink 17, Mac layout at 700px and wider, the phone's below)

| Page | Route | What it carries |
| --- | --- | --- |
| Today | `#today` | The hero (N due, minutes, new cards and the deadline share), Documents with their due counts, Mastery with its legend and fact line, Coming up |
| Docs | `#docs` | Folders and docs, each doc with its 4pt mastery stripe and due count |
| A doc | `#doc/<id>`, `/cards`, `/edit` | Notes and Cards chips (a segmented control on the phone), the header "12 notes · 3 cards · edited 6:40", Study, Share, the doc menu (Rename, Study deadline, Scheduling, Study every card now; Make Cards, Quiz, Text styles, Word count, Kept versions; Import into this doc, Print or save as PDF; Delete) |
| Editing | `/edit` | The format strip (paragraph style, list, the doc's font, size; bold, italic, underline, strikethrough, superscript, subscript, highlight, formula, clear; make card, drawing, table, picture, diagram), the browser's spellcheck, tables cell by cell, a cell taking a line's inline styles from the strip and its keys (D-189: bold, italic, underline, strikethrough, highlight, a link, the two scripts; never a paragraph style, a list or a size; the size menu sets the TABLE's own text size, `ts`), formulas drawn by KaTeX while their line is not being edited (D-190: the line shows its source under the caret), pictures uploaded by sha, the drawing editor, occlusion regions (draw, move, resize, label), the word count readout; the trigger drawn as a chip, whose arrow is the direction the card asks (every arrow and the box are `TriggerChipGeometry`'s numbers; a trigger that ends its line keeps its own arrow until answer lines sit under it, then the list arrow; a trigger just typed at the caret stays text until a space follows it or the caret leaves, and a space typed after an escaped trigger chips it again); the arrow's menu (a press on the chip: Type, Asks, Answer, Card on, Preview card with ⌘↩, Card info); Return at the end of a line whose trigger ends it starts an answer bullet one level deeper; Backspace right after a chip gives the trigger back as words (`\>>`, the backslash hidden), and Backspace inside that escaped trigger takes the backslash too once nothing is left to escape; a cloze blank shows only its words in a dashed box, its ▾ opening the blank's menu (Own card, With the others, Hint, Remove blank), typing `{{word}}` makes an own-card blank and ⇧⌘C with a selection makes one; a doc undo and redo (⌘Z, ⇧⌘Z); a selection across lines as whole blocks (R7: delete, type over, copy, cut, paste, kind, Tab, move with ⌥⌘[ and ⌥⌘]); underline (⌘U, a span only, no typed marker); links (⌘L, and ⌘-click opens one, Control-click off a Mac, landmine 278); cloze (⇧⌥⌘C, ⌃⇧⌘C); headings (⌥⌘1 to 3); list labels computed as the app draws them; a pasted picture uploaded by sha; a table's column edge dragged (the column left of it, 44pt floor, stored once as `w`) and Fit to page; a picture selected, resized by any corner (96pt to the measure, `display_width`), cropped with Reset, Cancel and Done (stored `x,y,w,h` on the media row, a crop that would hide a mask refused by ordinal) and shown whole again; find and replace (⌘F, ⌘G: the stored text, markers and picture tokens never matched, a line break refused, a TAB or `::` refused in a cell); a whole line or block set cut and pasted back as ITSELF, its card and schedule aboard (P2d), a copy pasted as a fresh row keeping its kind and style; A4 page breaks when Settings, Text, Page layout is on. Code blocks and inline code are gone (owner, 2026-09-29): a legacy code row draws and edits as a paragraph and a stored `c` run is dropped on decode, its text kept. PLAN-BETA-0.12 section 26.3 is the parity table |
| Palette | ⌘K | Docs, notes with their doc and heading, actions, and "Create note" last (⌘↩) |
| Study | a takeover | Ink 17 s1: the card, the reveal, "From your notes", the schedule line, the grade quartet with each grade's interval, Undo, keys Space, 1 to 4, Z, O, Esc; a list card as a set (every line with its ✕) or in order (Show line N), the suggested grade ringed, a line forgotten twice its own line card until Good or Easy (D-191, `ListReview`) |
| Flashcards | `#cards` | Every card by doc, searchable, with its due |
| Knowledge | `#knowledge` | Tiles, mastery, ten weeks of activity, the grade mix, a 14 day forecast, card states |
| Settings | `#settings/<page>` | Sync (devices, sign out), Study (retention, new per day, leeches, notes under answers), Text (spelling, word count, page layout), Appearance (eight themes, Mode), Data (Import, Download a snapshot, Export CSV, Recently deleted), About |

## The rules, ported

Ruling W-B: plain JavaScript restating exactly the rules the web needs, each
with a conformance test in `npm test` whose values come from Recall's Swift
suite.

| File | What it restates | Test |
| --- | --- | --- |
| `js/wire.js` | Canonical JSON, the payload digest, the op id, the millisecond LWW with a tie to the server, `ISODate.stamp(after:)` | `test/unit/web-wire.spec.ts` (the shared fixtures) |
| `js/fsrs.js` | FSRS-6 with the 21 published defaults, the learning step, whole day graduation at the local start of day | `test/unit/web-fsrs.spec.ts` (py-fsrs's memory state and interval history) |
| `js/gate.js` | The six triggers of the 2026-09-28 flashcard model (`>>` `<<` `<>` `::` `;;` `>>>`, the off dash, the backslash escape and where each escaping backslash stands, list-shaped lines) over the one masked finder, the table column gate (`::` only), cloze ordinals and a span's pieces (`clozeSpans`), typed markers | `test/unit/web-gate.spec.ts` (FlashcardModelTests, CardGateTests, ReverseCardTests); `test/unit/web-flashcards.spec.ts` (directions, `attrs.tg` and `attrs.ask` byte for byte, list answers, descriptors) |
| `js/cardline.js` | D-191's editing rules as text: `ClozeBlanks` (own card, with the others, the hint, remove, a typed `{{word}}`), the arrow's menu (`chipState`, `applyChipChange`: a Basic direction is its trigger, `attrs.ask` only when it differs from the type's, Set and In order per depth), Backspace after a chip (`canvasUnchipAtCaret`), Return after a trigger (`canvasReturnAfterTrigger`), Preview card (`cardPeek`), the space after a trigger (`triggerAwaitingSpace`, `rechippingOnSpace`, `backspaceInEscapedTrigger`) | `test/unit/web-card-menu.spec.ts` (FlashcardModelTests' three blank cases unchanged, the menu's stored rows byte for byte); `test/unit/web-chip-geometry.spec.ts` (the space rules' own cases, and every arrow read out of `TriggerChipGeometry.swift`) |
| `js/sched.js` | `buildQueue`, `dueCounts`, `examQuotas`, the young window, `clampToExam`, forecast and mastery | `test/unit/web-sched.spec.ts` |
| `js/spans.js` | `InlineSpans`: the FNV-1a fingerprint, the sidecar's encoding (underline is `n`, D-189), `mapped` and `mappedThroughDiff`, toggle and remove, `styleableRanges`, `LinkTarget.selfLink`; `TableCellRuns` (a cell's runs in its row's `spans`, a run never crossing a cell) | `test/unit/web-spans.spec.ts`, `test/unit/web-editor-parity.spec.ts`, `test/unit/web-2026-09-29.spec.ts` (the app's own encoder's bytes) |
| `js/aitext.js` | `AIPrompts` (the instructions, the data rule, pieces and shares), `AIOutput` (`keepCard`, `keepQuestion`, the truncated salvage), `QuizBuilder.fromCards` | `test/unit/web-aitext.spec.ts` |
| `js/io.js` | `CSVImporter` (sniff, parse, dedupe), `NoteFileReader` (Markdown, text), `Snapshots.exportJSON` and `exportCSV` | `test/unit/web-io.spec.ts` |
| `js/words.js` | `CanvasWordCount` and `WordCountStat` | `test/unit/web-io.spec.ts` |
| `js/order.js` | `OrderSlots`: the read order `(position, created_at, lower(hex(id)))`, slots between neighbours, the windowed respace (gap 1024, roomy 64, the start and end edges, the Int32 ceiling) | `test/unit/web-order.spec.ts` (the Swift suite's values and stamp counts) |
| `js/store.js` | A grade (card row plus a `grade_event` from this device), undo, a line saved as `outlineUpdateText` saves it, a line, row or doc placed through `Order` (only moved rows written), a block moved over its neighbour, tables (a card table's header kept, E18; a cell's style written to its row's `spans` through the store's trim and carried through a column added or removed, D-189), the arrow's menu (`attrs.ask` in the same write as the trigger, the answer lines re-kinded), pictures, drawings, occlusion regions, docs, deadlines, per doc knobs, restore | driven in the browser against a local Worker; `test/unit/web-review-2026-09-26.spec.ts` pins the review's rules below; `test/unit/web-editor-parity.spec.ts` the block move, E18 and the write observer the editor's undo is built on |
| `js/store.js` (D-191, P2d) | `ListReview`: the suggested grade, a line card (ordinal -2 on the answer line) paused on the first miss, unpaused on the second, retired on Good or Easy, each step undone with its grade; `replaceLineText` (a replaced block keeps its id, card and schedule); a cut row revived with the card, picture and region rows whose `deleted_at` is its own, a live id pasted as a fresh copy, a table with its rows, a picture as its own copy; column widths (`w`), a table's text size (`ts`), a picture's `display_width` and `crop` (C-26's refusal) | `test/unit/web-list-review.spec.ts` (FlashcardModelTests), `test/unit/web-find-paste.spec.ts` (BlockKindTests' P2d cases), `test/unit/web-canvas-geometry.spec.ts` |
| `js/geometry.js` | `TableBlock.fit`, `hasStoredWidths`, the 44pt floor and the 7pt column edge; `CanvasImageResize` (96pt to the measure, any corner); `MediaCrop` (parse, text, clamp, place and unplace, `keepsWhole`), `CanvasImageCrop.adjusted`, `CropCopy.wouldHide`; `CanvasPageLayout` (A4 at 680pt is 1024pt and a 28pt gutter, push, gutters) | `test/unit/web-canvas-geometry.spec.ts` (PictureEditTests, AnswerLeakTests, CanvasPageLayoutTests) |
| `js/find.js` | `CanvasFind` (the stored text, a marker never reached, `{{img:}}` masked, no overlap, whole word, runs through `mapped`) and `CanvasDocument.replaceAll` (a line break refused whole, a TAB or `::` refused in a cell by count, the notice) | `test/unit/web-find-paste.spec.ts` (CanvasFindTests) |
| `js/clip.js` | `DocsDocument.markdownLine`, `ClipboardBlocks` (the payload beside the plain text, `usable` with one trailing newline), and where a paste's lines land | `test/unit/web-find-paste.spec.ts` (ClipboardRoundTripTests) |

A grade writes the card's new state and one append-only `grade_event` with
this browser's device id. Undo restores the card; its event is discarded only
if it was never pushed, because the lane is append-only (the Mac's undo
cannot retract a remote grade either); a pushed one leaves this browser's
stats, as `cf_dismissed_events` does in the app.

The review of 2026-09-26 bound these rules on a line:

| Rule | Detail |
| --- | --- |
| A marker is a kind only when TYPED | Stored text is prefix free, so a heading titled `1. Intro` or a quote `# install` keeps its kind and its words; a marker declares a kind only when the stored line did not already open with it (web-2, Ink 18 R7) |
| An untouched line is never written | The editor remembers the text and runs it painted; leaving a line that still shows them writes nothing, its card included (web-5) |
| An unseen revision is not a base | A line changed while another device's revision landed under it goes out on the seq it SHOWED, so the backend records a conflict and that device keeps a version (landmine 249); a pulled revision a dirty row did not take never raises its `base_seq` (landmine 250) (web-3) |
| A normal row with `::` in a cell is a card | `CanvasBlock.rowGates`: a body row whose `::` splits it cleanly stores a front and a back (`std::vector` in a cell stores `std` and `vector<TAB>...`), reads back whole as `front::back`, keeps its style runs through the gate's spacing and its card through an edit; a header, a split that would join two cells, or an edit that loses the gate retires the card; the card dot sits inside the first cell, as the read view draws it |
| A card table row is split at its `::` | A header stored as one front `Term::Meaning` draws as two cells and saves back unchanged; the table's derived text is TAB separated as the app's `plainText` (web-1) |

An edit maps the line's style runs through the change and writes `spans` with
the new text's fingerprint (landmines 67 and 68); the format bar writes runs
the same way.

## Live, offline and the model

| Piece | How it works |
| --- | --- |
| Live | The WebSocket at `/v1/sync` (the token as a subprotocol) brings other devices' rows in as they land; pushes stay `POST /v1/push`; the 20 s HTTP poll runs only while the socket is down |
| Offline copy | IndexedDB `recall-web` keeps every pulled row, the watermark, kept versions and picture bytes; a reload with no network draws the library from it |
| Outbox | A row written here stays dirty in IndexedDB until the push acknowledges it, so an edit or grade made offline survives a closed tab and is pushed on reconnect with the same LWW (a millisecond tie goes to the server, landmine 83); a picture added offline waits there too, and only a refusal that will never change drops it. A batch is at most 500 ops and under the 1 MiB body; a line typed less than 700 ms before the tab closes or hides is saved first |
| Banner | "Offline: Edits and grades wait in this browser and send when it reconnects." |
| Kept versions | A pulled row, or a resync, that replaces a line edited here keeps this browser's text, as Recall's `note_version` does; local only |
| Shell | `sw.js` caches the page's own files network first so a reload opens offline; it never caches `/v1/` |
| Make Cards and the quiz | `POST /v1/ai` sends the app's own prompt to OpenRouter with the `OPENROUTER_KEY` Worker secret; the key never reaches the browser. Without it Make Cards says so in one sentence and the quiz is built from the doc's cards |
| Signing out | Erases the token and the whole offline copy, after saying how many changes are unsent. A credential the backend stops recognising (not a revocation) forgets the token only: the copy and its unsent changes stay for the next pairing |

## Security

| Layer | What holds it |
| --- | --- |
| `assets/_headers` | CSP `default-src 'none'`, scripts, styles, fonts and connections from `'self'` only, images also `data:` and `blob:`, no framing, no referrer, HSTS, nosniff |
| No inline code | `tools/check-assets.ts` refuses an inline script, an inline handler, a `javascript:` URL, a third-party origin or an HTML string sink before any deploy; styles set from script go through the CSSOM, never a `style` attribute |
| Rendering | Every note-derived value reaches the DOM through `textContent` or `setAttribute` on elements built node by node; drawings are SVG built node by node; a drawing's embedded picture must be base64 |
| Formulas | KaTeX 0.16.11 is vendored under `assets/vendor/katex` (the copy Recall bundles, byte for byte) with `trust: false`; a formula KaTeX refuses is drawn as its source; `?fixture=injection` proves a `\href{javascript:...}` draws no link |
| Stored XSS | `?fixture=injection` puts hostile text in every field the renderer reads; the check is that it draws as text, adds no script, iframe, handler or `javascript:` URL, and logs no CSP violation |
| Revocation | Removing the browser from Recall's device list cuts it off; a share link is read only and never pushes |

## Caching and versions

HTML, JS and CSS are `Cache-Control: no-cache` (revalidated by ETag, so a new
deploy is picked up on the next load); KaTeX's files are immutable, and `sw.js` keeps its woff2 faces for offline. On load
the page asks `/v1/version` and refuses a backend outside protocol 1, naming
which side is older, and `/v1/hello` refuses to write when this machine's
clock is more than 60 s off the server's.

## Known limits

A formula is drawn by KaTeX, never turned into Recall's rendered picture (Render LaTeX and Unlatex stay Recall's); a formula in a cloze line or a table cell stays text, as on the canvas; a copy of part of a line leaves as plain text, so it carries no style into a line or a cell (a whole line or block set carries its payload, P2d); page breaks move whole blocks where the app moves line fragments; an added font draws
for a paired browser only and Calibri is never served (landmine 195); SF
Symbols draw the mark; table wrapping is the browser's; spelling is the
browser's own checker; PDF is the browser's print. A snapshot restores into
Recall through its own Restore, never from the web. An
existing share link cannot be copied again later, because the backend keeps
only a hash of its token. Make a new link instead.
