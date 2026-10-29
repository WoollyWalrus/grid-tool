// Spell checker checks. Synthetic fixtures only: no private grid sets required.
// Run: node tests/spell-regressions.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractFields, words, fieldEdits, applyEdits, decodeXml, encodeXml, gridName } from '../assets/js/gridtext.mjs';
import { createChecker, normalise, rankSuggestions, isBritishSpelling, editDistance } from '../assets/js/spell.mjs';
import { parseGrid, parseStyles, resolveStyle, cssColour, pictureSource, wordListCells, SIZES } from '../assets/js/gridmodel.mjs';

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
const checker = await createChecker(readFileSync(new URL('en-gb.aff', dir)), readFileSync(new URL('en-gb.dic', dir)));
for (const w of ['colour', 'Thousandths', 'vertices', 'gridset', "don't", 'don’t', 'rainforest', 'Rainforest', 'grandad', 'unamused']) assert.ok(checker.isCorrect(w), w);
for (const w of ['color', 'addidtion', 'Verices', 'mold', 'coordinationing', 'christmas']) assert.ok(!checker.isCorrect(w), w);
assert.equal(checker.suggest('mold')[0], 'mould', 'the British spelling comes first');
assert.equal(checker.suggest('motorized')[0], 'motorised');
assert.equal(checker.suggest('christmas')[0], 'Christmas', 'a missing capital comes first');
assert.ok(checker.suggest('coordinationing').includes('coordinating'), 'words more than one letter out still get suggestions');
assert.equal(checker.suggest('addidtion')[0], 'addition');
assert.equal(checker.suggest('Verices')[0], 'Vertices');
assert.equal(checker.suggest('Delet')[0], 'Delete', 'ordinary words come before names such as Delft');
assert.ok(checker.suggest("dont").every((s) => !s.includes('’')), 'straight apostrophes stay straight');
assert.equal(normalise('Don’t'), "don't");
assert.ok(!checker.suggest('Prev').includes('Perv') && !checker.suggest('Nijah').includes('Niggard'), 'unsuitable words are never suggested');

/* Ordering suggestions */
for (const [us, uk] of [['mold', 'mould'], ['color', 'colour'], ['organize', 'organise'], ['analyze', 'analyse'], ['center', 'centre'],
  ['traveled', 'travelled'], ['defense', 'defence'], ['catalog', 'catalogue'], ['anemia', 'anaemia'], ['fetus', 'foetus']]) {
  assert.ok(isBritishSpelling(us, uk), `${us} → ${uk}`);
}
for (const [w, c] of [['fom', 'foam'], ['mold', 'Mold'], ['mold', 'mild'], ['cot', 'coat'], ['hop', 'hope']]) assert.ok(!isBritishSpelling(w, c), `${w} ↛ ${c}`);
assert.deepEqual(rankSuggestions('mold', ['mild', 'Mold', 'mould', 'Moldova']), ['mould', 'Mold', 'mild', 'Moldova']);
assert.equal(editDistance('Delet', 'Delete'), 1);
assert.equal(editDistance('veiwer', 'viewer'), 1, 'swapped letters count once');
assert.deepEqual(rankSuggestions('spikey', ['spike', 'spiky', 'spike y']), ['spike', 'spiky']);
assert.deepEqual(rankSuggestions("cant", ['can’t', 'cat']), ["can't", 'cat']);

/* Page model for the preview */
const page = `<Grid>
  <ColumnDefinitions><ColumnDefinition /><ColumnDefinition Width="ExtraSmall" /><ColumnDefinition Width="Large" /></ColumnDefinitions>
  <RowDefinitions><RowDefinition /><RowDefinition Height="Small" /></RowDefinitions>
  <Cells>
    <Cell X="1" ColumnSpan="2">
      <Content>
        <Commands><Command ID="Jump.To"><Parameter Key="grid">Food &amp; Drink</Parameter></Command></Commands>
        <CaptionAndImage><Caption>Food &amp; drnk</Caption><Image>.png</Image></CaptionAndImage>
        <Style><BasedOnStyle>style 2</BasedOnStyle><FontSize>30</FontSize></Style>
      </Content>
    </Cell>
    <Cell X="5" Y="9" />
    <Cell Y="1"><Content><ContentType>AutoContent</ContentType><ContentSubType>WordList</ContentSubType><Style><BasedOnStyle>Missing</BasedOnStyle></Style></Content><Visibility>Hidden</Visibility></Cell>
    <Cell><Content><ContentType>AutoContent</ContentType><ContentSubType>WordList</ContentSubType><CaptionAndImage><Image>[widgit]a\\b.emf</Image></CaptionAndImage></Content></Cell>
    <Cell X="2" Y="1"><Content><CaptionAndImage><Caption>Teh end</Caption><Image>-0.png</Image></CaptionAndImage></Content></Cell>
  </Cells>
  <WordList><Items>
    <WordListItem><Text><p><s><r>one</r></s><s><r><![CDATA[ ]]></r></s><s><r>to</r></s></p></Text></WordListItem>
    <WordListItem><Text><r>three</r></Text></WordListItem>
  </Items></WordList>
  <BackgroundColour>#102030FF</BackgroundColour>
</Grid>`;
const model = parseGrid(page);
assert.deepEqual(model.columns, [1, SIZES.ExtraSmall, SIZES.Large]);
assert.deepEqual(model.rows, [1, SIZES.Small]);
assert.equal(model.background, '#102030FF');
assert.equal(model.cells.length, 5, 'an empty <Cell/> still counts');
const [food, , hidden, top, end] = model.cells;
assert.deepEqual([food.x, food.y, food.w, food.h], [1, 0, 2, 1]);
assert.equal(food.caption, 'Food & drnk');
assert.equal(food.jump, 'Food & Drink');
assert.equal(hidden.visibility, 'Hidden');
assert.deepEqual(model.wordList, ['one to', 'three']);
assert.deepEqual(wordListCells(model), [top.index, hidden.index], 'word list cells fill along rows, top to bottom');
assert.deepEqual(pictureSource(food), { kind: 'file', name: '1-0.png' }, 'a cell\'s own picture is named after its position');
assert.deepEqual(pictureSource(end), { kind: 'file', name: '2-1-0.png' });
assert.deepEqual(pictureSource(top), { kind: 'library', library: 'widgit', name: 'a\\b.emf' });
assert.equal(pictureSource(hidden), null);
// Cells are numbered the same way as the text, so mistakes land on the right cell.
for (const f of extractFields(page)) if (f.cell) assert.deepEqual([model.cells[f.cell.index].x, model.cells[f.cell.index].y], [f.cell.x, f.cell.y]);
assert.equal(extractFields(page).find((f) => f.text === 'Teh end').cell.index, end.index);

const styles = parseStyles(`<StyleData><Styles>
  <Style Key="Default"><BackColour>#FFFFFFFF</BackColour><FontSize>20</FontSize></Style>
  <Style Key="style 2"><BackColour>#F7DA64FF</BackColour><FontSize>66</FontSize><BackgroundShape>3</BackgroundShape></Style>
</Styles></StyleData>`);
const look = resolveStyle(food.style, styles);
assert.equal(look.back, '#F7DA64FF');
assert.equal(look.fontSize, 30, 'a size set on the cell wins over its style');
assert.equal(look.shape, 3);
assert.equal(resolveStyle(hidden.style, styles).fontSize, 20, 'an unknown style falls back to Default');
assert.equal(cssColour('#F7DA6480'), 'rgba(247, 218, 100, 0.502)');
assert.equal(cssColour('red'), null);

console.log('Spell checker checks passed.');
