// The renderer chunk's sheet (conversation-openui.md D29, "CSS"; openui.md
// D31): Doric's tokens, which state the layer order `openui, openui-doric`
// first, then react-ui's layered sheet. Built as its own chunk so its CSS is
// `client/chunks/renderer-styles.css`, which the entry links before it imports
// the renderer; the renderer module itself imports no CSS, so it also loads
// where no bundler is (the client tests run it under Node).

import '../tokens.css';
import '@openuidev/react-ui/layered/styles/index.css';
