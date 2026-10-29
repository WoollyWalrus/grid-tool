/*
 * Grid set Spell Checker — finding and changing the words inside grid.xml.
 *
 * Pure functions with no DOM access, so the same file runs in the page
 * and in Node (for the test suite).
 *
 * grid.xml is scanned as text rather than parsed into a DOM, so that each
 * word's exact position in the file is known. A fix then replaces just
 * those characters and every other byte of the file stays as it was.
 */

/* ------------------------------------------------------------------ */
/* Which text is checked                                               */
/* ------------------------------------------------------------------ */

/** Labels shown to users for each kind of text. */
export const KINDS = {
  caption: 'On the cell',
  write: 'Written',
  speak: 'Spoken',
  notify: 'Message',
  wordlist: 'Word list',
  audio: 'Audio description',
  tooltip: 'Tooltip',
};

// Commands whose "text" parameter holds words the pupil sees or hears.
const TEXT_COMMANDS = {
  'Action.InsertText': 'write',
  'Speech.SpeakNow': 'speak',
  'Settings.Notify': 'notify',
};

/* ------------------------------------------------------------------ */
/* XML text helpers                                                    */
/* ------------------------------------------------------------------ */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Decodes the escaped text between two tags. `map[i]` is the offset in
 * `raw` where decoded character `i` starts, and `map[text.length]` is
 * raw.length, so any range of decoded text maps back to the file.
 */
function unescapeWithMap(raw) {
  let text = '';
  const map = [];
  const re = /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi;
  let last = 0;
  let m;
  const plain = (to) => {
    for (let i = last; i < to; i++) { map.push(i); text += raw[i]; }
  };
  while ((m = re.exec(raw))) {
    const ref = m[1];
    let ch;
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      ch = String.fromCodePoint(code);
    } else ch = ENTITIES[ref];
    if (ch === undefined) continue;
    plain(m.index);
    for (let k = 0; k < ch.length; k++) map.push(m.index);
    text += ch;
    last = m.index + m[0].length;
  }
  plain(raw.length);
  map.push(raw.length);
  return { text, map };
}

export function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cdataText(s) {
  if (s.includes(']]>')) throw new Error('This text cannot be stored here.');
  return s;
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1]] = unescapeWithMap(m[2] ?? m[3]).text;
  return attrs;
}

/* ------------------------------------------------------------------ */
/* Scanning a grid page                                                */
/* ------------------------------------------------------------------ */
const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|[^<]+/g;

/**
 * Finds every piece of checkable text on a grid page.
 *
 * Returns a list of fields. Each field is one piece of text a user would
 * think of as a unit (a caption, the text a cell writes, one word list
 * item), made of one or more segments: the text nodes it is stored in.
 *
 *   { kind, cell, text, segments: [{ start, raw, text, map, offset }] }
 *
 * `cell` is { index, x, y } for text inside a cell, or null.
 * `segment.offset` is where that segment's text starts within field.text.
 */
export function extractFields(xml) {
  const fields = [];
  const stack = [];
  let cellIndex = -1;
  let cell = null;
  let command = null; // ID of the command we are inside
  let field = null; // rich-text field being collected
  let fieldDepth = 0;
  let paragraphs = 0;

  const addSegment = (f, start, raw, cdata = false) => {
    const { text, map } = cdata ? { text: raw, map: [...raw, ''].map((_, i) => i) } : unescapeWithMap(raw);
    f.segments.push({ start, raw, text, map, cdata, offset: f.text.length });
    f.text += text;
  };
  const top = (n = 1) => stack[stack.length - n];

  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(xml))) {
    const tok = m[0];
    if (m[2]) {
      const name = m[2];
      if (m[1]) {
        // Closing tag
        if (field && stack.length === fieldDepth) {
          if (field.text.trim()) fields.push(field);
          field = null;
        }
        stack.pop();
        if (name === 'Cell') cell = null;
        if (name === 'Command') command = null;
        continue;
      }
      const attrs = parseAttrs(m[3]);
      const selfClosing = m[4] === '/';
      if (name === 'Cell' && !selfClosing) {
        cellIndex++;
        cell = { index: cellIndex, x: +(attrs.X || 0), y: +(attrs.Y || 0) };
      }
      if (name === 'Command' && !selfClosing) command = attrs.ID || null;
      // Rich text containers: a command's text parameter, or a word list item.
      if (!field && !selfClosing) {
        const kind =
          name === 'Parameter' && attrs.Key === 'text' && TEXT_COMMANDS[command] ? TEXT_COMMANDS[command]
          : name === 'Text' && top() === 'WordListItem' ? 'wordlist'
          : null;
        if (kind) {
          field = { kind, cell, text: '', segments: [] };
          fieldDepth = stack.length + 1;
          paragraphs = 0;
        }
      }
      // A new paragraph inside rich text starts a new line.
      if (field && name === 'p') {
        if (paragraphs++ > 0) field.text += '\n';
      }
      if (!selfClosing) stack.push(name);
      continue;
    }
    // Grid 3 stores the spaces between words in rich text as <![CDATA[ ]]>.
    const cdata = tok.startsWith('<![CDATA[');
    if (tok[0] === '<' && !cdata) continue; // comment or declaration

    // Text node
    const parent = top();
    const start = cdata ? m.index + 9 : m.index;
    const raw = cdata ? tok.slice(9, -3) : tok;
    if (field) {
      // In rich text, words live in <r> runs; plain parameter text has no runs.
      if (parent === 'r' || stack.length === fieldDepth) {
        if (parent === 'r' || raw.trim()) addSegment(field, start, raw, cdata);
      }
      continue;
    }
    if (cdata) continue;
    if (!tok.trim()) continue;
    let kind = null;
    if (top(2) === 'CaptionAndImage') {
      kind = parent === 'Caption' ? 'caption' : parent === 'Tooltip' ? 'tooltip' : parent === 'AudioDescription' ? 'audio' : null;
    } else if (parent === 'AudioDescription') kind = 'audio';
    if (kind) {
      const f = { kind, cell, text: '', segments: [] };
      addSegment(f, m.index, tok);
      fields.push(f);
    }
  }
  return fields;
}

