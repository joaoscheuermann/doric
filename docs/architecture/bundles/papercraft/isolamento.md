# Papercraft: o preview num iframe isolado

**Estado:** aprovado pelo usuário em 2026-10-27 e implementado: o documento do frame, o runtime, a superfície sobre o protocolo, o build sem container de portal, o teto de 3 frames vivos por janela com snapshots, `doric.windows/v1.capture` e `papercraft.snapshot/v1`. Substitui a decisão "Nada de iframe" da primeira versão do [desenho do papercraft](README.md#resumo) e os trechos do `GROUNDING.md` que diziam que o módulo do preview roda no realm do app; os dois já foram reescritos.

## Por quê

Antes deste desenho, o módulo de uma revisão (`doric://app/artifacts/<id>@<rev>/index.js`) era importado no realm do app e montado num shadow root (`src/client/surface/preview-surface.tsx`). O shadow root isola o DOM e o CSS, não o JavaScript: todos os previews dividiam a `window`, o registro de custom elements, os globais e o canal de erros do app — e alcançavam `window.doric.desktop`, a ponte do preload. O sintoma visível foi o React #520 de revisões antigas que disputavam o mesmo tag de custom element; o motivo de fundo era que código do Project rodava com os poderes do app.

## Decisão

Cada preview roda num `<iframe sandbox="allow-scripts">` sem `allow-same-origin`: origem opaca (`null`), realm próprio, sem preload, sem storage persistente do app e sem acesso ao DOM do app. O app e o frame só conversam por um `MessageChannel`.

O que deixa de existir: o container de portal passado em `context.papercraft.portalContainer` (o `document.body` do frame é do preview), a reescrita de `:root` em `:host` do CSS do preview, o reset do shadow root, o wrapper `.dark` em volta da raiz e do portal, e a disputa por globais e tags entre revisões.

Decisões do usuário (2026-10-27):

1. Storage em memória: o runtime do frame instala `localStorage` e `sessionStorage` em memória, porque numa origem opaca eles lançam erro. Nada persiste.
2. No máximo **3 frames vivos**: os 3 usados por último (publicado, visível ou com ponteiro/clique). Os outros mostram um snapshot; ver [Virtualização](#virtualização).
3. Sem escopo de artifacts por capacidade: o CORS fica restrito por prefixo.
4. O runtime do frame é um asset do bundle `papercraft`, não um pacote de plataforma.
5. O custo de cada frame avaliar o próprio React fica para otimizar depois.

## Contratos entre as partes

Estes contratos são o que as fases implementam em paralelo; mudá-los exige combinar entre as partes.

### O documento do frame (plataforma)

- `doric://app/frame/index.html?entry=<URL do runtime>`: um documento mínimo servido pelo main, com `<script type="importmap">` próprio e `<body>` vazio.
- O import map do frame tem só os externos de um preview: `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`, `react-dom/client` e os especificadores `@base-ui/react/*` do mapa da plataforma, como URLs absolutas `doric://app/platform/…`.
- `doric://app/frame/boot.js` lê `entry`, aceita só `doric://app/bundles/<id>@<versão>/client/frames/<nome>.js` e importa esse módulo.
- CSP do frame, em cabeçalho: `default-src 'none'; script-src doric://app 'sha256-<import map>'; style-src doric://app 'unsafe-inline'; font-src doric://app; img-src doric://app data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors doric://app`. A origem é opaca, então `'self'` não serve.
- CSP do shell: ganha `frame-src doric://app/frame/`.
- `Access-Control-Allow-Origin: *` só em `/frame/*`, `/platform/*`, `/artifacts/*` e `/bundles/<id>@<versão>/client/frames/*`. `/bundles/*` fora de `client/frames`, `/schemas/*` e o shell continuam sem CORS.
- Um frame de preview só navega para `doric://app/frame/index.html` (`will-frame-navigate`); o dispatcher já recusa IPC de subframes e o preload não roda neles.
- Processo: iframes sandboxed num processo de renderer separado do app quando o Chromium do Electron o fizer (`IsolateSandboxedIframes`); o isolamento de realm e de origem não depende disso.

### Frames de bundle (`packages/bundle`)

- `src/client/frames/*.ts` de um bundle vira `dist/client/frames/<nome>.js`: um módulo ESM próprio, com os externos do import map do frame (não os do client) e nada do client embutido além do que importa.

### O runtime do preview (`bundles/features/papercraft/src/client/frames/preview.ts`)

- Recebe a porta do canal numa única mensagem de janela e daí em diante só fala por ela.
- Monta a revisão: importa `index.js` e chama `mount(root, { theme })` num `#root` no `<body>` (o contrato de sempre, então revisões antigas montam sem mudança), liga `index.css` por `<link>`, ou renderiza o markup do caminho A.
- Tema no `<html>` (`class="dark"`), trocável ao vivo. Storage em memória. Erros de React e da janela do frame viram mensagens `error`.
- Deriva o scene graph do próprio DOM e o envia serializado, com bounds em px CSS do frame (o app escala o iframe por `transform`, então as medidas não dependem do zoom).
- Aplica camadas ocultas e o cursor travado que o app pede; repassa ponteiro, roda e teclas que o app usa, com o nó sob o ponteiro.

### O protocolo

`bundles/features/papercraft/src/client/frame-protocol.ts` define as mensagens, a versão e os schemas que o app usa para validar o que vem do frame — tudo o que vem do frame é dado não confiável.

### O snapshot (`papercraft.snapshot/v1`)

- Contrato desktop do papercraft: a janela pede a captura de um retângulo seu (px CSS da janela) e recebe um PNG. O main captura por `webContents.capturePage`, o que funciona com frames de origem opaca.

## Fases

| Fase             | Entrega                                                                                                                                    | Prova                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0–1. Plataforma  | Documento do frame, `boot.js`, CSP, CORS por prefixo, guarda de navegação, verificação do processo separado                                | Testes de protocolo em `doric-app`; prova no Electron (`doric-e2e`): o frame carrega, importa o React da plataforma, monta um módulo de artifact, não vê `window.doric` e não navega |
| 2. Runtime       | `src/client/frames/preview.ts` e o suporte a frames em `packages/bundle`                                                                   | Testes do runtime em happy-dom falando o protocolo                                                                                                                                   |
| 3. Surface       | O app sobre o protocolo: iframe no lugar do shadow root; scene, gestos, foco, fit e pins sobre nós serializados; caminho A dentro do frame | Testes de `surface`, `element`, `scene` e `pins` contra um runtime falso                                                                                                             |
| 4. Build         | Entry sem container de portal, CSS sem `:host`, harness sem o substituto do addon-themes; revisões antigas continuam montando              | `module-mount`, `compile`, `harness` e uma fixture de revisão no formato antigo                                                                                                      |
| 5. Virtualização | Teto de 3 frames vivos, snapshots e `papercraft.snapshot/v1`                                                                               | Testes da política e do contrato de captura                                                                                                                                          |
| 6. Limpeza       | Harnesses sem `portalContainer`, skill, READMEs, `GROUNDING.md` e o desenho do papercraft                                                  | `format:check`, `lint`, `git diff --check`                                                                                                                                           |

## Virtualização

- **Vivos:** os 3 frames usados por último; um preview novo despeja o menos recente. A revisão aberta no modal fica sempre viva: o modal monta uma segunda superfície, fora do limite.
- **Uso:** ser publicado, ficar visível, ou receber ponteiro ou clique. Rolar até um preview antigo não basta para promovê-lo, para não despejar os recentes.
- **Snapshot:** quando um frame vivo fica estável na tela, a janela captura o retângulo dele por `papercraft.snapshot/v1` e guarda a imagem pela chave artifact, revisão, tema e largura (revisões são imutáveis). Um frame morto mostra o snapshot no mesmo tamanho, com o último scene serializado, então pins, contornos e comentários continuam aparecendo.
- **Promoção:** ponteiro ou clique num preview morto o remonta; o snapshot fica até o frame novo avisar que renderizou. O estado interativo de um frame morto (uma seção aberta, um texto digitado) se perde.
- **Sem snapshot ainda:** um placeholder com o tamanho e o título do preview.

## Riscos aceitos

- O primeiro paint de cada preview fica mais lento: cada frame avalia o próprio React (otimizar depois).
- Um componente que dependa de storage persistente ou de cookies vê só a memória do frame.
- Revisões publicadas antes deste desenho passam a montar dentro do frame com o mesmo `mount`, mas trazem o container de portal e o CSS com `:host` delas: ficam isoladas, sem ganhar as simplificações.
