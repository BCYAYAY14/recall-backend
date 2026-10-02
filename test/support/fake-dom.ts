// A small DOM for the unit suites that build faces and bars node by node
// (the page never uses an HTML string, so a tree of elements is the whole
// of what these files touch): elements, text, fragments, classes, data
// attributes, style properties and click listeners.

export class FNode {
  children: FNode[] = [];
  parent: FNode | null = null;
  style: Record<string, string> & { setProperty?: (k: string, v: string) => void } = {};
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  className = "";
  data?: string;
  type?: string;
  disabled = false;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor(public tag: string) {
    const style = this.style;
    style.setProperty = (k: string, v: string) => { style[k] = v; };
  }
  appendChild(child: FNode) {
    if (child.tag === "#fragment") { for (const c of child.children) { c.parent = this; this.children.push(c); } child.children = []; }
    else { child.parent = this; this.children.push(child); }
    return child;
  }
  append(...kids: (FNode | string | null)[]) {
    for (const k of kids) if (k != null) this.appendChild(typeof k === "string" ? text(k) : k);
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(type: string, fn: (e: unknown) => void) { (this.listeners[type] ||= []).push(fn); }
  click() {
    const event = { type: "click", target: this, stopPropagation() { this.stopped = true; }, stopped: false,
                    preventDefault() {} } as { stopped: boolean; stopPropagation(): void; type: string; target: FNode; preventDefault(): void };
    for (let n: FNode | null = this; n && !event.stopped; n = n.parent) for (const fn of n.listeners.click || []) fn(event);
  }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (...cs: string[]) => { this.className = [...new Set([...names(), ...cs])].join(" "); },
      remove: (...cs: string[]) => { this.className = names().filter(c => !cs.includes(c)).join(" "); },
      toggle: (c: string, on?: boolean) => {
        const has = names().includes(c);
        const want = on === undefined ? !has : on;
        if (want && !has) this.className = [...names(), c].join(" ");
        if (!want && has) this.className = names().filter(x => x !== c).join(" ");
        return want;
      },
      contains: (c: string) => names().includes(c),
    };
  }
  set textContent(t: string) { this.children = t ? [text(t)] : []; }
  get textContent(): string { return this.data ?? this.children.map(c => c.textContent).join(""); }
}

export const text = (data: string) => Object.assign(new FNode("#text"), { data });

export const fakeDocument = {
  compatMode: "CSS1Compat",
  createElement: (tag: string) => new FNode(tag),
  createElementNS: (_ns: string, tag: string) => new FNode(tag),
  createTextNode: (data: string) => text(data),
  createDocumentFragment: () => new FNode("#fragment"),
  documentElement: { dataset: {} as Record<string, string> },
};

/** Every node under `n` (itself included) carrying class `cls`. */
export function find(n: FNode, cls: string): FNode[] {
  return (n.classList.contains(cls) ? [n] : []).concat(...n.children.map(c => find(c, cls)));
}

/** Installs the fake as the global document for the scripts a test loads. */
export function installFakeDom() {
  const g = globalThis as Record<string, unknown>;
  g.document = fakeDocument;
  if (!g.window) g.window = globalThis;
  return fakeDocument;
}
