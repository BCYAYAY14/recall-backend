// The word count (PLAN-BETA-0.12 section 26, W-7), as a pure function over
// the block list: Sources/Core/Canvas/CanvasWordCount.swift restated.
//  - a PICTURE contributes nothing; a DIAGRAM its prompt, not its picture;
//  - a TABLE contributes each cell separately;
//  - everything else its own text, any `{{img:}}` token removed and the card
//    trigger removed (both faces count, the trigger does not);
//  - words are maximal runs of non whitespace, characters are grapheme
//    clusters, reading is 200 words a minute and speaking 130.

const Words = (() => {

  const READING_WPM = 200;
  const SPEAKING_WPM = 130;
  const STATS = ["words", "characters", "charactersNoSpaces", "blocks", "cards", "readingTime", "speakingTime"];
  const TITLES = { words: "Words", characters: "Characters", charactersNoSpaces: "Characters excluding spaces",
                   blocks: "Blocks", cards: "Cards", readingTime: "Reading time", speakingTime: "Speaking time" };

  const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

  // `CardText.withoutTokens`: a token goes with the space in front of it,
  // or, at the start of a line, the space after it.
  function withoutTokens(text) {
    let out = text;
    const hits = [...text.matchAll(/\{\{img:[^}]*\}\}/g)].reverse();
    for (const m of hits) {
      let a = m.index, b = m.index + m[0].length;
      if (a > 0 && out[a - 1] === " ") a -= 1;
      else if (b < out.length && out[b] === " ") b += 1;
      out = out.slice(0, a) + out.slice(b);
    }
    return out;
  }

  // A card's trigger is punctuation between two sides, not a word (every
  // trigger, D-191): the trigger and the spaces beside it become ONE space.
  function strip(text) {
    let out = String(text || "");
    if (out.includes("{")) out = withoutTokens(out);
    const hits = Gate.separatorHits(out);
    for (const hit of hits.reverse()) {
      let a = hit.start, b = hit.end;
      if (a > 0 && out[a - 1] === " ") a -= 1;
      if (b < out.length && out[b] === " ") b += 1;
      out = out.slice(0, a) + " " + out.slice(b);
    }
    return out;
  }

  function add(text, out) {
    if (!text) return;
    const chars = segmenter ? [...segmenter.segment(text)].map(s => s.segment) : [...text];
    let inWord = false;
    for (const ch of chars) {
      out.characters += 1;
      if (/^\s+$/u.test(ch)) { inWord = false; continue; }
      out.charactersNoSpaces += 1;
      if (!inWord) { out.words += 1; inWord = true; }
    }
  }

  function countable(block) {
    if (block.kind === "image") return [];
    if (block.kind === "table" && block.rows && block.rows.length) {
      return block.rows.flatMap(r => Model.cellsOf(r, block.attrs.cardTable).map(strip));
    }
    if (block.hasDiagram) return [strip(block.front)];
    return [strip(block.text)];
  }

  function count(blocks) {
    const out = { words: 0, characters: 0, charactersNoSpaces: 0, blocks: blocks.length, cards: 0 };
    for (const b of blocks) {
      if (b.hasCard) out.cards += 1;
      for (const r of b.rows || []) if (r.hasCard) out.cards += 1;
      for (const piece of countable(b)) add(piece, out);
    }
    return out;
  }

  function countText(text) {
    const out = { words: 0, characters: 0, charactersNoSpaces: 0, blocks: 0, cards: 0 };
    add(strip(text), out);
    return out;
  }

  // "under a minute", "4 min", "1 h 5 min".
  function duration(seconds) {
    if (seconds < 1) return "0 min";
    if (seconds < 60) return "under a minute";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${Math.max(1, minutes)} min`;
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }

  const readingSeconds = c => c.words / READING_WPM * 60;
  const speakingSeconds = c => c.words / SPEAKING_WPM * 60;

  // `WordCountStat.readout`: the unit rides with the number.
  function readout(stat, c) {
    switch (stat) {
      case "characters": return `${c.characters} characters`;
      case "charactersNoSpaces": return `${c.charactersNoSpaces} characters`;
      case "blocks": return `${c.blocks} blocks`;
      case "cards": return `${c.cards} cards`;
      case "readingTime": return `${duration(readingSeconds(c))} to read`;
      case "speakingTime": return `${duration(speakingSeconds(c))} to speak`;
      default: return `${c.words} words`;
    }
  }

  const next = stat => STATS[(Math.max(0, STATS.indexOf(stat)) + 1) % STATS.length];
  const valid = stat => (STATS.includes(stat) ? stat : "words");

  return { count, countText, duration, readout, next, valid, readingSeconds, speakingSeconds, STATS, TITLES };
})();
