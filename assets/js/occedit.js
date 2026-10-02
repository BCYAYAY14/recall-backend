// The occlusion editor (PLAN-BETA-0.12 section 26, W-7; Ink 17 section 6,
// "Edit Occlusion"): the prompt, Hide One or All, the picture with its
// regions as ink outlines under a light wash, each numbered with its label
// on a chip, and the region list beside it with a label field each. Drag on
// the picture to draw a region, drag a region to move it, drag its corner to
// resize it. Regions are normalised to the WHOLE image (landmine 103) and
// saved as the app saves them (Store.saveOcclusion: the desired live set,
// kept regions updated in place with their cards, new ones given the next
// ordinal and a fresh card).

const OccEdit = (() => {

  const { h, chip, clear } = UI;
  const MIN_SIDE = 0.01;

  // `source` is { noteId } for an existing diagram, { file } for a picture
  // chosen now, or { fromPicture: { noteId, mediaId, sha, mime } } to turn a
  // block picture into a diagram.
  function open({ docId, afterId, source, onSaved, onError }) {
    const L = Backend.library();
    let prompt = "";
    let mode = "one";
    let regions = [];            // { id?, x, y, w, h, label, z }
    let imageUrl = null;
    let upload = null;           // { sha, mime } once known
    const existingId = source.noteId && !source.fromPicture ? source.noteId : null;

    if (existingId) {
      const note = L.notes.get(existingId);
      prompt = note ? note.front || "" : "";
      mode = note && note.occ_mode === "all" ? "all" : "one";
      regions = L.occlusion.filter(o => o.note_id === existingId && o.deleted_at == null)
        .sort((a, b) => a.ordinal - b.ordinal)
        .map(o => ({ id: o.id, x: o.x, y: o.y, w: o.w, h: o.h, label: o.label || "", z: o.z || 0, ordinal: o.ordinal }));
    }

    const promptField = h("input.field", { type: "text", placeholder: "The question, for example: Label the parts of the eye",
                                            "aria-label": "Prompt", value: prompt });
    promptField.addEventListener("input", () => { prompt = promptField.value; });
    const modeBox = h("div.segmented.small");
    const stage = h("div.occ-stage");
    const list = h("div.block.occ-list");
    const status = h("p.help");

    function drawMode() {
      clear(modeBox);
      for (const [id, label] of [["one", "One"], ["all", "All"]]) {
        const b = h("button", { type: "button", text: label, "aria-pressed": mode === id ? "true" : "false" });
        if (mode === id) b.classList.add("on");
        b.addEventListener("click", () => { mode = id; drawMode(); });
        modeBox.appendChild(b);
      }
    }

    function drawStage() {
      clear(stage);
      if (!imageUrl) { stage.appendChild(Render.missing("Loading picture")); return; }
      const img = h("img.occ-image", { src: imageUrl, alt: "", draggable: "false" });
      const layer = h("div.occ-layer");
      regions.forEach((r, i) => layer.appendChild(regionBox(r, i)));
      const frame = h("div.occ-frame", img, layer);
      stage.appendChild(frame);
      wireStage(frame, layer);
    }

    // One region's outline, its number and label on a chip, its corner.
    function regionBox(r, i) {
      const box = h("div.occ-region", { dataset: { index: String(i) } });
      box.style.left = (r.x * 100) + "%";
      box.style.top = (r.y * 100) + "%";
      box.style.width = (r.w * 100) + "%";
      box.style.height = (r.h * 100) + "%";
      box.append(h("span.occ-chip", { text: `${i + 1}${r.label ? " " + r.label : ""}` }),
                 h("span.occ-handle", { dataset: { handle: "1" } }));
      return box;
    }

    function drawList() {
      clear(list);
      if (!regions.length) {
        list.appendChild(h("div.value-row", h("span.value-label.muted", { text: "Drag on the picture to draw a region." })));
        return;
      }
      regions.forEach((r, i) => {
        const field = h("input.field.inline", { type: "text", value: r.label, placeholder: "Label", "aria-label": `Region ${i + 1} label` });
        field.addEventListener("input", () => { r.label = field.value; drawStageLabels(); });
        const del = h("button.row-delete", { type: "button", text: "×", "aria-label": `Delete region ${i + 1}`,
          onclick: () => { regions.splice(i, 1); drawStage(); drawList(); } });
        list.appendChild(h("div.value-row.occ-row", h("span.occ-number", { text: String(i + 1) }), field, del));
      });
    }

    function drawStageLabels() {
      stage.querySelectorAll(".occ-region").forEach((box, i) => {
        const chipNode = box.querySelector(".occ-chip");
        if (chipNode && regions[i]) chipNode.textContent = `${i + 1}${regions[i].label ? " " + regions[i].label : ""}`;
      });
    }

    // The frame lives for the whole gesture (a rebuilt frame would drop
    // the pointer capture), so a new region's box joins its layer.
    function wireStage(frame, layer) {
      let g = null;
      const at = e => {
        const r = frame.getBoundingClientRect();
        return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
      };
      frame.addEventListener("pointerdown", e => {
        if (e.target.tagName === "INPUT") return;
        e.preventDefault();
        frame.setPointerCapture(e.pointerId);
        const p = at(e);
        const box = e.target.closest(".occ-region");
        if (box) {
          const i = Number(box.dataset.index);
          const r = regions[i];
          g = { kind: e.target.dataset.handle ? "resize" : "move", i, start: p, orig: { ...r } };
        } else {
          regions.push({ x: p.x, y: p.y, w: 0, h: 0, label: "", z: 0 });
          g = { kind: "draw", i: regions.length - 1, start: p };
          layer.appendChild(regionBox(regions[g.i], g.i));
        }
      });
      frame.addEventListener("pointermove", e => {
        if (!g) return;
        const p = at(e);
        const r = regions[g.i];
        if (g.kind === "draw") {
          r.x = Math.min(g.start.x, p.x); r.y = Math.min(g.start.y, p.y);
          r.w = Math.abs(p.x - g.start.x); r.h = Math.abs(p.y - g.start.y);
        } else if (g.kind === "move") {
          r.x = Math.min(1 - g.orig.w, Math.max(0, g.orig.x + p.x - g.start.x));
          r.y = Math.min(1 - g.orig.h, Math.max(0, g.orig.y + p.y - g.start.y));
        } else {
          r.w = Math.max(MIN_SIDE, Math.min(1 - g.orig.x, g.orig.w + p.x - g.start.x));
          r.h = Math.max(MIN_SIDE, Math.min(1 - g.orig.y, g.orig.h + p.y - g.start.y));
        }
        const box = stage.querySelector(`.occ-region[data-index="${g.i}"]`);
        if (box) {
          box.style.left = (r.x * 100) + "%"; box.style.top = (r.y * 100) + "%";
          box.style.width = (r.w * 100) + "%"; box.style.height = (r.h * 100) + "%";
        }
      });
      const end = () => {
        if (!g) return;
        const r = regions[g.i];
        if (g.kind === "draw" && (r.w < 0.02 || r.h < 0.02)) regions.splice(g.i, 1);
        const drawn = g.kind === "draw";
        g = null;
        drawStage();
        drawList();
        if (drawn) {
          const fields = list.querySelectorAll("input");
          const last = fields[fields.length - 1];
          if (last) last.focus();
        }
      };
      frame.addEventListener("pointerup", end);
      frame.addEventListener("pointercancel", end);
    }

    async function loadImage() {
      try {
        if (source.file) {
          const prepared = await Upload.prepare(source.file);
          upload = { blob: prepared.blob, mime: prepared.mime };
          imageUrl = URL.createObjectURL(prepared.blob);
        } else {
          let mediaId = source.fromPicture ? source.fromPicture.mediaId : null;
          if (!mediaId && existingId) {
            const m = [...L.media.values()].find(x => x.note_id === existingId && x.deleted_at == null);
            mediaId = m ? m.id : null;
          }
          const loaded = mediaId ? await Media.load(mediaId) : null;
          if (!loaded || !loaded.url) throw new Error("The picture could not be loaded.");
          imageUrl = loaded.url;
          if (source.fromPicture) upload = { sha: source.fromPicture.sha, mime: source.fromPicture.mime };
        }
      } catch (error) {
        status.textContent = String(error.message || error);
      }
      drawStage();
    }

    const body = h("div.occ-editor",
      h("div.occ-main",
        h("div.occ-left", promptField, stage),
        h("div.occ-side",
          h("div.value-row.plain", h("span.value-label", { text: "Hide" }), modeBox),
          h("div.eyebrow.group-eyebrow", { text: "Regions" }), list,
          h("p.help", { text: "Each region is a card. Drag a region to move it, drag its corner to resize it." }))),
      status);
    drawMode();
    drawList();
    drawStage();
    loadImage();

    UI.sheet({
      title: existingId ? "Edit Occlusion" : "New Diagram", left: "Cancel", right: "Save", width: 900, body: [body],
      onRight: async () => {
        try {
          let sha = upload && upload.sha, mime = upload && upload.mime;
          if (upload && upload.blob) {
            sha = await Backend.uploadBlob(upload.blob, upload.mime);
            mime = upload.mime;
          }
          const id = Store.saveOcclusion({ docId, afterId, noteId: existingId, prompt, mode, sha, mime,
                                           regions: regions.map((r, i) => ({ ...r, z: r.z || 0, order: i })) });
          if (source.fromPicture) Store.deleteLine(source.fromPicture.noteId);
          if (onSaved) onSaved(id);
          return true;
        } catch (error) {
          status.textContent = String(error.message || error);
          if (onError) onError(error);
          return false;
        }
      },
      onClose: () => { if (source.file && imageUrl) URL.revokeObjectURL(imageUrl); },
    });
  }

  return { open };
})();
