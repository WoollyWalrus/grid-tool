/*
 * Page logic: choose a grid set, find words the dictionary doesn't know,
 * let the user correct or accept each one, then offer the corrected grid
 * set as a download. Nothing leaves the browser.
 */
import { KINDS, extractFields, words, fieldEdits, applyEdits, decodeXml, encodeXml, gridName } from './gridtext.mjs';
import { normalise } from './spell.mjs';
import { parseGrid, parseStyles, wordListCells } from './gridmodel.mjs';
import { renderPage, fitCaptions } from './gridview.js';

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

/** Forgets the current grid set and frees its preview pictures. */
function clearState() {
  if (state) for (const url of state.pictures.values()) if (url) URL.revokeObjectURL(url);
  state = null;
}

/*
 * state = {
 *   file, zip,
 *   pages:   [{ name, entry, xml, editable, fields }],
 *   flagged: [{ key, word, short, suggestions (null while loading), slots, occurrences, row }],
 *   byPage:  Map page index → occurrences on that page,
 *   pageNames: [{ key, word, pages }],
 *   styles, entriesByName, pictures (Map name → blob URL for previews),
 * }
 * occurrence = { page, field, start, end, word, flag, include, replacement }
 * Pages also get `model` and `fieldCells` once they are previewed.
 */

const yieldToBrowser = () => new Promise((r) => setTimeout(r, 0));

async function handleFile(file) {
  if (!file) return;
  if (state && hasUnsavedChanges() && !confirm('You have corrections you have not downloaded. Check a different grid set anyway?')) return;
  const id = ++runId;
  clearState();

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
      const short = [...key].length <= 3;
      const f = { key, word, short, suggestions: short ? [] : null, slots: [], occurrences, row: null };
      for (const o of occurrences) o.flag = f;
      return f;
    });
    flagged.sort((a, b) => b.occurrences.length - a.occurrences.length || a.key.localeCompare(b.key));

    // Page names: reported, never changed here. Short letter groups are skipped.
    const nameWords = [...new Set(pages.flatMap((p) => words(p.name).map((w) => w.word)))].filter((w) => [...w].length > 3);
    const nameCorrect = await speller.request('check', nameWords);
    if (id !== runId) return;
    const pageNames = nameWords.filter((w, i) => !nameCorrect[i]).map((word) => ({
      key: normalise(word), word, pages: pages.map((p) => p.name).filter((n) => words(n).some((w) => w.word === word)),
    }));

    // Words accepted on an earlier visit are not shown at all.
    const shown = flagged.filter((f) => !accepted.has(f.key));
    const byPage = new Map();
    for (const f of shown) {
      for (const o of f.occurrences) {
        if (!byPage.has(o.page)) byPage.set(o.page, []);
        byPage.get(o.page).push(o);
      }
    }
    const stylesEntry = zip.entries.find((e) => /^Settings0[\\/]Styles[\\/]styles\.xml$/i.test(e.name));
    let styles = new Map();
    try { if (stylesEntry) styles = parseStyles(decodeXml(C.inflateEntry(stylesEntry)).xml); } catch (e) { /* preview uses plain cells */ }
    const entriesByName = new Map(zip.entries.map((e) => [e.name.replace(/\\/g, '/').toLowerCase(), e]));

    const pageOrder = pages.map((p, i) => i).sort((a, b) => pages[a].name.localeCompare(pages[b].name, 'en-GB', { numeric: true, sensitivity: 'base' }));

    state = { file, zip, pages, pageOrder, flagged: shown, byPage, pageNames, styles, entriesByName, pictures: new Map(), downloaded: true };
    showReview();
    loadSuggestions(id);
  } catch (err) {
    if (id !== runId) return;
    console.error(err);
    speller?.terminate();
    speller = null;
    showError('Something went wrong', 'The spell checker could not run in this browser. Please try again in an up-to-date Chrome or Edge.');
  }
}

/**
 * Suggestions take a while for some words, so the review is shown first and
 * suggestions fill in as they arrive, from the top of the list down.
 */
