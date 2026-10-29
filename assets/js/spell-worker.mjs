/*
 * Background worker: loads the dictionary once, then checks words and
 * finds suggestions without freezing the page.
 */
import { createChecker } from './spell.mjs';

let ready = null;

async function load() {
  const dir = new URL('../vendor/dictionary-en-gb/', import.meta.url);
  const [aff, dic] = await Promise.all(['en-gb.aff', 'en-gb.dic'].map(async (name) => {
    const res = await fetch(new URL(name, dir));
    if (!res.ok) throw new Error(`Could not load ${name}`);
    return new Uint8Array(await res.arrayBuffer());
  }));
  return createChecker(aff, dic);
}

self.onmessage = async (e) => {
  const { id, type, words } = e.data;
  try {
    ready ||= load();
    const checker = await ready;
    let result;
    if (type === 'check') result = words.map((w) => checker.isCorrect(w));
    else if (type === 'suggest') result = words.map((w) => checker.suggest(w));
    else throw new Error(`Unknown request: ${type}`);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
