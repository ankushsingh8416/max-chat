import CSSMatrix from "dommatrix";

/**
 * pdfjs-dist (used internally by pdf-parse) references `DOMMatrix` in
 * top-level module code (`const SCALE_MATRIX = new DOMMatrix();`), which
 * throws `ReferenceError: DOMMatrix is not defined` in Node the moment the
 * module is imported — it only falls back to this at all when the optional,
 * platform-specific native package `@napi-rs/canvas` fails to load, which is
 * exactly what happens on Vercel (its file tracer doesn't reliably include
 * that native binary). Since this app only extracts text
 * (`extractPdfTextFromBuffer`/`extractPdfText`) and never rasterizes or
 * renders PDF pages, a pure-JS, DOMMatrix-compatible shim is enough — no
 * native dependency needed. pdfjs-dist checks `globalThis.DOMMatrix` first
 * and skips its own fallback entirely when it's already set.
 *
 * Must be imported before any `pdf-parse`/`pdfjs-dist` import (see pdf.ts) —
 * ES module `import` declarations evaluate fully, in source order, before
 * the importing module's own body runs, so being the first import here
 * guarantees this global is set before pdfjs-dist's own top-level code runs.
 */
if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = CSSMatrix as unknown as typeof DOMMatrix;
}
