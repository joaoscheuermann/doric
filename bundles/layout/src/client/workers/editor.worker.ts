// Monaco's editor worker, built by `bundle build` into
// `dist/client/workers/editor.worker.js` (stage 9 §3.2) and started by the
// provisional files feature's code view (`new URL('./workers/editor.worker.js',
// import.meta.url)`). It is the only worker the read-only editors need.
import 'monaco-editor/editor/editor.worker.js';