async function loadSuggestions(id) {
  const queue = state.flagged.filter((f) => f.suggestions === null);
  while (queue.length) {
    const batch = queue.splice(0, 6);
    let result;
    try {
      result = await speller.request('suggest', batch.map((f) => f.word));
    } catch (err) {
      if (id !== runId) return;
      console.error(err);
      result = batch.map(() => []);
    }
    if (id !== runId) return;
    batch.forEach((f, i) => { f.suggestions = result[i]; fillSlots(f); });
  }
}

/**
 * A place for a word's suggestion buttons. It shows "Finding suggestions…"
 * until they arrive, then fills in without redrawing anything around it.
 */
function suggestionSlot(f, label, onPick) {
  const slot = { node: el('div', { class: 'suggestions' }), label, onPick };
  f.slots = f.slots.filter((s) => s.node.isConnected);
  f.slots.push(slot);
  fillSlot(f, slot);
  return slot.node;
}

function fillSlot(f, slot) {
  if (f.suggestions === null) {
    slot.node.replaceChildren(el('span', { class: 'muted finding' }, 'Finding suggestions…'));
    return;
  }
  slot.node.replaceChildren(
    f.suggestions.length ? el('span', { class: 'muted' }, slot.label) : el('span', { class: 'muted' }, 'No suggestions. Type a correction or accept it.'),
    ...f.suggestions.map((s) => el('button', { class: 'button button-suggestion button-small', type: 'button', onclick: () => slot.onPick(s) }, s)),
  );
}

function fillSlots(f) {
  for (const slot of f.slots) if (slot.node.isConnected) fillSlot(f, slot);
}

/* ------------------------------------------------------------------ */
/* Review                                                              */
/* ------------------------------------------------------------------ */
function isAccepted(f) {
  return accepted.has(f.key);
}

const isPending = (o) => o.replacement === null && state.pages[o.page].editable;
const isOpen = (o) => o.replacement === null && !isAccepted(o.flag);

/** Dealt with: accepted, or every place that can be changed has been. */
function isDone(f) {
  return isAccepted(f) || (f.occurrences.some((o) => o.replacement !== null) && !f.occurrences.some(isPending));
}

function showReview() {
  $('review-title').textContent = state.file.name;
  const main = state.flagged.filter((f) => !f.short);
  const short = state.flagged.filter((f) => f.short);
  $('word-list').replaceChildren(...main.map(renderRow));
  $('short-list').replaceChildren(...short.map(renderRow));
  $('short-group').hidden = short.length === 0;
  $('short-title').textContent = `Short letter groups (${short.length})`;

  pageView.page = state.pageOrder.find((i) => openCount(i) > 0) ?? state.pageOrder[0] ?? 0;
  pageView.cell = null;
  $('page-filter').value = '';
  $('only-flagged').checked = state.byPage.size > 0;
  selectTab('words');
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
  const open = state.flagged.filter((f) => !isDone(f));
  const changed = state.flagged.reduce((n, f) => n + f.occurrences.filter((o) => o.replacement !== null).length, 0);
  $('review-summary').textContent = state.flagged.length === 0
    ? 'No spelling mistakes found.'
    : open.length === 0
      ? 'All flagged words have been dealt with.'
      : `${plural(open.length, 'word')} to check.`;
  $('tab-words').textContent = `Words (${open.length})`;
  $('download-button').hidden = changed === 0;
  $('review-changes').hidden = changed === 0;
  $('review-changes').textContent = `${plural(changed, 'correction')} ready. Nothing changes until you download.`;
}

function hasUnsavedChanges() {
  return state && !state.downloaded && state.flagged.some((f) => f.occurrences.some((o) => o.replacement !== null));
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
  const changed = f.occurrences.filter((o) => o.replacement !== null).length;
  return `${plural(f.occurrences.length, 'time')} on ${plural(pages, 'page')} · ${kinds.join(', ')}` +
    (changed ? ` · ${changed} already changed` : '');
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

function correctionForm(label, onChange) {
  const input = el('input', { type: 'text', class: 'fix-input', 'aria-label': label, placeholder: 'Type a correction', spellcheck: 'false', autocomplete: 'off' });
  return el('form', { class: 'fix-form', onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) onChange(v); } },
    input, el('button', { class: 'button button-secondary button-small', type: 'submit' }, 'Change'));
}

