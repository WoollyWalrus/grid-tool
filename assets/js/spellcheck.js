/*
 * Page logic: choose a grid set, find words the dictionary doesn't know,
 * let the user correct or accept each one, then offer the corrected grid
 * set as a download. Nothing leaves the browser.
 */
import { KINDS, extractFields, words, fieldEdits, applyEdits, decodeXml, encodeXml, gridName } from './gridtext.mjs';
import { normalise } from './spell.mjs';

const C = window.GridCore;

const $ = (id) => document.getElementById(id);
const steps = ['step-choose', 'step-working', 'step-review', 'step-error'];
function show(step) {
  for (const s of steps) $(s).hidden = s !== step;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function setProgress(done, total, text) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('progress-bar').style.width = pct + '%';
  $('progress-bar').parentElement.setAttribute('aria-valuenow', String(pct));
  if (text) $('working-status').textContent = text;
}

function showError(title, message) {
  $('error-title').textContent = title;
  $('error-message').textContent = message;
  show('step-error');
  $('error-button').focus();
}

/* ------------------------------------------------------------------ */
/* Accepted words, kept in this browser                                */
/* ------------------------------------------------------------------ */
const STORAGE_KEY = 'gridtools.spelling.accepted';
const accepted = new Map(); // normalised -> word as the user accepted it

function loadAccepted() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    for (const w of list) if (typeof w === 'string' && w) accepted.set(normalise(w), w);
  } catch (e) { /* storage blocked or damaged: start with an empty list */ }
}

function saveAccepted() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...accepted.values()]));
  } catch (e) { /* storage blocked: the list lasts until the page closes */ }
  renderAccepted();
}

function renderAccepted() {
  $('accepted-count').textContent = String(accepted.size);
  const sorted = [...accepted.values()].sort((a, b) => a.localeCompare(b, 'en-GB', { sensitivity: 'base' }));
  $('accepted-list').replaceChildren(...sorted.map((w) => el('li', {},
    el('span', {}, w),
    el('button', {
      class: 'link-button', type: 'button', 'aria-label': `Remove ${w}`,
      onclick: () => { accepted.delete(normalise(w)); saveAccepted(); refreshAcceptedRows(); },
    }, 'Remove'),
  )));
  $('export-button').disabled = accepted.size === 0;
}

function exportAccepted() {
  const text = [...accepted.values()].sort().join('\n') + '\n';
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = el('a', { href: url, download: 'accepted-words.txt' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importAccepted(file) {
  if (!file) return;
  const text = await file.text();
  let added = 0;
  for (const line of text.split(/\r?\n/)) {
    const w = line.trim();
    if (!w || w.length > 60 || accepted.has(normalise(w))) continue;
    accepted.set(normalise(w), w);
    added++;
  }
  saveAccepted();
  refreshAcceptedRows();
  $('import-input').value = '';
  $('accepted').open = true;
  alert(`${plural(added, 'word')} added to your accepted words.`);
}

/* ------------------------------------------------------------------ */
/* Spell checking in a background worker                               */
/* ------------------------------------------------------------------ */
class Speller {
  constructor() {
    this.worker = new Worker(new URL('./spell-worker.mjs', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.terminate(new Error('The spelling worker could not run.'));
    };
  }

  request(type, list) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, words: list });
    });
  }

  terminate(error = new Error('cancelled')) {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
}

/* ------------------------------------------------------------------ */
/* State for the grid set being checked                                */
/* ------------------------------------------------------------------ */
let state = null;
let runId = 0;
let speller = null;

/*
 * state = {
 *   file, zip,
 *   pages:   [{ name, entry, xml, editable, fields }],
 *   flagged: [{ key, word, short, suggestions, occurrences, status, replacement, row }],
 *   pageNames: [{ key, word, pages }],
 * }
 * occurrence = { page, field, start, end, word, include, replacement }
 */

const yieldToBrowser = () => new Promise((r) => setTimeout(r, 0));

