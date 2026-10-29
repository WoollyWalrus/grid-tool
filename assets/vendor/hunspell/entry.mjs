// Bundled into assets/vendor/hunspell/hunspell.min.mjs with esbuild.
// hunspell-asm's ES module build imports CommonJS files as namespaces,
// which breaks once bundled, so the same pieces are wired together here.
import { getModuleLoader } from 'emscripten-wasm-loader';
import { hunspellLoader } from 'hunspell-asm/dist/cjs/hunspellLoader.js';
import runtime from 'hunspell-asm/dist/cjs/lib/browser/hunspell.js';

export const loadModule = () => getModuleLoader((r) => hunspellLoader(r), runtime, undefined, {})();
