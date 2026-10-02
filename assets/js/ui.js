// The drawing primitives every page shares, as Ink 17 draws them: the
// eyebrow, the chip, the chrome block of rows, the 26pt tile with the doc
// mark or the folder glyph, the mastery stripe and its legend, the week bars,
// the sheet with its one title bar, and the banner. Every value reaches the
// DOM through textContent or setAttribute on nodes built one by one.

const UI = (() => {

  const NS = "http://www.w3.org/2000/svg";

  // h("div.class.other", { attr: v, onclick: fn, dataset: {} }, ...children)
  function h(spec, props, ...children) {
    const [tag, ...classes] = spec.split(".");
    const node = document.createElement(tag || "div");
    if (classes.length) node.className = classes.join(" ");
    if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) {
      children.unshift(props);
      props = null;
    }
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "text") node.textContent = v;
      else if (k === "dataset") Object.assign(node.dataset, v);
      // Through the CSSOM: the CSP forbids a style ATTRIBUTE ('self' only),
      // and a property set on `style` is not one.
      else if (k === "style") node.style.cssText = v;
      else if (k.startsWith("on")) { if (typeof v === "function") node.addEventListener(k.slice(2), v); }
      else if (k === "className") node.className += (node.className ? " " : "") + v;
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    append(node, children);
    return node;
  }

  function append(node, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function svg(tag, attrs = {}) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }

  function clear(node) { node.textContent = ""; return node; }

  const eyebrow = (text, trailing) => h("div.section-head", h("span.eyebrow", { text }),
    trailing != null ? (trailing instanceof Node ? trailing : h("span.section-fact", { text: trailing })) : null);

  function chip(label, { on = false, onclick, title, className, key, disabled } = {}) {
    // A chip whose face is a glyph or a number ("⋯", "2") is NAMED by its
    // title, or a screen reader reads the glyph (D-154).
    const named = title && typeof label === "string" && !/\p{L}/u.test(label) ? title : null;
    const b = h("button.chip", { type: "button", title, "aria-label": named, onclick, className, "aria-pressed": on ? "true" : null, disabled });
    if (on) b.classList.add("on");
    append(b, [label]);
    if (key) b.appendChild(h("span.keycap", { text: key }));
    return b;
  }

  // The primary action at control size: 28pt, the accent, radius 8.
  function control(label, { onclick, disabled, className, title } = {}) {
    return h("button.control", { type: "button", onclick, disabled, className, title, text: label });
  }

  // DotAndBarMark: the one mark a doc draws (ruling I10).
  function docMark(size = 16) {
    const s = svg("svg", { viewBox: "0 0 20 20", width: size, height: size, "aria-hidden": "true" });
    const rowH = 2.7, gap = 2.7, dot = 2.7, bar = 9, barH = 2.25, space = 1.8;
    const x0 = (20 - (dot + space + bar)) / 2;
    let y = (20 - (3 * rowH + 2 * gap)) / 2;
    for (const opacity of [1, 0.66, 0.38]) {
      s.appendChild(svg("circle", { cx: x0 + dot / 2, cy: y + rowH / 2, r: dot / 2, fill: "currentColor", opacity }));
      s.appendChild(svg("rect", { x: x0 + dot + space, y: y + (rowH - barH) / 2, width: bar, height: barH,
                                  rx: barH / 2, fill: "currentColor", opacity }));
      y += rowH + gap;
    }
    return s;
  }

  // FolderGlyph.
  function folderGlyph(size = 14) {
    const s = svg("svg", { viewBox: "0 0 16 16", width: size, height: size, "aria-hidden": "true" });
    s.appendChild(svg("path", { d: "M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h2.6l1.5 1.5h5.4a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H3.25a1.5 1.5 0 0 1-1.5-1.5z",
                                fill: "none", stroke: "currentColor", "stroke-width": "1.4" }));
    return s;
  }

  // Small line icons for the chrome, drawn, never an emoji.
  const ICONS = {
    today: "M3 6.5h14M5.5 3v3M14.5 3v3M4 4.5h12a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z",
    cards: "M4 5h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM6 3h8",
    chart: "M4 16V9M8.5 16V5M13 16v-5M17 16V3",
    gear: "M10 7.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4",
    docs: "M5 4h10M5 8h10M5 12h10M5 16h6",
    search: "M8.5 3.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12.2 12.2l4.3 4.3",
    plus: "M10 4v12M4 10h12",
    back: "M12.5 4l-6 6 6 6",
    chev: "M7.5 4l6 6-6 6",
    mode: "M10 3a7 7 0 1 0 0 14V3z",
    trash: "M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10",
    card: "M3 5.5h14v9H3zM6.5 10h6M10.5 8l2 2-2 2",
    draw: "M4 16l1-3.5L13.5 4a1.4 1.4 0 0 1 2 2L7 14.5zM12 5.5l2.5 2.5",
    picture: "M3.5 4.5h13v11h-13zM3.5 13l4-4 3 3 2-2 4 4M12.5 7.5h.5",
    diagram: "M3.5 4.5h13v11h-13zM6 8.5h4M9 12h5M6 8.5l3 3.5",
    clearfmt: "M5 5h9M9.5 5l-3 10M12 12l4 4M16 12l-4 4",
  };

  function icon(name, size = 16) {
    const s = svg("svg", { viewBox: "0 0 20 20", width: size, height: size, "aria-hidden": "true", class: "icon" });
    const d = ICONS[name];
    if (name === "mode") {
      s.appendChild(svg("circle", { cx: 10, cy: 10, r: 7, fill: "none", stroke: "currentColor", "stroke-width": 1.5 }));
      s.appendChild(svg("path", { d, fill: "currentColor" }));
      return s;
    }
    s.appendChild(svg("path", { d, fill: "none", stroke: "currentColor", "stroke-width": 1.6,
                                "stroke-linecap": "round", "stroke-linejoin": "round" }));
    return s;
  }

  function tile(child) { return h("span.tile", child); }

  // A row of a chrome block: tile, name over meta, a value, the chevron.
  function listRow({ tileNode, name, meta, value, chevron = true, onclick, extra, selected, dataset }) {
    const row = h(onclick ? "button.list-row" : "div.list-row", { type: onclick ? "button" : null, onclick, dataset });
    if (selected) row.classList.add("selected");
    if (tileNode) row.appendChild(tileNode);
    const body = h("span.list-body", h("span.list-name", { text: name }));
    if (meta) body.appendChild(h("span.list-meta", { text: meta }));
    if (extra) body.appendChild(extra);
    row.appendChild(body);
    if (value != null) row.appendChild(value instanceof Node ? value : h("span.list-value", { text: value }));
    if (chevron) row.appendChild(h("span.chev", icon("chev", 12)));
    return row;
  }

  const block = (...rows) => h("div.block", ...rows);

  // Mastery: Solid (good), Shaky (hard), Due (accent), New (hairline strong).
  function stripe(m, height = 10) {
    const s = h("div.stripe", { style: `height:${height}px` });
    const parts = [["solid", m.solid], ["shaky", m.shaky], ["due", m.due], ["new", m.newCards]];
    const total = parts.reduce((a, [, n]) => a + n, 0);
    if (!total) { s.appendChild(h("i.seg-new", { style: "flex:1" })); return s; }
    for (const [k, n] of parts) if (n > 0) s.appendChild(h("i.seg-" + k, { style: `flex:${n}` }));
    return s;
  }

  function legend(m) {
    return h("div.legend",
      [["solid", "Solid", m.solid], ["shaky", "Shaky", m.shaky], ["due", "Due", m.due], ["new", "New", m.newCards]]
        .map(([k, label, n]) => h("span", h("i.seg-" + k), `${label} ${n}`)));
  }

  // Week bars with the count above, a baseline, today in the accent.
  function bars(series, height = 62, labelOf) {
    const max = Math.max(1, ...series.map(s => s.count));
    const wrap = h("div.bars", { style: `height:${height + 32}px` });
    series.forEach((s, i) => {
      const col = h("div.bar-col");
      col.appendChild(h("em", { text: s.count ? String(s.count) : "" }));
      const b = h("b", { style: `height:${s.count ? Math.max(4, Math.round(s.count / max * height)) : 2}px` });
      if (i === 0) b.classList.add("today");
      else if (!s.count) b.classList.add("zero");
      col.appendChild(b);
      col.appendChild(h("span", { text: labelOf(s, i) }));
      wrap.appendChild(col);
    });
    return wrap;
  }

  // ----------------------------------------------------------------- sheets

  let openSheet = null;

  // One title bar: the left action (or blank), the title, the right action.
  // A modal dialog for a keyboard and a screen reader too: named by its
  // title, focus moved into it (the first field, else the first control),
  // Tab kept inside it, Escape the left action, and focus given back to
  // what held it on close (review 2026-09-26, web-18).
  const FOCUSABLE = "input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex='-1']), [contenteditable='true']";
  let sheetSerial = 0;

  function sheet({ title, left, right, onRight, onLeft, body, width = 460, rightDisabled = false, onClose }) {
    closeSheet();
    const returnTo = document.activeElement;
    const layer = h("div.sheet-layer");
    const cancel = () => { if (onLeft) onLeft(); closeSheet(); };
    const scrim = h("div.scrim", { onclick: cancel });
    const titleId = `sheet-title-${++sheetSerial}`;
    const panel = h("div.sheet", { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1",
                                   style: `width:min(${width}px, calc(100vw - 24px))` });
    const leftBtn = left ? h("button.bar-left", { type: "button", text: left, onclick: cancel }) : h("span.bar-left");
    const rightBtn = right ? h("button.bar-right", { type: "button", text: right, disabled: rightDisabled,
      onclick: async () => { if (onRight && (await onRight()) === false) return; closeSheet(); } }) : h("span.bar-right");
    panel.append(h("div.sheet-bar", leftBtn, h("span.bar-title", { id: titleId, text: title }), rightBtn), h("div.sheet-body", body));
    panel.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); cancel(); return; }
      if (event.key !== "Tab") return;
      const items = [...panel.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) { event.preventDefault(); panel.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    layer.append(scrim, panel);
    document.body.appendChild(layer);
    openSheet = { layer, onClose, rightBtn, returnTo };
    const field = panel.querySelector("input, textarea, select");
    const target = field || panel.querySelector(".sheet-body " + FOCUSABLE.split(", ").join(", .sheet-body ")) || leftBtn;
    setTimeout(() => { if (openSheet && openSheet.layer === layer) (target instanceof HTMLElement && target.focus ? target : panel).focus(); }, 30);
    return openSheet;
  }

  function closeSheet() {
    if (!openSheet) return;
    const s = openSheet;
    openSheet = null;
    s.layer.remove();
    if (s.onClose) s.onClose();
    if (!openSheet && s.returnTo && s.returnTo.isConnected && typeof s.returnTo.focus === "function") s.returnTo.focus();
  }

  function sheetOpen() { return !!openSheet; }

  // SheetGroup: an eyebrow over a chrome block, a help line under it.
  function group(title, rows, help) {
    return h("div.group", title ? h("div.eyebrow.group-eyebrow", { text: title }) : null,
      h("div.block", rows), help ? h("p.help", { text: help }) : null);
  }

  function valueRow(label, value, { onclick, danger, sub } = {}) {
    const row = h(onclick ? "button.value-row" : "div.value-row", { type: onclick ? "button" : null, onclick });
    const l = h("span.value-label", { text: label });
    if (danger) row.classList.add("danger");
    row.appendChild(sub ? h("span.value-stack", l, h("span.value-sub", { text: sub })) : l);
    if (value != null) row.appendChild(value instanceof Node ? value : h("span.value", { text: value }));
    if (onclick && !danger) row.appendChild(h("span.chev", icon("chev", 12)));
    return row;
  }

  // A stepper that draws its number as text (`FontSizeStepper`).
  function stepper(value, { min, max, step = 1, format = v => String(v), onchange }) {
    let v = value;
    const out = h("span.stepper");
    const label = h("span.stepper-value", { text: format(v) });
    const set = next => {
      v = Math.min(max, Math.max(min, next));
      label.textContent = format(v);
      onchange(v);
    };
    out.append(h("button.step", { type: "button", text: "−", "aria-label": "Less", onclick: () => set(v - step) }), label,
               h("button.step", { type: "button", text: "+", "aria-label": "More", onclick: () => set(v + step) }));
    return out;
  }

  function toggle(on, onchange, labelText) {
    const b = h("button.switch", { type: "button", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": labelText });
    if (on) b.classList.add("on");
    b.addEventListener("click", () => {
      const next = !b.classList.contains("on");
      b.classList.toggle("on", next);
      b.setAttribute("aria-checked", next ? "true" : "false");
      onchange(next);
    });
    return b;
  }

  // ---------------------------------------------------------------- banner

  // One sentence of at most two lines on the float rung: glyph, "Source:
  // message", one action, dismiss (AM-20).
  function banner(stack, { id, source, message, action, onAction }) {
    let node = stack.querySelector(`[data-banner="${id}"]`);
    if (!message) { if (node) node.remove(); return; }
    if (!node) {
      node = h("div.banner", { dataset: { banner: id } });
      stack.appendChild(node);
    }
    clear(node);
    append(node, [h("span.banner-glyph", { text: "●" }),
      h("span.banner-text", h("b", { text: source + ": " }), message),
      action ? chip(action, { onclick: onAction }) : null,
      h("button.banner-close", { type: "button", "aria-label": "Dismiss", text: "×", onclick: () => node.remove() })]);
  }

  // "edited 6:40", "edited yesterday", "edited 3 Sep".
  function edited(ms, now = Date.now()) {
    if (!ms) return null;
    const d = new Date(ms);
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const day = new Date(ms); day.setHours(0, 0, 0, 0);
    const diff = Math.round((today - day) / 86400000);
    if (diff === 0) return "edited " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "");
    if (diff === 1) return "edited yesterday";
    return "edited " + d.toLocaleDateString([], { day: "numeric", month: "short" });
  }

  function ago(ms, now = Date.now()) {
    const s = Math.max(0, (now - ms) / 1000);
    if (s < 10) return "just now";
    if (s < 60) return `${Math.round(s)} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;

  return { h, append, svg, clear, eyebrow, chip, control, docMark, folderGlyph, icon, tile, listRow, block,
           stripe, legend, bars, sheet, closeSheet, sheetOpen, group, valueRow, stepper, toggle, banner,
           edited, ago, plural };
})();
