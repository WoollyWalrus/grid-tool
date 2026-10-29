# Hunspell in the browser

`hunspell.min.mjs` is [hunspell-asm](https://github.com/kwonoj/hunspell-asm) 4.0.2
(Hunspell compiled to WebAssembly, with the WebAssembly built into the file), bundled
into a single ES module from `entry.mjs`. To rebuild it:

```sh
npm install hunspell-asm@4.0.2 esbuild@0.23.1
npx esbuild entry.mjs --bundle --format=esm --platform=browser --minify --legal-comments=eof --outfile=hunspell.min.mjs
```

The build expects a classic Web Worker. `assets/js/spell.mjs` fills in the two
things module workers and Node lack (`importScripts` and `location`) before loading it.