function acceptButton(f) {
  return el('button', { class: 'button button-accept button-small', type: 'button', onclick: () => { accepted.set(f.key, f.word); saveAccepted(); changed(f); } }, 'Accept');
}

function drawRow(f) {
  const row = f.row;
  row.classList.toggle('is-done', isDone(f));

  if (isAccepted(f)) {
    row.replaceChildren(el('p', { class: 'row-done' },
      el('span', { class: 'flag-word' }, f.word), ' is accepted. ',
      el('button', { class: 'link-button', type: 'button', onclick: () => { accepted.delete(f.key); saveAccepted(); changed(f); } }, 'Undo'),
    ));
    return;
  }
  if (isDone(f)) {
    const done = f.occurrences.filter((o) => o.replacement !== null);
    const all = new Set(done.map((o) => o.replacement));
    row.replaceChildren(el('p', { class: 'row-done' },
      el('span', { class: 'flag-word' }, f.word), ' → ',
      all.size === 1 ? el('strong', {}, done[0].replacement) : 'changed', ` in ${plural(done.length, 'place')}. `,
      el('button', { class: 'link-button', type: 'button', onclick: () => undoChange(f) }, 'Undo'),
    ));
    return;
  }

  const canChange = f.occurrences.some(isPending);
  const where = el('details', { class: 'where' },
    el('summary', {}, 'Show where'),
    el('ul', { class: 'where-list' }, ...f.occurrences.slice(0, MAX_SHOWN).map((o) => {
      const page = state.pages[o.page];
      const kind = KINDS[page.fields[o.field].kind];
      const box = el('input', {
        type: 'checkbox', checked: o.include && isPending(o), disabled: !isPending(o),
        'aria-label': `Change on ${page.name}`, onchange: (e) => { o.include = e.target.checked; },
      });
      return el('li', {},
        box,
        el('span', { class: 'where-text' },
          el('span', { class: 'where-page' }, page.name), el('span', { class: 'chip' }, kind),
          !page.editable ? el('span', { class: 'chip chip-warn' }, "Can't be changed") : null,
          o.replacement !== null ? el('span', { class: 'chip chip-ok' }, `Changed to ${o.replacement}`) : null,
          el('button', { class: 'link-button', type: 'button', onclick: () => showOccurrence(o) }, 'Show on page'),
          el('span', { class: 'where-context' }, ...contextFor(o)),
        ),
      );
    }), f.occurrences.length > MAX_SHOWN ? el('li', { class: 'muted' }, `And ${f.occurrences.length - MAX_SHOWN} more.`) : null),
    el('p', { class: 'muted where-hint' }, 'Untick any you want to leave as they are.'),
  );

  row.replaceChildren(
    el('div', { class: 'word-main' },
      el('span', { class: 'flag-word' }, f.word),
      el('span', { class: 'word-meta' }, describe(f)),
      el('span', { class: 'word-example' }, ...contextFor(f.occurrences.find(isOpen) || f.occurrences[0])),
    ),
    el('div', { class: 'word-fix' },
      canChange && !f.short ? suggestionSlot(f, 'Change to', (s) => applyChange(f, s, true)) : null,
      canChange ? correctionForm(`Correction for ${f.word}`, (v) => applyChange(f, v, false)) : null,
      acceptButton(f),
    ),
    where,
  );
}

/** Redraws everything that shows this word. */
function changed(f) {
  if (f.row) drawRow(f);
  updateSummary();
  if (!$('panel-pages').hidden) drawPageView();
}

function applyChange(f, replacement, fromSuggestion) {
  let n = 0;
  for (const o of f.occurrences) {
    if (!o.include || !isPending(o)) continue;
    o.replacement = fromSuggestion ? matchCase(o.word, replacement) : replacement;
    n++;
  }
  if (!n) { alert('Tick at least one place to change under "Show where".'); return; }
  state.downloaded = false;
  changed(f);
}

function changeOne(o, replacement, fromSuggestion) {
  if (!isPending(o)) return;
  o.replacement = fromSuggestion ? matchCase(o.word, replacement) : replacement;
  state.downloaded = false;
  changed(o.flag);
}

function undoChange(f) {
  for (const o of f.occurrences) o.replacement = null;
  state.downloaded = false;
  changed(f);
}

