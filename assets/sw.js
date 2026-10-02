// The app shell, kept for offline (PLAN-BETA-0.12 section 26, W-8).
//
// NETWORK FIRST: online, every file comes from the backend as it is now and
// the copy here is refreshed; offline, the last copy answers, so a paired
// browser can reopen the page and read, edit and grade from its IndexedDB
// copy (js/local.js) while its outbox waits. Only this origin's static files
// are kept: nothing under /v1/ (the library, pictures, pairing) passes
// through here, and nothing kept is a credential.

const CACHE = "recall-shell-v1";
// KaTeX's faces (D-190), the woff2 each browser here reads first, so a
// formula opened offline draws in its own type.
const KATEX_FONTS = ["AMS-Regular", "Caligraphic-Bold", "Caligraphic-Regular", "Fraktur-Bold", "Fraktur-Regular",
  "Main-Bold", "Main-BoldItalic", "Main-Italic", "Main-Regular", "Math-BoldItalic", "Math-Italic", "SansSerif-Bold",
  "SansSerif-Italic", "SansSerif-Regular", "Script-Regular", "Size1-Regular", "Size2-Regular", "Size3-Regular",
  "Size4-Regular", "Typewriter-Regular"].map(f => `/vendor/katex/fonts/KaTeX_${f}.woff2`);
const SHELL = [
  "/", "/index.html", "/styles.css", "/icon.png",
  "/vendor/katex/katex.min.css", "/vendor/katex/katex.min.js", ...KATEX_FONTS,
  "/js/wire.js", "/js/order.js", "/js/fsrs.js", "/js/gate.js", "/js/cardline.js", "/js/spans.js", "/js/model.js", "/js/geometry.js", "/js/clip.js", "/js/drawing.js", "/js/local.js",
  "/js/backend.js", "/js/sched.js", "/js/store.js", "/js/media.js", "/js/render.js", "/js/pictures.js", "/js/ui.js", "/js/cardmenu.js",
  "/js/cards.js", "/js/study.js", "/js/words.js", "/js/upload.js", "/js/drawedit.js", "/js/occedit.js",
  "/js/find.js", "/js/editor.js", "/js/aitext.js", "/js/ai.js", "/js/io.js", "/js/palette.js", "/js/pages.js", "/js/fixture.js",
  "/js/app.js",
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One missing file must not leave the rest uncached.
    await Promise.all(SHELL.map(path => cache.add(new Request(path, { cache: "no-store" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/v1/")) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok && response.type === "basic") cache.put(request, response.clone()).catch(() => {});
      return response;
    } catch (error) {
      const kept = await cache.match(request, { ignoreSearch: true });
      if (kept) return kept;
      if (request.mode === "navigate") {
        const shell = (await cache.match("/index.html")) || (await cache.match("/"));
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
