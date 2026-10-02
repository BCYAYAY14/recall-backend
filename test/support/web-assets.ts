// Loads the web app's plain script files (assets/js, no build step, each one
// an IIFE that defines one global) into a unit test, so the conformance
// suites run the EXACT bytes the browser runs.

import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..", "..", "assets", "js");

export function loadAssets<T>(files: string[], names: string[]): T {
  const src = files.map((f) => readFileSync(path.join(root, f), "utf8")).join("\n;\n");
  return new Function(`${src}\nreturn { ${names.join(", ")} };`)() as T;
}
