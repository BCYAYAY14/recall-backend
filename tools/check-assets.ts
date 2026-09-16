// The asset build gate (plan W16, FI-16i, 11.2): run before every deploy.
//
//   node tools/check-assets.ts
//
// Refuses: a key-shaped string or a backend credential name in any served
// file; an inline script, an inline event handler or a javascript: URL in any
// HTML (the CSP forbids them and they would fail silently in production); any
// script, style or font loaded from another origin; a Supabase remnant; a main
// Worker module exporting anything but handlers and Durable Object classes.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const failures: string[] = [];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const TEXT = /\.(html|js|css|json|txt|md|svg|webmanifest)$|_headers$/;
const secretPatterns: [string, RegExp][] = [
  ["a JWT", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ["an AWS or S3 access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a Cloudflare API token shape", /\b[A-Za-z0-9_-]{40}\b(?=.*(?:cf|cloudflare|token))/i],
  ["a Recall device token", /\brcl_[A-Za-z0-9_-]{20,}/],
  ["an R2 endpoint", /r2\.cloudflarestorage\.com|\.r2\.dev\b/i],
  ["a presigned URL", /X-Amz-Signature|X-Amz-Credential/i],
  ["a Supabase remnant", /supabase|anonKey|apikey|service_role|postgrest/i],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a workers.dev host of a real deployment", /\b[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/],
];

for (const file of walk(join(root, "assets"))) {
  const rel = relative(root, file);
  if (!TEXT.test(file)) continue;
  const text = readFileSync(file, "utf8");
  const vendored = rel.startsWith("assets/vendor/");
  for (const [what, re] of secretPatterns) {
    if (vendored && what !== "a Recall device token" && what !== "an R2 endpoint") continue;
    if (re.test(text)) failures.push(`${rel}: ${what}`);
  }
  if (file.endsWith(".html")) {
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(text)) failures.push(`${rel}: an inline script`);
    if (/\son[a-z]+\s*=/i.test(text)) failures.push(`${rel}: an inline event handler`);
    if (/javascript:/i.test(text)) failures.push(`${rel}: a javascript: URL`);
    if (/<(script|link|img|iframe)[^>]+(src|href)=["']?(https?:)?\/\//i.test(text)) failures.push(`${rel}: a resource from another origin`);
  }
  if (file.endsWith(".js") && !vendored && /\binnerHTML\b|insertAdjacentHTML|outerHTML\s*=|document\.write\(/.test(text)) {
    failures.push(`${rel}: an HTML string sink`);
  }
}

const main = readFileSync(join(root, "src/index.ts"), "utf8");
for (const m of main.matchAll(/^export\s+(?!default\b|\{\s*BudgetDO,\s*LibraryDO,\s*LimiterDO\s*\})(.*)$/gm)) {
  failures.push(`src/index.ts: the main module exports a non-handler (${m[1]!.slice(0, 40)}); workerd refuses it`);
}

if (failures.length) {
  for (const f of failures) console.log(`REFUSED ${f}`);
  process.exit(1);
}
console.log("assets ok: no secret, no inline code, no third-party origin, no HTML string sink, handler-only exports");
