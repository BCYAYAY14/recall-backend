// D-191: THE ARROW'S MENU AND A BLANK'S MENU, as Recall draws them
// (`CardChipMenu` and `ClozeBlankMenu` in Sources/UI/CardChipMenu.swift; the
// drawing is design/mockups-cards-2026-09-28.html, "The arrow's menu" and "A
// blank's menu"). A popover on the float rung under what was clicked, built
// node by node. The editor owns every change (`apply` answers the state after
// it, or null when the change was refused, which leaves the menu as it was);
// this file only draws and routes.

const CardMenu = (() => {

  const { h, clear } = UI;
  let current = null;     // { panel, key, place, outside, onClose }
  let closedBy = null;    // { event, key }: the press that closed a menu

  function close() {
    if (!current) return;
    const c = current;
    current = null;
    document.removeEventListener("mousedown", c.outside, true);
    window.removeEventListener("scroll", c.place, true);
    window.removeEventListener("resize", c.place);
    c.panel.remove();
    if (c.onClose) c.onClose();
  }

  // True when `event` is the press that just closed the menu `key` (a second
  // press on the chip that opened it closes it and opens nothing).
  const justClosed = (event, key) => !!closedBy && closedBy.event === event && closedBy.key === key;

  const isOpen = key => !!current && (key == null || current.key === key);

  // The popover: under the anchor, above it when there is no room below,
  // kept inside the window, and following it as the page scrolls. `anchor`
  // is a function, because the editor redraws the line the menu belongs to.
  function popover({ key, label, width, anchor, onClose, build }) {
    close();
    const panel = h("div.pop", { role: "dialog", "aria-label": label, tabindex: "-1" });
    panel.style.width = width + "px";
    const place = () => {
      const a = anchor();
      if (!a || !a.isConnected) return;
      const rects = a.getClientRects();
      const r = rects.length ? rects[rects.length - 1] : a.getBoundingClientRect();
      const pw = panel.offsetWidth, ph = panel.offsetHeight;
      const left = Math.max(8, Math.min(r.left + r.width / 2 - pw / 2, window.innerWidth - pw - 8));
      let top = r.bottom + 6;
      if (top + ph > window.innerHeight - 8 && r.top - ph - 6 > 8) top = r.top - ph - 6;
      panel.style.left = Math.round(left) + "px";
      panel.style.top = Math.round(top) + "px";
    };
    const outside = event => {
      if (panel.contains(event.target)) return;
      closedBy = { event, key };
      close();
    };
    current = { panel, key, place, outside, onClose };
    document.body.appendChild(panel);
    build(panel, place);
    place();
    document.addEventListener("mousedown", outside, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    panel.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    });
    panel.focus({ preventScroll: true });
  }

  const eyebrow = text => h("div.pop-sec", { text });

  // The mockup's `.seg`: a raised track, the chosen segment on the float
  // rung, a disabled one at the tertiary ink. A press on the chosen one does
  // nothing (`ChipSegments`).
  function segments(name, options, selected, disabled, pick) {
    const row = h("div.pop-seg", { role: "radiogroup", "aria-label": name });
    for (const [title, value] of options) {
      const on = value === selected;
      const off = disabled.includes(value);
      const b = h("button", { type: "button", role: "radio", "aria-checked": on ? "true" : "false", disabled: off,
                              dataset: { key: name + ":" + String(value) }, text: title });
      if (on) b.classList.add("on");
      b.addEventListener("click", () => { if (!on && !off) pick(value); });
      row.appendChild(b);
    }
    return row;
  }

  // Redraws a panel and gives the focus back to the control that had it.
  function redraw(panel, fill, place) {
    const had = document.activeElement && panel.contains(document.activeElement) && document.activeElement.dataset
      ? document.activeElement.dataset.key : null;
    clear(panel);
    fill();
    place();
    const again = had && [...panel.querySelectorAll("[data-key]")].find(el => el.dataset.key === had);
    if (again && !again.disabled) again.focus({ preventScroll: true });
    else if (document.activeElement === document.body) panel.focus({ preventScroll: true });
  }

  // THE ARROW'S MENU: Type, Asks and Answer as three segmented rows, Card
  // on, Preview card (⌘↩, the card's front and back inline), Card info.
  // `state` is `CardLine.state`; `preview()` answers `{ front, back }` or
  // null; `cardInfo(id)` opens the card's sheet.
  function chip({ key, anchor, state, apply, preview, cardInfo, onClose }) {
    let st = state;
    let previewing = null;
    popover({ key, label: "Card", width: 260, anchor, onClose, build: (panel, place) => {
      const change = c => {
        const next = apply(c);
        if (next) { st = next; if (previewing) previewing = preview(); }
        redraw(panel, fill, place);
      };
      const togglePreview = () => {
        if (!st.cardId) return;
        previewing = previewing ? null : preview();
        redraw(panel, fill, place);
      };
      const fill = () => {
        const on = UI.toggle(st.on, v => change({ on: v }), "Card on");
        on.dataset.key = "on";
        const peek = h("button.pop-item", { type: "button", disabled: !st.cardId, dataset: { key: "preview" },
                                            "aria-expanded": previewing ? "true" : "false", onclick: togglePreview },
          h("span", { text: "Preview card" }), h("span.pop-key", { text: "⌘↩" }));
        const info = h("button.pop-item", { type: "button", disabled: !st.cardId, dataset: { key: "info" },
                                            onclick: () => { const id = st.cardId; if (!id) return; close(); cardInfo(id); } },
          h("span", { text: "Card info" }));
        UI.append(panel, [
          eyebrow("Type"),
          segments("Type", [["Basic", "basic"], ["Concept", "concept"], ["Descriptor", "descriptor"]], st.kind, [],
                   v => change({ kind: v })),
          eyebrow("Asks"),
          segments("Asks", [["Forward", "f"], ["Reverse", "r"], ["Both", "b"]], st.asks, [], v => change({ asks: v })),
          eyebrow("Answer"),
          segments("Answer", [["One line", "oneLine"], ["Set", "set"], ["In order", "ordered"]], st.answer,
                   st.hasAnswerLines ? ["oneLine"] : ["set", "ordered"], v => change({ answer: v })),
          h("div.pop-sep"),
          h("div.pop-item", h("span", { text: "Card on" }), on),
          peek,
          previewing ? h("div.pop-preview",
            h("div.pop-preview-q", { text: previewing.front }),
            previewing.back != null ? h("div.pop-preview-rule") : null,
            previewing.back != null ? h("div.pop-preview-a", { text: previewing.back }) : null) : null,
          info]);
      };
      fill();
      panel.addEventListener("keydown", event => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); togglePreview(); }
      });
    } });
  }

  // A BLANK'S MENU: This blank (Own card, With the others; With the others
  // only when the line has another blank), its Hint (committed on Return and
  // when the menu closes), and Remove blank.
  function blank({ key, anchor, state, apply, onClose }) {
    let st = state;
    let field = null;
    let removed = false;
    const commitHint = () => {
      if (removed || !field || field.value === st.hint) return;
      const next = apply({ hint: field.value });
      if (next) { st = next; field.value = next.hint; }
    };
    popover({ key, label: "Blank", width: 240, anchor,
              onClose: () => { commitHint(); if (onClose) onClose(); },
              build: (panel, place) => {
      const fill = () => {
        field = h("input.pop-field", { type: "text", placeholder: "None", "aria-label": "Hint", dataset: { key: "hint" },
                                       autocomplete: "off", spellcheck: "false" });
        field.value = st.hint;
        field.addEventListener("keydown", event => {
          if (event.key === "Enter") { event.preventDefault(); commitHint(); }
        });
        UI.append(panel, [
          eyebrow("This blank"),
          segments("This blank", [["Own card", true], ["With the others", false]], st.own, st.canJoin ? [] : [false],
                   own => {
                     const typed = field.value;
                     const next = apply({ own });
                     if (next) st = next;
                     redraw(panel, fill, place);
                     field.value = typed;
                   }),
          eyebrow("Hint"),
          field,
          h("div.pop-sep"),
          h("button.pop-item", { type: "button", dataset: { key: "remove" },
                                 onclick: () => { removed = true; apply({ remove: true }); close(); } },
            h("span", { text: "Remove blank" }))]);
      };
      fill();
    } });
  }

  return { chip, blank, close, isOpen, justClosed };
})();
