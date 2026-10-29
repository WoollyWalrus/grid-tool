// Spell checker checks. Synthetic fixtures only: no private grid sets required.
// Run: node tests/spell-regressions.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractFields, words, fieldEdits, applyEdits, decodeXml, encodeXml, gridName } from '../assets/js/gridtext.mjs';
import { createChecker, normalise } from '../assets/js/spell.mjs';

const xml = `<?xml version="1.0" encoding="utf-8"?>
<Grid xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Cells>
    <Cell X="2" Y="1">
      <Content>
        <Commands>
          <Command ID="Action.InsertText">
            <Parameter Key="text">
              <p>
                <s Image="[widgit]a.emf">
                  <r>Teh</r>
                </s>
                <s>
                  <r><![CDATA[ ]]></r>
                </s>
                <s>
                  <r>cat &amp; dgo</r>
                </s>
              </p>
            </Parameter>
          </Command>
          <Command ID="Speech.SpeakNow">
            <Parameter Key="text" xml:space="preserve">helo there </Parameter>
          </Command>
          <Command ID="Jump.To">
            <Parameter Key="grid">Mispeled Page</Parameter>
          </Command>
        </Commands>
        <CaptionAndImage>
          <Caption>Teh cat</Caption>
          <Image>[grid3x]wrogn.wmf</Image>
          <AudioDescription>the &lt;cat&gt;</AudioDescription>
        </CaptionAndImage>
        <Style><BasedOnStyle>Default</BasedOnStyle></Style>
      </Content>
    </Cell>
    <Cell>
      <Content>
        <CaptionAndImage><Caption>Back</Caption></CaptionAndImage>
      </Content>
    </Cell>
  </Cells>
  <WordList>
    <Items>
      <WordListItem><Text><r>wrod</r></Text><PartOfSpeech>Unknown</PartOfSpeech></WordListItem>
    </Items>
  </WordList>
</Grid>`;

/* Extraction */
const fields = extractFields(xml);
const byKind = (k) => fields.filter((f) => f.kind === k);
assert.deepEqual(fields.map((f) => f.kind), ['write', 'speak', 'caption', 'audio', 'caption', 'wordlist']);
assert.equal(byKind('write')[0].text, 'Teh cat & dgo', 'CDATA spaces and entities are part of the text');
assert.equal(byKind('speak')[0].text, 'helo there ');
assert.equal(byKind('audio')[0].text, 'the <cat>');
assert.deepEqual(byKind('caption')[0].cell, { index: 0, x: 2, y: 1 });
assert.deepEqual(byKind('caption')[1].cell, { index: 1, x: 0, y: 0 }, 'missing X/Y mean 0');
assert.equal(byKind('wordlist')[0].cell, null);
assert.ok(!fields.some((f) => /Mispeled|wrogn/.test(f.text)), 'page names and picture names are not cell text');

/* Words */
assert.deepEqual(words("Teh cat's 10s TTh SAS a well-known I’m").map((w) => w.word), ['Teh', "cat's", 'well', 'known', 'I’m']);

/* Fixes change only the word's characters */
function fix(field, word, replacement) {
  const w = words(field.text).find((x) => x.word === word);
  return fieldEdits(field, w.start, w.end, replacement);
}
const write = byKind('write')[0];
let out = applyEdits(xml, [...fix(write, 'Teh', 'The'), ...fix(write, 'dgo', 'dog & co')]);
assert.equal(out, xml.replace('<r>Teh</r>', '<r>The</r>').replace('&amp; dgo<', '&amp; dog &amp; co<'));
assert.equal(extractFields(out)[0].text, 'The cat & dog & co');
// The caption with the same mistake is a separate field and stays as it was.
assert.equal(extractFields(out)[2].text, 'Teh cat');

// A word next to an entity maps back to the right place in the file.
const audio = byKind('audio')[0];
out = applyEdits(xml, fix(audio, 'cat', 'dog'));
assert.ok(out.includes('<AudioDescription>the &lt;dog&gt;</AudioDescription>'));

// Text inside CDATA is not escaped, and text that can't go in CDATA is refused.
const cdataField = { kind: 'write', text: 'ab', segments: [{ start: 9, raw: 'ab', text: 'ab', map: [0, 1, 2], cdata: true, offset: 0 }] };
assert.equal(applyEdits('<![CDATA[ab]]>', fieldEdits(cdataField, 0, 2, 'x&y')), '<![CDATA[x&y]]>');
assert.throws(() => fieldEdits(cdataField, 0, 2, ']]>'));

// A word split across two runs ends up whole in the first run.
const split = extractFields('<Grid><WordListItem><Text><r>wr</r><r>od</r></Text></WordListItem></Grid>')[0];
assert.equal(split.text, 'wrod');
assert.equal(applyEdits('<Grid><WordListItem><Text><r>wr</r><r>od</r></Text></WordListItem></Grid>', fieldEdits(split, 0, 4, 'word')),
  '<Grid><WordListItem><Text><r>word</r><r></r></Text></WordListItem></Grid>');

assert.throws(() => applyEdits('abcdef', [{ start: 1, end: 3, text: '' }, { start: 2, end: 4, text: '' }]), /overlap/);

/* Bytes */
const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('<Grid>é</Grid>')]);
const decoded = decodeXml(bom);
assert.equal(decoded.editable, true);
assert.deepEqual(encodeXml(decoded.xml), bom, 'a byte order mark survives the round trip');
assert.equal(decodeXml(new Uint8Array([0x3c, 0xff, 0x3e])).editable, false, 'invalid UTF-8 is never written back');
assert.equal(gridName('Grids/Maths - Week 5/grid.xml'), 'Maths - Week 5');
assert.equal(gridName('Grids\\Home\\grid.xml'), 'Home');
assert.equal(gridName('Grids/Home/picture.png'), null);

/* Dictionary */
const dir = new URL('../assets/vendor/dictionary-en-gb/', import.meta.url);
const checker = createChecker(readFileSync(new URL('en-gb.aff', dir)), readFileSync(new URL('en-gb.dic', dir)));
for (const w of ['colour', 'Thousandths', 'vertices', 'gridset', "don't", 'don’t']) assert.ok(checker.isCorrect(w), w);
for (const w of ['color', 'addidtion', 'Verices']) assert.ok(!checker.isCorrect(w), w);
assert.ok(checker.suggest('addidtion').includes('addition'));
assert.equal(normalise('Don’t'), "don't");

console.log('Spell checker checks passed.');