async function handleFile(file) {
  if (!file) return;
  if (state && hasUnsavedChanges() && !confirm('You have corrections you have not downloaded. Check a different grid set anyway?')) return;
  const id = ++runId;
  state = null;

  if (!/\.gridsetx?$/i.test(file.name)) {
    showError('This is not a grid set', `"${file.name}" is not a grid set. Please choose a file that ends in .gridset.`);
    return;
  }

  $('working-name').textContent = file.name;
  setProgress(0, 1, 'Opening the grid set…');
  show('step-working');

  let zip;
  try {
    const buffer = await file.arrayBuffer();
    if (id !== runId) return;
    zip = C.readZip(new Uint8Array(buffer));
    C.inspectGridset(zip);
  } catch (err) {
    if (id !== runId) return;
    if (err instanceof C.GridsetError) {
      const title = err.code === 'encrypted' ? 'This grid set is licensed' : "We couldn't open this file";
      showError(title, err.message);
    } else {
      console.error(err);
      showError("We couldn't open this file", 'Something went wrong while reading the grid set. Try exporting it from Grid 3 again.');
    }
    return;
  }

  try {
    speller ||= new Speller();

    // Read every page and collect its words.
    const gridEntries = zip.entries.filter((e) => gridName(e.name));
    const pages = [];
    const byWord = new Map(); // exact word -> occurrences
    for (let i = 0; i < gridEntries.length; i++) {
      const entry = gridEntries[i];
      const { xml, editable } = decodeXml(C.inflateEntry(entry));
      const page = { name: gridName(entry.name), entry, xml, editable, fields: extractFields(xml) };
      const pageIndex = pages.push(page) - 1;
      page.fields.forEach((f, fieldIndex) => {
        for (const w of words(f.text)) {
          if (!byWord.has(w.word)) byWord.set(w.word, []);
          byWord.get(w.word).push({ page: pageIndex, field: fieldIndex, start: w.start, end: w.end, word: w.word, include: true, replacement: null });
        }
      });
      if (i % 25 === 0) {
        setProgress(i, gridEntries.length * 2, `Reading pages: ${i} of ${gridEntries.length}`);
        await yieldToBrowser();
        if (id !== runId) return;
      }
    }

    setProgress(gridEntries.length, gridEntries.length * 2, 'Checking spelling…');
    const unique = [...byWord.keys()];
    const correct = await speller.request('check', unique);
    if (id !== runId) return;

    // Words that differ only in case are one entry, such as Rainforest and rainforest.
    const groups = new Map();
    unique.forEach((w, i) => {
      if (correct[i]) return;
      const key = normalise(w);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(...byWord.get(w));
    });

    const flagged = [...groups].map(([key, occurrences]) => {
      // Show the form used most often.
      const counts = new Map();
      for (const o of occurrences) counts.set(o.word, (counts.get(o.word) || 0) + 1);
      const word = [...counts].sort((a, b) => b[1] - a[1])[0][0];
      return { key, word, short: [...key].length <= 3, suggestions: [], occurrences, status: 'open', replacement: null, row: null };
    });
    flagged.sort((a, b) => b.occurrences.length - a.occurrences.length || a.key.localeCompare(b.key));

    setProgress(gridEntries.length * 1.5, gridEntries.length * 2, 'Finding suggestions…');
    const toSuggest = flagged.filter((f) => !f.short);
    const suggestions = await speller.request('suggest', toSuggest.map((f) => f.word));
    if (id !== runId) return;
    toSuggest.forEach((f, i) => { f.suggestions = suggestions[i]; });

    // Page names: reported, never changed here. Short letter groups are skipped.
    const nameWords = [...new Set(pages.flatMap((p) => words(p.name).map((w) => w.word)))].filter((w) => [...w].length > 3);
    const nameCorrect = await speller.request('check', nameWords);
    if (id !== runId) return;
    const pageNames = nameWords.filter((w, i) => !nameCorrect[i]).map((word) => ({
      key: normalise(word), word, pages: pages.map((p) => p.name).filter((n) => words(n).some((w) => w.word === word)),
    }));

    // Words accepted on an earlier visit are not shown at all.
    state = { file, zip, pages, flagged: flagged.filter((f) => !accepted.has(f.key)), pageNames, downloaded: true };
    showReview();
  } catch (err) {
    if (id !== runId) return;
    console.error(err);
    speller?.terminate();
    speller = null;
    showError('Something went wrong', 'The spell checker could not run in this browser. Please try again in an up-to-date Chrome or Edge.');
  }
}

/* ------------------------------------------------------------------ */
/* Review                                                              */
/* ------------------------------------------------------------------ */
function isAccepted(f) {
  return accepted.has(f.key);
}

function showReview() {
  $('review-title').textContent = state.file.name;
  const main = state.flagged.filter((f) => !f.short);
  const short = state.flagged.filter((f) => f.short);
  $('word-list').replaceChildren(...main.map(renderRow));
  $('short-list').replaceChildren(...short.map(renderRow));
  $('short-group').hidden = short.length === 0;
  $('short-title').textContent = `Short letter groups (${short.length})`;

  updateSummary();
  show('step-review');
}

