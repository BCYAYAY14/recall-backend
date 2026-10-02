// D-011 on the web: a link is the sidecar's `l` kind, its value the
// destination, read and written as Sources/Core/InlineSpans.swift does
// (`LinkTarget`), and drawn by render.js as an anchor whose href is only
// ever a destination `Spans.linkHref` allows.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAssets } from "../support/web-assets.ts";

interface Run { start: number; end: number; kind: string; value?: string | null }
interface SpansModule {
  encode(runs: Run[], anchor: string): string | null;
  decode(json: string | null, anchor: string): Run[];
  normalize(runs: Run[], length?: number): Run[];
  mapped(runs: Run[], lo: number, removed: number, inserted: number): Run[];
  normalizedValue(kind: string, raw: unknown): string | null;
  linkTarget(raw: unknown): string | null;
  linkHref(raw: unknown): string | null;
  fingerprint(text: string): string;
  KINDS: string[];
}

// The few DOM calls render.js's inline path makes, recorded as a tree.
class FakeNode {
  children: FakeNode[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = "";
  href?: string;
  target?: string;
  rel?: string;
  text?: string;
  constructor(public tag: string) {}
  appendChild(child: FakeNode) { this.children.push(child); return child; }
  get classList() { return { add: (c: string) => { this.className += " " + c; } }; }
  set textContent(t: string) { this.children = [Object.assign(new FakeNode("#text"), { text: t })]; }
  get textContent(): string {
    return this.text ?? this.children.map(c => c.textContent).join("");
  }
}
const fakeDocument = {
  createElement: (tag: string) => new FakeNode(tag),
  createTextNode: (text: string) => Object.assign(new FakeNode("#text"), { text }),
  createDocumentFragment: () => new FakeNode("#fragment"),
  documentElement: { dataset: {} },
};
(globalThis as Record<string, unknown>).document = fakeDocument;
(globalThis as Record<string, unknown>).window = globalThis;

const { Spans, Render } = loadAssets<{
  Spans: SpansModule;
  Render: { styledText(text: string, runs: Run[], offset: number): FakeNode };
}>(["spans.js", "render.js"], ["Spans", "Render"]);

const link = (start: number, end: number, value = "https://example.com"): Run => ({ start, end, kind: "l", value });

function anchors(node: FakeNode): FakeNode[] {
  return (node.tag === "a" ? [node] : []).concat(...node.children.map(anchors));
}

describe("links in the sidecar (D-011)", () => {
  it("normalises a destination as LinkTarget does", () => {
    expect(Spans.KINDS).toContain("l");
    expect(Spans.linkTarget(" example.com ")).toBe("https://example.com");
    expect(Spans.linkTarget("mailto:a@b.org")).toBe("mailto:a@b.org");
    expect(Spans.linkTarget("https://en.wikipedia.org/wiki/Cell_(biology)"))
      .toBe("https://en.wikipedia.org/wiki/Cell_%28biology%29");
    for (const bad of ["javascript:alert(1)", "JavaScript:x", "DATA:text/html,x", "file:///etc", "two words", "", null]) {
      expect(Spans.linkTarget(bad)).toBeNull();
    }
    expect(Spans.normalizedValue("l", "example.com")).toBe("https://example.com");
  });

  it("stores the destination as the fourth element and reads it back", () => {
    const anchor = "see docs now";
    const json = Spans.encode([link(4, 8)], anchor);
    expect(JSON.parse(json!)).toEqual({ v: 1, n: 12, h: Spans.fingerprint(anchor), r: [[4, 8, "l", "https://example.com"]] });
    expect(Spans.decode(json, anchor)).toEqual([link(4, 8)]);
    // A link with no destination, or one no reader may open, is not a link.
    expect(Spans.normalize([{ start: 0, end: 2, kind: "l", value: null }])).toEqual([]);
    const refused = `{"v":1,"n":12,"h":"${Spans.fingerprint(anchor)}","r":[[4,8,"l","javascript:alert(1)"],[0,3,"b"]]}`;
    expect(Spans.decode(refused, anchor).map(r => r.kind)).toEqual(["b"]);
  });

  it("is not sticky right: the words typed after a link are not the link", () => {
    expect(Spans.mapped([link(0, 4)], 4, 0, 3)).toEqual([link(0, 4)]);
    expect(Spans.mapped([link(0, 4)], 2, 0, 3)).toEqual([link(0, 7)]);
    expect(Spans.mapped([{ start: 0, end: 4, kind: "b", value: null }], 4, 0, 3))
      .toEqual([{ start: 0, end: 7, kind: "b", value: null }]);
  });
});

describe("links in the renderer (D-011)", () => {
  it("draws an anchor over the link's words, in the text's ink, in a new tab", () => {
    const frag = Render.styledText("see docs now", [link(4, 8)], 0);
    const found = anchors(frag);
    expect(found).toHaveLength(1);
    const a = found[0]!;
    expect(a.textContent).toBe("docs");
    expect(a.href).toBe("https://example.com");
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
    expect(a.style.color).toBe("inherit");
    expect(frag.textContent).toBe("see docs now");
  });

  it("never draws a refused destination as an href", () => {
    const frag = Render.styledText("see docs", [{ start: 4, end: 8, kind: "l", value: "javascript:alert(1)" }], 0);
    expect(anchors(frag)).toHaveLength(0);
    expect(frag.textContent).toBe("see docs");
  });

  it("keeps a bold inside a link and two links apart", () => {
    const frag = Render.styledText("ab cd", [link(0, 2, "https://a.org"), link(3, 5, "https://b.org"),
                                            { start: 0, end: 5, kind: "b", value: null }], 0);
    expect(anchors(frag).map(a => a.href)).toEqual(["https://a.org", "https://b.org"]);
  });
});

// The editor's own DOM (editor.js `paint` and `read`), over a fake that
// keeps parents and walks text nodes, so a line can be painted, typed into
// and read back as the browser would hand it over.
class EditNode {
  children: EditNode[] = [];
  parentNode: EditNode | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  classes = new Set<string>();
  className = "";
  data?: string;
  constructor(public tag: string) {}
  appendChild(child: EditNode) { child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child: EditNode, ref: EditNode | null) {
    child.parentNode = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
    return child;
  }
  get classList() {
    return { add: (c: string) => { this.classes.add(c); }, contains: (c: string) => this.classes.has(c),
             remove: (c: string) => { this.classes.delete(c); }, toggle: () => false };
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener() {}
  set textContent(t: string) {
    this.children = [];
    if (t) this.appendChild(Object.assign(new EditNode("#text"), { data: t }));
  }
  get textContent(): string { return this.data ?? this.children.map(c => c.textContent).join(""); }
}
function textNodes(node: EditNode): EditNode[] {
  return (node.tag === "#text" ? [node] : []).concat(...node.children.map(textNodes));
}
const editDocument = {
  createElement: (tag: string) => new EditNode(tag),
  createTextNode: (data: string) => Object.assign(new EditNode("#text"), { data }),
  createDocumentFragment: () => new EditNode("#fragment"),
  createTreeWalker: (root: EditNode) => {
    const list = textNodes(root);
    let i = 0;
    return { nextNode: () => list[i++] ?? null };
  },
  documentElement: { dataset: {} },
};

function withEditDom<T>(run: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, Node: g.Node, NodeFilter: g.NodeFilter };
  g.document = editDocument;
  g.Node = EditNode;
  g.NodeFilter = { SHOW_TEXT: 4 };
  try { return run(); } finally { Object.assign(g, saved); }
}

const { Editor, Spans: EditSpans } = withEditDom(() => loadAssets<{
  Editor: { paint(el: EditNode, text: string, runs: Run[]): void; read(el: EditNode): { text: string; runs: Run[] } };
  Spans: SpansModule;
}>(["spans.js", "render.js", "ui.js", "editor.js"], ["Editor", "Spans"]));

describe("links in the editor (D-152, D-153)", () => {
  it("an edited line keeps a link's whole address", () => {
    withEditDom(() => {
      const addresses = ["https://example.com/search?q=a&b=c", "https://example.com/a|b", "https://example.com/p#frag=x",
                         "https://x.org/?a=1|2&b==3%28", "https://example.com/search?q=atp&lang=en"];
      for (const address of addresses) {
        // Stored as the Mac stores it, then painted, typed into and read back.
        const anchor = "see docs now";
        const stored = EditSpans.encode([link(4, 8, address), { start: 0, end: 3, kind: "b", value: null }], anchor);
        const el = new EditNode("div");
        Editor.paint(el, anchor, EditSpans.decode(stored, anchor));
        expect(Editor.read(el)).toEqual({ text: anchor, runs: EditSpans.decode(stored, anchor) });
        // Type " today" at the line's end and "s" inside the link.
        const pieces = textNodes(el);
        pieces[pieces.length - 1]!.data += " today";
        pieces.find(n => n.data === "docs")!.data = "docss";
        const edited = Editor.read(el);
        expect(edited.text).toBe("see docss now today");
        const again = EditSpans.decode(EditSpans.encode(edited.runs, edited.text), edited.text);
        expect(again.filter(r => r.kind === "l")).toEqual([link(4, 9, address)]);
        expect(again.filter(r => r.kind === "b")).toEqual([{ start: 0, end: 3, kind: "b", value: null }]);
      }
    });
  });

  it("the editor underlines a link", () => {
    withEditDom(() => {
      const el = new EditNode("div");
      Editor.paint(el, "see docs now", [link(4, 8, "https://example.com/?q=a")]);
      const spans = el.children.filter(c => c.tag !== "#text");
      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      // A span, never a live anchor: a click in the editor places the caret.
      expect(span.tag).toBe("span");
      expect(span.textContent).toBe("docs");
      expect(span.classes.has("sp-l")).toBe(true);
      expect(textNodes(el).map(n => n.data).join("")).toBe("see docs now");
    });
    // The class draws the read view's underline in the text's own ink.
    const css = readFileSync(path.join(import.meta.dirname, "..", "..", "assets", "styles.css"), "utf8");
    const rule = /\.sp-l\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/text-decoration:\s*underline/);
    expect(rule![1]).toMatch(/color:\s*inherit/);
  });
});

