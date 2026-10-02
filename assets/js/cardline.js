// D-191's editing rules as text, restated from Recall: the arrow's menu
// (`CardChipMenu`, `DocCanvasCore.chipState` and `applyChipChange`), Return
// after a trigger (`canvasReturnAfterTrigger`), Backspace after a chip
// (`canvasUnchipAtCaret`), the menu's Preview card (`cardPeek`) and a cloze
// blank's menu (`ClozeBlanks`, Sources/Core/Outline.swift). Pure: every
// function takes a line's text and answers what it becomes, so the editor
// applies each one as one edit and one undo step, and
// test/unit/web-card-menu.spec.ts holds them to the app's own cases.
//
// Every index is a UTF-16 offset into the line as the editor shows it.

// ------------------------------------------------------------ the blanks

// A CLOZE BLANK'S MENU, AS TEXT (SPEC's 2026-09-28 amendment, "Cloze").
// Storage stays `{{cN::words::hint}}`: blanks that SHARE an ordinal are
// "with the others" and make one card that hides them together, a blank whose
// ordinal no other blank carries is its "own card". Every change rewrites ONE
// span and answers where it stands and what replaces it: `{ start, end,
// text }`, or null when nothing would change.
const ClozeBlanks = (() => {

  const spans = line => Gate.clozeSpans(line);

  // No other blank on the line carries this one's ordinal.
  function isOwnCard(line, index) {
    const all = spans(line);
    if (!all[index]) return true;
    return all.filter(s => s.ordinal === all[index].ordinal).length === 1;
  }

  function hint(line, index) {
    const s = spans(line)[index];
    return s && s.hint ? line.slice(s.hint.start, s.hint.end) : "";
  }

  // One span written again: its words, a new ordinal, and the hint given
  // (null keeps the one it has; an empty hint takes the `::` off with it).
  function spanText(line, s, ordinal, hintText) {
    const words = line.slice(s.inner.start, s.inner.end);
    const h = hintText != null ? hintText : (s.hint ? line.slice(s.hint.start, s.hint.end) : "");
    return `{{c${ordinal}::` + words + (h ? "::" + h : "") + "}}";
  }

  // Own card takes an ordinal no blank has (one past the highest); with the
  // others joins the lowest ordinal two blanks already share, else the
  // lowest other blank's. Null when nothing would change, or with the
  // others is asked of the line's only blank.
  function settingOwnCard(line, index, own) {
    const all = spans(line);
    if (!all[index] || isOwnCard(line, index) === own) return null;
    const me = all[index];
    let ordinal;
    if (own) {
      ordinal = Math.max(...all.map(s => s.ordinal)) + 1;
    } else {
      const others = all.filter((_, i) => i !== index).map(s => s.ordinal);
      if (!others.length) return null;
      const shared = others.filter(o => others.filter(x => x === o).length > 1);
      ordinal = shared.length ? Math.min(...shared) : Math.min(...others);
    }
    return { start: me.whole.start, end: me.whole.end, text: spanText(line, me, ordinal, null) };
  }

  // A hint is one line with no brace (the grammar's `[^}]*`), trimmed of
  // spaces; an empty one takes the `::` off with it.
  const NEWLINES = /[\n\r\u000B\u000C\u0085\u2028\u2029]/g;
  function settingHint(line, index, to) {
    const all = spans(line);
    if (!all[index]) return null;
    const clean = Gate.trimSpaces(String(to ?? "").replace(/[{}]/g, "").replace(NEWLINES, ""));
    if (clean === hint(line, index)) return null;
    const me = all[index];
    return { start: me.whole.start, end: me.whole.end, text: spanText(line, me, me.ordinal, clean) };
  }

  // The blank's words, as plain text again.
  function removing(line, index) {
    const me = spans(line)[index];
    if (!me) return null;
    return { start: me.whole.start, end: me.whole.end, text: line.slice(me.inner.start, me.inner.end) };
  }

  // TYPING `{{word}}` MAKES AN OWN-CARD BLANK: when the caret has just
  // closed a bare `{{...}}` on its line, the text is rewritten to
  // `{{cN::...}}` with N one past the highest ordinal of the line's SOURCE
  // (`previousSource`, which on the canvas still carries the hidden ones).
  // A line that is already a card and a picture token are left alone. The
  // app's signature, so its cases run here unchanged; the editor passes one
  // line, which is both its display and its source. (`previousKinds` is kept
  // in the signature; since code left Recall no kind refuses a blank.)
  function expandingTyped(display, caret, previousSource, previousKinds) {
    if (caret < 5 || caret > display.length
        || display.charCodeAt(caret - 1) !== 0x7D || display.charCodeAt(caret - 2) !== 0x7D) return null;
    const lineStart = display.lastIndexOf("\n", caret - 2) + 1;
    const nl = display.indexOf("\n", caret - 1);
    const lineEnd = nl < 0 ? display.length : nl;
    const before = display.slice(lineStart, caret - 2);
    const open = before.lastIndexOf("{{");
    if (open < 0) return null;
    const inner = before.slice(open + 2);
    if (!inner || !/\S/.test(inner) || inner.includes("{") || inner.includes("}")
        || inner.startsWith("img:") || /^c\d+::/.test(inner)) return null;
    let lineIndex = 0;
    for (let i = 0; i < lineStart; i++) if (display.charCodeAt(i) === 0x0A) lineIndex++;
    const sourceLine = String(previousSource ?? "").split("\n")[lineIndex] ?? "";
    if (Gate.splitCard(display.slice(lineStart, lineEnd))) return null;
    const next = Math.max(0, ...Gate.clozeOrdinals(sourceLine)) + 1;
    const prefix = `c${next}::`;
    const at = lineStart + open + 2;
    return { display: display.slice(0, at) + prefix + display.slice(at), caret: caret + prefix.length, at, inserted: prefix };
  }

  return { spans, isOwnCard, hint, settingOwnCard, settingHint, removing, expandingTyped };
})();