function undoOne(o) {
  o.replacement = null;
  state.downloaded = false;
  changed(o.flag);
}

function refreshAcceptedRows() {
  if (!state) return;
  for (const f of state.flagged) if (f.row) drawRow(f);
  updateSummary();
  if (!$('panel-pages').hidden) drawPageView();
}

function acceptShort() {
  for (const f of state.flagged) {
    if (f.short && !isDone(f)) accepted.set(f.key, f.word);
  }
  saveAccepted();
  refreshAcceptedRows();
}

/* ------------------------------------------------------------------ */
/* Pages: each page drawn as a preview, mistakes marked                */
/* ------------------------------------------------------------------ */
const pageView = { page: 0, cell: null };

function selectTab(name) {
  for (const t of ['words', 'pages']) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`tab-${t}`).tabIndex = t === name ? 0 : -1;
    $(`panel-${t}`).hidden = t !== name;
  }
  $('step-review').classList.toggle('is-wide', name === 'pages');
  if (name === 'pages') { drawPageList(); drawPageView(); }
}

/*
 * Short letter groups (sk, ou, nch…) are usually phonics, not mistakes, so
 * the preview leaves them out unless "Show short letter groups" is ticked.
 * The choice is remembered in this browser.
 */
const SHORT_KEY = 'gridtools.spelling.showShort';

function loadShowShort() {
  try { $('show-short').checked = localStorage.getItem(SHORT_KEY) === '1'; } catch (e) { /* storage blocked */ }
}

function setShowShort(on) {
  $('show-short').checked = on;
  try { localStorage.setItem(SHORT_KEY, on ? '1' : '0'); } catch (e) { /* storage blocked */ }
  if (state) { drawPageList(); drawPageView(); }
}

/** The flagged places on a page that the preview shows. */
function pageOccurrences(pageIndex) {
  const all = state.byPage.get(pageIndex) || [];
  return $('show-short').checked ? all : all.filter((o) => !o.flag.short);
}

/** Mistakes still to deal with on a page. */
function openCount(pageIndex) {
  return pageOccurrences(pageIndex).filter(isOpen).length;
}

function drawPageList() {
  const filter = $('page-filter').value.trim().toLowerCase();
  const only = $('only-flagged').checked;
  const items = [];
  state.pageOrder.forEach((i) => {
    const p = state.pages[i];
    const n = openCount(i);
    if (only && !n && i !== pageView.page) return;
    if (filter && !p.name.toLowerCase().includes(filter)) return;
    items.push(el('li', {}, el('button', {
      type: 'button', class: 'page-link', 'aria-current': i === pageView.page ? 'true' : false,
      onclick: () => openPage(i),
    }, el('span', { class: 'page-link-name' }, p.name), n ? el('span', { class: 'count' }, String(n)) : null)));
  });
  $('page-list').replaceChildren(...(items.length ? items : [el('li', { class: 'muted' }, 'No pages match.')]));
}

function openPage(i, cell = null) {
  pageView.page = i;
  pageView.cell = cell;
  drawPageList();
  drawPageView();
}