function renderPageNames() {
  const list = state.pageNames.filter((n) => !accepted.has(n.key));
  $('page-names').hidden = list.length === 0;
  $('page-names-title').textContent = `Unknown words in page names (${list.length})`;
  $('page-names-list').replaceChildren(...list.map((n) => el('li', {},
    el('span', { class: 'flag-word' }, n.word), ` in ${plural(n.pages.length, 'page name')}: `,
    n.pages.slice(0, 5).join(', ') + (n.pages.length > 5 ? '…' : '') + ' ',
    el('button', { class: 'link-button', type: 'button', onclick: () => { accepted.set(n.key, n.word); saveAccepted(); renderPageNames(); } }, 'Accept'),
  )));
}

function updateSummary() {
  renderPageNames();
  const open = state.flagged.filter((f) => f.status === 'open' && !isAccepted(f));
  const changedCells = state.flagged.reduce((n, f) => n + f.occurrences.filter((o) => o.replacement !== null).length, 0);
  $('review-summary').textContent = state.flagged.length === 0
    ? 'No spelling mistakes found.'
    : open.length === 0
      ? 'All flagged words have been dealt with.'
      : `${plural(open.length, 'word')} to check.`;
  $('download-button').hidden = changedCells === 0;
  $('review-changes').hidden = changedCells === 0;
  $('review-changes').textContent = `${plural(changedCells, 'correction')} ready. Nothing changes until you download.`;
}

function hasUnsavedChanges() {
  return state && !state.downloaded;
}

function contextFor(o) {
  const f = state.pages[o.page].fields[o.field];
  const before = f.text.slice(Math.max(0, o.start - 40), o.start).replace(/\s+/g, ' ');
  const after = f.text.slice(o.end, o.end + 40).replace(/\s+/g, ' ');
  return [
    (o.start > 40 ? '…' : '') + before,
    el('mark', { class: 'misspelt' }, o.word),
    after + (o.end + 40 < f.text.length ? '…' : ''),
  ];
}

function describe(f) {
  const pages = new Set(f.occurrences.map((o) => o.page)).size;
  const kinds = [...new Set(f.occurrences.map((o) => KINDS[state.pages[o.page].fields[o.field].kind]))];
  return `${plural(f.occurrences.length, 'time')} on ${plural(pages, 'page')} · ${kinds.join(', ')}`;
}

/** Keeps a capital letter or capitals when the user picks a lower-case word. */
function matchCase(original, replacement) {
  if (original.length > 1 && original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] !== original[0].toLowerCase() && replacement[0] === replacement[0].toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

const MAX_SHOWN = 200;

function renderRow(f) {
  const row = el('article', { class: 'word-row' });
  f.row = row;
  drawRow(f);
  return row;
}

function drawRow(f) {
  const row = f.row;
  row.classList.toggle('is-done', f.status !== 'open' || isAccepted(f));

  if (isAccepted(f)) {
    row.replaceChildren(el('p', { class: 'row-done' },
      el('span', { class: 'flag-word' }, f.word), ' is accepted. ',
      el('button', { class: 'link-button', type: 'button', onclick: () => { accepted.delete(f.key); saveAccepted(); drawRow(f); updateSummary(); } }, 'Undo'),
    ));
    return;
  }
  if (f.status === 'changed') {
    const n = f.occurrences.filter((o) => o.replacement !== null).length;
    row.replaceChildren(el('p', { class: 'row-done' },
      el('span', { class: 'flag-word' }, f.word), ' → ', el('strong', {}, f.replacement), ` in ${plural(n, 'place')}. `,
      el('button', { class: 'link-button', type: 'button', onclick: () => undoChange(f) }, 'Undo'),
    ));
    return;
  }

  const editableCount = f.occurrences.filter((o) => state.pages[o.page].editable).length;
  const input = el('input', { type: 'text', class: 'fix-input', 'aria-label': `Correction for ${f.word}`, placeholder: 'Type a correction', spellcheck: 'false', autocomplete: 'off' });
  const typed = el('form', { class: 'fix-form', onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) applyChange(f, v, false); } },
    input, el('button', { class: 'button button-secondary button-small', type: 'submit' }, 'Change'));

  const where = el('details', { class: 'where' },
    el('summary', {}, 'Show where'),
    el('ul', { class: 'where-list' }, ...f.occurrences.slice(0, MAX_SHOWN).map((o) => {
      const page = state.pages[o.page];
      const kind = KINDS[page.fields[o.field].kind];
      const box = el('input', { type: 'checkbox', checked: o.include && page.editable, disabled: !page.editable, onchange: (e) => { o.include = e.target.checked; } });
      return el('li', {}, el('label', {},
        box,
        el('span', { class: 'where-text' },
          el('span', { class: 'where-page' }, page.name), el('span', { class: 'chip' }, kind),
          !page.editable ? el('span', { class: 'chip chip-warn' }, "Can't be changed") : null,
          el('span', { class: 'where-context' }, ...contextFor(o)),
        ),
      ));
    }), f.occurrences.length > MAX_SHOWN ? el('li', { class: 'muted' }, `And ${f.occurrences.length - MAX_SHOWN} more.`) : null),
    el('p', { class: 'muted where-hint' }, 'Untick any you want to leave as they are.'),
  );

  row.replaceChildren(
    el('div', { class: 'word-main' },
      el('span', { class: 'flag-word' }, f.word),
      el('span', { class: 'word-meta' }, describe(f)),
      el('span', { class: 'word-example' }, ...contextFor(f.occurrences[0])),
    ),
    el('div', { class: 'word-fix' },
      editableCount === 0 ? null : el('div', { class: 'suggestions' },
        f.suggestions.length ? el('span', { class: 'muted' }, 'Change to') : null,
        ...f.suggestions.map((s) => el('button', { class: 'button button-suggestion button-small', type: 'button', onclick: () => applyChange(f, s, true) }, s)),
      ),
      editableCount === 0 ? null : typed,
      el('button', { class: 'button button-accept button-small', type: 'button', onclick: () => { accepted.set(f.key, f.word); saveAccepted(); drawRow(f); updateSummary(); } }, 'Accept'),
    ),
    where,
  );
}