// -------------------------------------------------------------- the chip

const CardLine = (() => {

  // `AppDatabase.outlineMaxDepth`: six levels, depth 0 to 5.
  const MAX_DEPTH = 5;
  const isListKind = kind => kind === "bullet" || kind === "dash" || kind === "numbered";

  // `RichText.numberedMarker`'s length: digits, `.` or `)`, then a space or
  // the end of the line; 0 when the line opens with none.
  function numberedMarkerLength(text) {
    const m = /^\p{N}+[.)](?: |$)/u.exec(text);
    return m ? m[0].length : 0;
  }

  // What the arrow's menu shows for a line (`chipState`), or null when it
  // carries no trigger. `ask` is the block's `attrs.ask`; `answerKinds` the
  // kinds of the answer lines under it, read only for a list-shaped line.
  function state(text, ask, answerKinds = [], cardId = null) {
    const hit = Gate.separatorHits(text)[0];
    const split = Gate.splitCard(text);
    if (!hit || !split) return null;
    const answers = split.listShaped ? answerKinds : [];
    return {
      kind: Gate.TRIGGERS[split.separator].kind,
      asks: Gate.marksAsks(split.mark, ask),
      answer: !answers.length ? "oneLine" : answers[0] === "numbered" ? "ordered" : "set",
      hasAnswerLines: answers.length > 0,
      on: !split.off,
      cardId,
    };
  }

  // A NEW TRIGGER, and the `ask` it stores: a Basic card's direction is its
  // trigger (`>>>` stays `>>>` while it asks forward); a concept or a
  // descriptor keeps its own trigger and stores `ask` only when it differs
  // from the type's (Both for a concept, Forward for a descriptor).
  function triggerFor(mark, kind, asks) {
    if (kind === "basic") {
      if (mark.separator === ">>>" && asks === "f") return { separator: ">>>", ask: null };
      return { separator: asks === "r" ? "<<" : asks === "b" ? "<>" : ">>", ask: null };
    }
    if (kind === "concept") return { separator: "::", ask: asks === "b" ? null : asks };
    return { separator: ";;", ask: asks === "f" ? null : asks };
  }

  // One change of Type (`{ kind }`), Asks (`{ asks }`) or Card on
  // (`{ on }`) as an edit of the line: the trigger's range, the text that
  // replaces it (null when the trigger stays as written), and the `ask` the
  // block stores after it. A change of TYPE starts at the type's own
  // direction, except Basic, which keeps the direction the card asked. Card
  // on only moves the `-` after the trigger. Null when the line carries no
  // trigger.
  function chipEdit(text, ask, change) {
    const hit = Gate.separatorHits(text)[0];
    if (!hit || !Gate.splitCard(text)) return null;
    const mark = hit.mark;
    const current = Gate.marksAsks(mark, ask);
    let next;
    if (change.kind) {
      const own = change.kind === "concept" ? "b" : "f";
      next = { ...triggerFor(mark, change.kind, change.kind === "basic" ? current : own), off: mark.off };
    } else if (change.asks) {
      next = { ...triggerFor(mark, Gate.TRIGGERS[mark.separator].kind, change.asks), off: mark.off };
    } else if (typeof change.on === "boolean") {
      next = { separator: mark.separator, ask: ask ?? null, off: !change.on };
    } else {
      return null;
    }
    const written = next.separator + (next.off ? "-" : "");
    return { start: hit.start, end: hit.end, text: written === text.slice(hit.start, hit.end) ? null : written,
             ask: next.ask };
  }

  // Set and In order. A numbered item's marker is in its text (E24), so the
  // kind alone cannot make or unmake one: Set takes each `N. ` off and
  // makes the line a bullet, In order writes `N. ` (counted per depth,
  // restarting under a shallower line) and makes it numbered. `lines` are
  // the answer lines as `{ text, depth }`; each answer is `{ cut, add, kind
  // }`: the first `cut` characters become `add`. Null for One line or no
  // lines.
  function answerEdits(lines, answer) {
    if (!lines.length || (answer !== "set" && answer !== "ordered")) return null;
    const counters = new Map();
    return lines.map(line => {
      for (const k of [...counters.keys()]) if (k > line.depth) counters.delete(k);
      const n = (counters.get(line.depth) || 0) + 1;
      counters.set(line.depth, n);
      return { cut: numberedMarkerLength(line.text), add: answer === "ordered" ? `${n}. ` : "",
               kind: answer === "ordered" ? "numbered" : "bullet" };
    });
  }

  // BACKSPACE RIGHT AFTER A CHIP GIVES THE TRIGGER BACK AS WORDS: with the
  // caret right after a trigger (or after the one space after it) on a line
  // that splits, where the backslash goes (`\>>`, the escape the finder
  // reads as text), or null. The next Backspace deletes a `>` like any
  // character.
  function unchipAt(text, caret) {
    const hit = Gate.separatorHits(text).find(h => h.end === caret
      || (h.end + 1 === caret && text.charCodeAt(h.end) === 0x20));
    if (!hit || !Gate.splitCard(text)) return null;
    return hit.start;
  }

  // RETURN AT THE END OF A LINE WHOSE TRIGGER ENDS IT STARTS ITS ANSWER: the
  // depth of the bullet it makes (one level deeper than a list prompt,
  // depth 0 under any other line), or null when Return does what it always
  // does. Never on a table row, a line turned off or a cloze.
  function returnAfterTrigger(text, caret, kind, depth = 0) {
    if (kind === "tablerow" || caret !== text.length || text.includes("{{c")) return null;
    const split = Gate.splitCard(text);
    if (!split || !split.listShaped || split.off) return null;
    return Math.min(isListKind(kind) ? depth + 1 : 0, MAX_DEPTH);
  }

  // PREVIEW CARD (`cardPeek`): a line's front and back as plain text,
  // pictures taken out; a list-shaped line's back is its answer lines, one
  // to a line, their numbers taken off; any other line is all front.
  const IMG = /\{\{img:[^}]+\}\}/g;
  function withoutTokens(text) {
    let out = text;
    const found = [...text.matchAll(IMG)].reverse();
    for (const m of found) {
      let a = m.index, b = m.index + m[0].length;
      if (a > 0 && out.charCodeAt(a - 1) === 0x20) a -= 1;
      else if (b < out.length && out.charCodeAt(b) === 0x20) b += 1;
      out = out.slice(0, a) + out.slice(b);
    }
    return out;
  }

  function peek(text, answerLines = []) {
    const plain = withoutTokens(text);
    const one = Gate.splitOutlineCard(plain);
    if (one) return { front: one.front, back: one.back };
    const split = Gate.splitCard(plain);
    if (split && split.listShaped) {
      const lines = answerLines.map(t => t.slice(numberedMarkerLength(t)));
      return { front: split.front, back: lines.length ? lines.join("\n") : null };
    }
    return { front: Gate.trimSpaces(plain), back: null };
  }

  // ---------------------------------------- the space after a trigger

  // THE TRIGGER BEING TYPED (`triggerAwaitingSpace`, owner 2026-09-29: "it
  // should only change after a space"): the trigger that ends exactly at the
  // caret with no space after it, or null. It is drawn as the characters
  // typed, so `>>` can still grow into `>>>` or `>>-`, and becomes its chip
  // once a space follows it or the caret leaves.
  function triggerAwaitingSpace(line, caret) {
    if (caret <= 1 || caret > line.length) return null;
    if (caret < line.length && line.charCodeAt(caret) === 0x20) return null;
    return Gate.separatorHits(line).find(h => h.end === caret) || null;
  }

  // A SPACE TYPED RIGHT AFTER AN ESCAPED TRIGGER MAKES IT A CHIP AGAIN
  // (`rechippingOnSpace`): `line` holds the space just typed before `caret`;
  // answers the line with the hidden backslash taken out (and the typed
  // space too when the one the chip kept still follows), the caret, and the
  // removals, last first, or null. The caller asks only after ONE typed
  // space; `kind` is kept in the signature.
  function rechippingOnSpace(line, caret, kind) {
    if (caret < 4 || caret > line.length || line.charCodeAt(caret - 1) !== 0x20) return null;
    const space = caret - 1;
    for (const k of Gate.escapedTriggerBackslashes(line)) {
      if (k >= space) continue;
      const freed = line.slice(0, k) + line.slice(k + 1);
      if (!Gate.separatorHits(freed).some(h => h.end === space - 1)) continue;
      if (caret < line.length && line.charCodeAt(caret) === 0x20) {
        const out = line.slice(0, space) + line.slice(caret);
        return { text: out.slice(0, k) + out.slice(k + 1), caret: caret - 1, cuts: [{ start: space, length: 1 }, { start: k, length: 1 }] };
      }
      return { text: freed, caret: caret - 1, cuts: [{ start: k, length: 1 }] };
    }
    return null;
  }

  // BACKSPACE INSIDE AN ESCAPED TRIGGER (`backspaceInEscapedTrigger`): the
  // removals, last first: the character before the caret, and the hidden
  // backslash too once what is left escapes nothing, so `\>>` becomes `>`
  // and never a visible `\>`. Null when that character is not part of an
  // escaped trigger.
  function backspaceInEscapedTrigger(line, caret) {
    if (caret <= 1 || caret > line.length) return null;
    const deleted = caret - 1;
    for (const k of Gate.escapedTriggerBackslashes(line)) {
      if (k >= deleted) continue;
      const freed = line.slice(0, k) + line.slice(k + 1);
      const hit = Gate.separatorHits(freed).find(h => h.start === k);
      if (!hit || deleted < k + 1 || deleted > k + (hit.end - hit.start)) continue;
      const left = line.slice(0, deleted) + line.slice(deleted + 1);
      return Gate.escapedTriggerBackslashes(left).includes(k)
        ? [{ start: deleted, length: 1 }]
        : [{ start: deleted, length: 1 }, { start: k, length: 1 }];
    }
    return null;
  }

  return { state, triggerFor, chipEdit, answerEdits, unchipAt, returnAfterTrigger, peek,
           triggerAwaitingSpace, rechippingOnSpace, backspaceInEscapedTrigger,
           numberedMarkerLength, MAX_DEPTH };
})();