function showOccurrence(o) {
  if (o.flag.short && !$('show-short').checked) setShowShort(true);
  selectTab('pages');
  const cell = fieldCell(o.page, o.field);
  openPage(o.page, cell);
  // Text with no cell of its own is listed under the preview instead.
  (cell === null ? $('page-extra') : $('page-title')).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** The page's layout, read once and kept. */
function modelFor(i) {
  const page = state.pages[i];
  if (!page.model) {
    try {
      page.model = parseGrid(page.xml);
    } catch (e) {
      page.model = null;
    }
    // Word list items with no cell of their own are shown in word list cells, in order.
    const cells = page.model ? wordListCells(page.model) : [];
    let k = 0;
    page.fieldCells = page.fields.map((f) => f.cell ? f.cell.index : f.kind === 'wordlist' ? (cells[k++] ?? null) : null);
  }
  return page.model;
}

function fieldCell(pageIndex, fieldIndex) {
  modelFor(pageIndex);
  return state.pages[pageIndex].fieldCells[fieldIndex];
}

/** A field's text with corrections applied, and the words to mark. */
function displayText(pageIndex, fieldIndex) {
  const field = state.pages[pageIndex].fields[fieldIndex];
  const occs = pageOccurrences(pageIndex).filter((o) => o.field === fieldIndex).sort((a, b) => a.start - b.start);
  let text = '';
  let last = 0;
  const marks = [];
  for (const o of occs) {
    text += field.text.slice(last, o.start);
    const shown = o.replacement ?? o.word;
    if (o.replacement !== null) marks.push({ start: text.length, end: text.length + shown.length, cls: 'fixed' });
    else if (!isAccepted(o.flag)) marks.push({ start: text.length, end: text.length + shown.length, cls: 'misspelt' });
    text += shown;
    last = o.end;
  }
  text += field.text.slice(last);
  return { text, marks };
}

function pictureUrl(pageName, fileName) {
  const name = `grids/${pageName}/${fileName}`.toLowerCase();
  if (state.pictures.has(name)) return state.pictures.get(name);
  let url = null;
  const entry = state.entriesByName.get(name);
  if (entry && !/\.(wmf|emf)$/i.test(fileName)) {
    try {
      const bytes = C.inflateEntry(entry);
      const type = { png: 'image/png', jpeg: 'image/jpeg' }[C.sniff(bytes)] || '';
      url = URL.createObjectURL(new Blob([bytes], type ? { type } : {}));
    } catch (e) { /* damaged picture: show the placeholder */ }
  }
  state.pictures.set(name, url);
  return url;
}

function drawPageView() {
  const i = pageView.page;
  const page = state.pages[i];
  const model = modelFor(i);
  $('page-title').textContent = page.name;
  const n = openCount(i);
  $('page-status').textContent = n ? `${plural(n, 'word')} to check on this page.` : 'Nothing to check on this page.';

  if (!model) {
    $('page-preview').replaceChildren(el('p', { class: 'muted' }, "This page can't be shown."));
  } else {
    const text = new Map();
    const flags = new Map();
    page.fields.forEach((f, fi) => {
      const cell = page.fieldCells[fi];
      if (cell === null) return;
      if (f.kind === 'caption' || f.kind === 'wordlist') text.set(cell, displayText(i, fi));
    });
    for (const o of pageOccurrences(i)) {
      const cell = page.fieldCells[o.field];
      if (cell === null || !isOpen(o)) continue;
      const fl = flags.get(cell) || { count: 0, label: '' };
      fl.count++;
      fl.label = `${plural(fl.count, 'word')} to check`;
      flags.set(cell, fl);
    }
    const frame = renderPage({
      model, styles: state.styles, text, flags, selected: pageView.cell,
      picture: (name) => pictureUrl(page.name, name),
      onSelect: (cell) => {
        pageView.cell = cell;
        drawPageView();
        $('cell-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      },
    });
    $('page-preview').replaceChildren(frame);
    requestAnimationFrame(() => fitCaptions(frame));
  }
  drawCellPanel();
}

/** One flagged word in the cell panel, with its own fix buttons. */
function occurrenceControls(o) {
  const f = o.flag;
  if (isAccepted(f)) {
    return el('p', { class: 'occ occ-done' }, el('span', { class: 'occ-word' }, f.word), ' is accepted.');
  }
  if (o.replacement !== null) {
    return el('p', { class: 'occ occ-done' },
      el('span', { class: 'occ-word' }, o.word), ' → ', el('strong', {}, o.replacement), '. ',
      el('button', { class: 'link-button', type: 'button', onclick: () => undoOne(o) }, 'Undo'));
  }
  const others = f.occurrences.filter((x) => x !== o && isPending(x)).length;
  return el('div', { class: 'occ' },
    el('div', { class: 'occ-head' },
      el('span', { class: 'flag-word occ-word' }, o.word),
      others ? el('button', { class: 'link-button', type: 'button', onclick: () => showWord(f) }, `Change all ${others + 1} places`) : null),
    !isPending(o) ? el('p', { class: 'muted' }, "This page can't be changed.")
      : f.short ? null : suggestionSlot(f, 'Change here to', (s) => changeOne(o, s, true)),
    el('div', { class: 'word-fix' },
      isPending(o) ? correctionForm(`Correction for ${o.word} here`, (v) => changeOne(o, v, false)) : null,
      acceptButton(f)),
  );
}

function fieldBlock(pageIndex, fieldIndex, occs) {
  const field = state.pages[pageIndex].fields[fieldIndex];
  const { text, marks } = displayText(pageIndex, fieldIndex);
  return el('div', { class: 'field' },
    el('span', { class: 'chip' }, KINDS[field.kind]),
    el('p', { class: 'field-text' }, ...markText(text, marks)),
    ...occs.map(occurrenceControls),
  );
}

function markText(text, marks) {
  const out = [];
  let last = 0;
  for (const m of marks) {
    out.push(text.slice(last, m.start), el('mark', { class: m.cls }, text.slice(m.start, m.end)));
    last = m.end;
  }
  out.push(text.slice(last));
  return out;
}

function drawCellPanel() {
  const i = pageView.page;
  const page = state.pages[i];
  const occs = pageOccurrences(i);
  const panel = $('cell-panel');
  const blocks = (pred) => page.fields.map((f, fi) => [f, fi]).filter(([, fi]) => pred(page.fieldCells[fi]))
    .map(([, fi]) => fieldBlock(i, fi, occs.filter((o) => o.field === fi)));

  // Mistakes in text with no cell on screen, such as word list items beyond the last word list cell.
  const loose = page.fields.map((f, fi) => fi).filter((fi) => page.fieldCells[fi] === null && occs.some((o) => o.field === fi));
  $('page-extra').replaceChildren(...(loose.length ? [
    el('h5', { class: 'panel-title' }, 'Also on this page'),
    el('p', { class: 'muted' }, 'Text that has no cell of its own in the preview.'),
    ...loose.map((fi) => fieldBlock(i, fi, occs.filter((o) => o.field === fi))),
  ] : []));

  if (pageView.cell === null || !page.model) {
    panel.replaceChildren(el('p', { class: 'muted' }, page.model ? 'Select a cell to see its text. Cells with a number have words to check.' : ''));
    return;
  }
  const cell = page.model.cells[pageView.cell];
  const target = cell.jump && state.pages.findIndex((p) => p.name === cell.jump);
  const fields = blocks((c) => c === pageView.cell);
  panel.replaceChildren(...[
    el('h5', { class: 'panel-title' }, `Cell in row ${cell.y + 1}, column ${cell.x + 1}`),
    cell.jump ? el('p', { class: 'jump' }, 'Opens the page ', el('strong', {}, cell.jump), ' ',
      target >= 0 ? el('button', { class: 'link-button', type: 'button', onclick: () => openPage(target) }, 'Go to this page') : el('span', { class: 'chip chip-warn' }, 'Page not found')) : null,
    ...(fields.length ? fields : [el('p', { class: 'muted' }, 'This cell has no text to check.')]),
  ].filter(Boolean));
}

function showWord(f) {
  selectTab('words');
  if (f.short) $('short-group').open = true;
  f.row.querySelector('details.where')?.setAttribute('open', '');
  f.row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  f.row.classList.add('is-flash');
  setTimeout(() => f.row.classList.remove('is-flash'), 1600);
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
  clearState();
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

$('cancel-button').addEventListener('click', () => { runId++; clearState(); show('step-choose'); });
$('again-button').addEventListener('click', reset);
$('error-button').addEventListener('click', reset);
$('download-button').addEventListener('click', download);
$('accept-short').addEventListener('click', acceptShort);
$('export-button').addEventListener('click', exportAccepted);
$('import-input').addEventListener('change', (e) => importAccepted(e.target.files[0]));

$('tab-words').addEventListener('click', () => selectTab('words'));
$('tab-pages').addEventListener('click', () => selectTab('pages'));
$('tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const next = $('tab-words').getAttribute('aria-selected') === 'true' ? 'pages' : 'words';
  selectTab(next);
  $(`tab-${next}`).focus();
});
$('page-filter').addEventListener('input', drawPageList);
$('only-flagged').addEventListener('change', drawPageList);
$('show-short').addEventListener('change', (e) => setShowShort(e.target.checked));
loadShowShort();

// Captions are fitted to the preview's size, so redraw when the window changes size.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state && !$('panel-pages').hidden) drawPageView(); }, 200);
});

window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedChanges()) { e.preventDefault(); e.returnValue = ''; }
});
