// Spell check a grid set using the same code as the web page and print
// every flagged word, most common first.
//
//   node tests/spell-node.mjs grid.gridset [--suggest]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extractFields, words, decodeXml, gridName } from '../assets/js/gridtext.mjs';
import { createChecker } from '../assets/js/spell.mjs';

const require = createRequire(import.meta.url);
const C = require('../assets/js/core.js');

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node tests/spell-node.mjs grid.gridset [--suggest]');
  process.exit(1);
}
const dir = new URL('../assets/vendor/dictionary-en-gb/', import.meta.url);
let t = Date.now();
const checker = await createChecker(readFileSync(new URL('en-gb.aff', dir)), readFileSync(new URL('en-gb.dic', dir)));
console.error(`Dictionary loaded in ${Date.now() - t} ms`);

t = Date.now();
const zip = C.readZip(readFileSync(file));
C.inspectGridset(zip);
const flagged = new Map(); // word -> { count, pages: Set, kinds: Set }
let fieldCount = 0, wordCount = 0, readOnly = 0;
for (const e of zip.entries) {
  const page = gridName(e.name);
  if (!page) continue;
  const { xml, editable } = decodeXml(C.inflateEntry(e));
  if (!editable) readOnly++;
  for (const f of extractFields(xml)) {
    fieldCount++;
    for (const { word } of words(f.text)) {
      wordCount++;
      if (checker.isCorrect(word)) continue;
      if (!flagged.has(word)) flagged.set(word, { count: 0, pages: new Set(), kinds: new Set() });
      const r = flagged.get(word);
      r.count++; r.pages.add(page); r.kinds.add(f.kind);
    }
  }
}
console.error(`${fieldCount} pieces of text, ${wordCount} words, ${flagged.size} flagged, ${readOnly} pages read-only, in ${Date.now() - t} ms`);

t = Date.now();
const rows = [...flagged].sort((a, b) => b[1].count - a[1].count);
for (const [word, r] of rows) {
  const sugg = flags.includes('--suggest') ? '  → ' + checker.suggest(word).join(', ') : '';
  console.log(`${String(r.count).padStart(5)}  ${word}  [${[...r.kinds].join(',')}] on ${r.pages.size} pages${sugg}`);
}
if (flags.includes('--suggest')) console.error(`Suggestions in ${Date.now() - t} ms`);
