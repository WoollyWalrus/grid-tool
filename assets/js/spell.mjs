/*
 * Grid set Spell Checker — checking words against a British English
 * dictionary (Hunspell rules, via nspell). Runs in a Web Worker in the
 * page and directly in Node for the test suite.
 */
import nspell from '../vendor/nspell/nspell.min.mjs';

/**
 * Words Grid 3 and CandLE grids use that the dictionary doesn't know.
 * Add to this list in a pull request; users add their own words in the page.
 */
export const BUILT_IN_WORDS = [
  'Grid', 'gridset', 'gridsets', 'Widgit', 'Symoji', 'Smartbox', 'CandLE',
  'eye-gaze', 'emoji', 'emojis', 'login', 'logout', 'touchscreen',
];

/** Accepted words are compared ignoring case and apostrophe style. */
export function normalise(word) {
  return word.replace(/’/g, "'").toLowerCase();
}

export function createChecker(aff, dic) {
  const speller = nspell(aff, dic);
  for (const w of BUILT_IN_WORDS) speller.add(w);
  const cache = new Map();

  function isCorrect(word) {
    const w = word.replace(/’/g, "'");
    if (!cache.has(w)) cache.set(w, speller.correct(w));
    return cache.get(w);
  }

  function suggest(word) {
    return speller.suggest(word.replace(/’/g, "'")).slice(0, 5);
  }

  return { isCorrect, suggest };
}
