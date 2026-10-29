/*
 * Grid set Spell Checker — checking words against a British English
 * dictionary with Hunspell, the spell checker used by LibreOffice. Runs in
 * a Web Worker in the page and directly in Node for the test suite.
 */

/**
 * Words Grid 3 and CandLE grids use that the dictionary doesn't know.
 * Add to this list in a pull request; users add their own words in the page.
 */
export const BUILT_IN_WORDS = [
  'Grid', 'gridset', 'gridsets', 'Widgit', 'Symoji', 'Smartbox', 'CandLE',
  'eye-gaze', 'emoji', 'emojis', 'login', 'logout', 'touchscreen',
];

/**
 * Real words that should never be offered as a correction in a school tool.
 * They are still accepted if a grid uses them. Add to this list as needed.
 */
export const NEVER_SUGGEST = new Set([
  'perv', 'pervo', 'pervy', 'niggard', 'niggardly', 'nigga', 'nigger', 'fag', 'faggot', 'tit', 'tits',
  'twat', 'wank', 'wanker', 'shit', 'fuck', 'cunt', 'cock', 'dick', 'prick', 'bitch', 'bastard', 'slut', 'whore',
  'retard', 'spastic', 'spaz', 'mong',
]);

/** Accepted words are compared ignoring case and apostrophe style. */
export function normalise(word) {
  return word.replace(/’/g, "'").toLowerCase();
}

async function loadHunspell() {
  // The Hunspell build expects a classic Web Worker. Module workers and Node
  // have no importScripts, and Node has no location; neither is used, because
  // the WebAssembly is built into the file.
  globalThis.self ??= globalThis;
  globalThis.importScripts ??= () => { throw new Error('importScripts is not available'); };
  globalThis.location ??= { href: import.meta.url };
  const { loadModule } = await import('../vendor/hunspell/hunspell.min.mjs');
  return loadModule();
}

/* ------------------------------------------------------------------ */
/* Ordering suggestions                                                */
/* ------------------------------------------------------------------ */

/**
 * Is `candidate` the British spelling of the American `word`?
 * mold → mould, color → colour, organize → organise, center → centre,
 * traveled → travelled, defense → defence, catalog → catalogue.
 */
export function isBritishSpelling(word, candidate) {
  const w = word.toLowerCase();
  const c = candidate.toLowerCase();
  if (c.length <= w.length) {
    return c.length === w.length && c !== w && (c.replace(/is/g, 'iz') === w || c.replace(/ys/g, 'yz') === w ||
      (w.endsWith('er') && c === w.slice(0, -2) + 're') || (w.endsWith('ense') && c === w.slice(0, -4) + 'ence'));
  }
  if (c === w + 'ue') return true;
  // One extra letter: ou (colour, mould), ll (travelled), ae or oe (anaemia, foetus).
  if (c.length !== w.length + 1) return false;
  for (let i = 1; i < c.length; i++) {
    const pair = c[i - 1] + c[i];
    const added = (pair === 'ou' || pair === 'll') ? i : (pair === 'ae' || pair === 'oe') ? i - 1 : -1;
    if (added >= 0 && c.slice(0, added) + c.slice(added + 1) === w) return true;
  }
  return false;
}

/** Letters added, removed, changed or swapped to turn a into b. */
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * Hunspell's suggestions, reordered for grids: the British spelling of an
 * American word first, then the same word with different capitals
 * (christmas → Christmas), then the closest words, with a missing letter
 * (Delet → Delete) counted as the closest of all, then Hunspell's own
 * order. Names (words the
 * dictionary only knows with a capital, such as Delft) are moved below
 * ordinary words, and splits that leave a single letter ("spike y") are dropped.
 *
 * `isName(text)` says whether a suggestion is a name.
 */
export function rankSuggestions(word, suggestions, isName = () => false) {
  const lower = word === word.toLowerCase();
  const curly = word.includes('’');
  const seen = new Set();
  const ranked = [];
  suggestions.forEach((s, i) => {
    // The dictionary writes apostrophes as ’; match the grid's own style.
    const text = curly ? s : s.replace(/’/g, "'");
    if (seen.has(text) || text === word) return;
    if (text.toLowerCase().split(/[\s-]+/).some((p) => NEVER_SUGGEST.has(p.replace(/[’']s$/, '')))) return;
    seen.add(text);
    const parts = text.split(/[\s-]+/);
    if (parts.length > 1 && parts.some((p) => p.length < 2)) return;
    const distance = editDistance(word.toLowerCase(), text.toLowerCase());
    let score = distance * 10 + i;
    if (distance === 1 && text.length === word.length + 1) score -= 8;
    if (isBritishSpelling(word, text)) score -= 1000;
    else if (text.toLowerCase() === word.toLowerCase()) score -= 500;
    else if (isName(text) || (lower && text[0] !== text[0].toLowerCase())) score += 50;
    if (parts.length > 1) score += 5;
    ranked.push({ text, score });
  });
  return ranked.sort((a, b) => a.score - b.score).map((r) => r.text);
}

/* ------------------------------------------------------------------ */
/* Checker                                                             */
/* ------------------------------------------------------------------ */

/** aff and dic are the dictionary files' bytes (Uint8Array). */
export async function createChecker(aff, dic) {
  const factory = await loadHunspell();
  const hunspell = factory.create(factory.mountBuffer(aff), factory.mountBuffer(dic));
  for (const w of BUILT_IN_WORDS) hunspell.addWord(w);
  const cache = new Map();

  function isCorrect(word) {
    if (!cache.has(word)) cache.set(word, hunspell.spell(word));
    return cache.get(word);
  }

  function suggest(word, limit = 5) {
    const isName = (s) => s[0] !== s[0].toLowerCase() && !hunspell.spell(s.toLowerCase());
    return rankSuggestions(word, hunspell.suggest(word), isName).slice(0, limit);
  }

  return { isCorrect, suggest };
}
