// wrangler.attachments.jsonc is wrangler.jsonc plus ONE R2 binding and nothing
// else (plan 36.7): a drift here would make the attachments deployment a
// different Worker from the one the notes-only deployment proves.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function jsonc(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf8").split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "")).join("\n");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("the attachments configuration", () => {
  const notes = jsonc("wrangler.jsonc");
  const files = jsonc("wrangler.attachments.jsonc");

  it("is the notes-only Worker plus the MEDIA bucket", () => {
    const { env: _env, ...notesTop } = notes;
    const { r2_buckets, ...filesTop } = files;
    expect(filesTop).toEqual(notesTop);
    expect(r2_buckets).toEqual([{ binding: "MEDIA", bucket_name: "recall-media" }]);
  });

  it("leaves the notes-only configuration without any bucket", () => {
    expect(notes.r2_buckets).toBeUndefined();
    expect(JSON.stringify(notes)).not.toContain("r2_buckets");
  });
});