function applyChange(f, replacement, fromSuggestion) {
  let n = 0;
  for (const o of f.occurrences) {
    if (!o.include || !state.pages[o.page].editable) continue;
    o.replacement = fromSuggestion ? matchCase(o.word, replacement) : replacement;
    n++;
  }
  if (!n) { alert('Tick at least one place to change under "Show where".'); return; }
  f.status = 'changed';
  f.replacement = replacement;
  state.downloaded = false;
  drawRow(f);
  updateSummary();
}

function undoChange(f) {
  for (const o of f.occurrences) o.replacement = null;
  f.status = 'open';
  f.replacement = null;
  state.downloaded = state.flagged.every((x) => x.status !== 'changed');
  drawRow(f);
  updateSummary();
}

function refreshAcceptedRows() {
  if (!state) return;
  for (const f of state.flagged) if (f.row) drawRow(f);
  updateSummary();
}

function acceptShort() {
  for (const f of state.flagged) {
    if (f.short && f.status === 'open') accepted.set(f.key, f.word);
  }
  saveAccepted();
  refreshAcceptedRows();
}

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */
function download() {
  const editsByPage = new Map();
  for (const f of state.flagged) {
    for (const o of f.occurrences) {
      if (o.replacement === null) continue;
      const field = state.pages[o.page].fields[o.field];
      if (!editsByPage.has(o.page)) editsByPage.set(o.page, []);
      editsByPage.get(o.page).push(...fieldEdits(field, o.start, o.end, o.replacement));
    }
  }
  try {
    for (const page of state.pages) page.entry.replacement = null;
    for (const [i, edits] of editsByPage) {
      const page = state.pages[i];
      const bytes = encodeXml(applyEdits(page.xml, edits));
      page.entry.replacement = C.packReplacement(bytes, page.entry.method);
    }
    const parts = C.writeZip(state.zip.entries, state.zip.comment);
    const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
    const a = el('a', { href: url, download: state.file.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    state.downloaded = true;
  } catch (err) {
    console.error(err);
    alert('The corrected grid set could not be created. Please try again, or contact us if it keeps happening.');
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */
function reset() {
  if (hasUnsavedChanges() && !confirm('You have corrections you have not downloaded. Leave them?')) return;
  runId++;
  state = null;
  $('file-input').value = '';
  show('step-choose');
  $('file-input').focus();
}

loadAccepted();
renderAccepted();

$('file-input').addEventListener('change', (e) => handleFile(e.target.files[0]));

const zone = $('drop-zone');
['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add('is-dragging'); }));
['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, () => zone.classList.remove('is-dragging')));
zone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
// Dropping a file anywhere else should not make the browser open it.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('cancel-button').addEventListener('click', () => { runId++; state = null; show('step-choose'); });
$('again-button').addEventListener('click', reset);
$('error-button').addEventListener('click', reset);
$('download-button').addEventListener('click', download);
$('accept-short').addEventListener('click', acceptShort);
$('export-button').addEventListener('click', exportAccepted);
$('import-input').addEventListener('change', (e) => importAccepted(e.target.files[0]));

window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedChanges()) { e.preventDefault(); e.returnValue = ''; }
});