// Landmine 278: a link in the editor opens on Command-click (Control-click
// off a Mac), never on the click that places the caret; the address is the
// run's own, through `Spans.linkHref`, so a refused scheme opens nothing.
describe("a link opens on Command-click in the editor (landmine 278)", () => {
  const press = (over: Record<string, unknown>) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over });
  const E = Editor as unknown as { opensLink(e: unknown, mac: boolean): boolean; linkHrefAt(n: unknown, within: unknown): string | null };

  it("Command on a Mac, Control elsewhere; a plain click, Shift, Option or another button places the caret", () => {
    expect(E.opensLink(press({ metaKey: true }), true)).toBe(true);
    expect(E.opensLink(press({ ctrlKey: true }), true), "Control-click is the Mac's context menu").toBe(false);
    expect(E.opensLink(press({}), true)).toBe(false);
    expect(E.opensLink(press({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(E.opensLink(press({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(E.opensLink(press({ metaKey: true, button: 1 }), true)).toBe(false);
    expect(E.opensLink(press({ ctrlKey: true }), false)).toBe(true);
    expect(E.opensLink(press({ metaKey: true }), false)).toBe(false);
  });

  it("the address is the painted run's, a word outside a link has none, and a refused scheme opens nothing", () => {
    withEditDom(() => {
      const el = new EditNode("div");
      Editor.paint(el, "see docs now", [link(4, 8, "https://example.com/?q=a"), { start: 9, end: 12, kind: "b", value: null }]);
      // The browser's tree answers these; the fake is given them here.
      const walk = (n: EditNode) => {
        Object.defineProperty(n, "nodeType", { value: n.tag === "#text" ? 3 : 1 });
        Object.defineProperty(n, "parentElement", { get: () => n.parentNode });
        n.children.forEach(walk);
      };
      walk(el);
      const pieces = textNodes(el);
      expect(E.linkHrefAt(pieces.find(p => p.data === "docs"), el)).toBe("https://example.com/?q=a");
      expect(E.linkHrefAt(pieces.find(p => p.data === "now"), el), "bold is no link").toBeNull();
      expect(E.linkHrefAt(pieces.find(p => p.data === "see "), el)).toBeNull();
      const bad = new EditNode("span");
      bad.dataset.k = "l=" + encodeURIComponent("javascript:alert(1)");
      const t = Object.assign(new EditNode("#text"), { data: "x" });
      bad.appendChild(t);
      walk(bad);
      expect(E.linkHrefAt(t, null)).toBeNull();
    });
  });
});