/* ------------------------------------------------------------------ */
/* Words                                                               */
/* ------------------------------------------------------------------ */
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

/**
 * Splits text into the words worth spell checking. Skips numbers,
 * anything containing a digit, single letters and abbreviations
 * (words in capitals such as SAS, or short ones like TTh).
 */
export function words(text) {
  const out = [];
  WORD.lastIndex = 0;
  let m;
  while ((m = WORD.exec(text))) {
    const w = m[0];
    if (/\p{N}/u.test(w)) continue;
    if ([...w].length < 2) continue;
    if (w === w.toUpperCase() && w !== w.toLowerCase()) continue;
    // Short abbreviations with more than one capital, such as TTh or PfA.
    if (w.length <= 4 && (w.match(/\p{Lu}/gu) || []).length > 1) continue;
    out.push({ word: w, start: m.index, end: m.index + w.length });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Changing words                                                      */
/* ------------------------------------------------------------------ */

/**
 * Turns "replace field.text[start, end) with `replacement`" into edits on
 * the file: [{ start, end, text }] in file offsets, text already escaped.
 * Only the characters of the word itself are touched.
 */
export function fieldEdits(field, start, end, replacement) {
  const edits = [];
  let first = true;
  for (const seg of field.segments) {
    const a = Math.max(start, seg.offset);
    const b = Math.min(end, seg.offset + seg.text.length);
    if (a > b || (a === b && start !== end)) continue;
    edits.push({
      start: seg.start + seg.map[a - seg.offset],
      end: seg.start + seg.map[b - seg.offset],
      text: !first ? '' : seg.cdata ? cdataText(replacement) : escapeText(replacement),
    });
    first = false;
  }
  return edits;
}

/** Applies edits from fieldEdits. Overlapping edits are refused. */
export function applyEdits(xml, edits) {
  const sorted = [...edits].sort((p, q) => q.start - p.start);
  let out = xml;
  let limit = Infinity;
  for (const e of sorted) {
    if (e.end > limit) throw new Error('Two changes overlap.');
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    limit = e.start;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Reading and writing grid.xml bytes                                  */
/* ------------------------------------------------------------------ */

/**
 * Decodes grid.xml. `editable` is false unless the bytes are UTF-8 that
 * re-encode exactly, so a file we can't write back faithfully is still
 * checked but never changed.
 */
export function decodeXml(bytes) {
  try {
    const xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const again = new TextEncoder().encode(xml);
    const editable = again.length === bytes.length && again.every((b, i) => b === bytes[i]);
    return { xml, editable };
  } catch (e) {
    return { xml: new TextDecoder('utf-8').decode(bytes), editable: false };
  }
}

export function encodeXml(xml) {
  return new TextEncoder().encode(xml);
}

/** "Grids/Maths - Week 5/grid.xml" → "Maths - Week 5", or null for other files. */
export function gridName(entryName) {
  const m = /^Grids[\\/]([^\\/]+)[\\/]grid\.xml$/i.exec(entryName);
  return m ? m[1] : null;
}
