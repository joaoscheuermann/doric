# Pacotes compartilhados e tokens do tema

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

O app fornece aos bundles um conjunto fixo de pacotes client, pré-construídos como ESM e versionados junto com a plataforma: React, Lexical, os componentes shadcn de `desktop-ui`, suas dependências, o tema e o subpath browser-safe `bundle/contracts`. Os bundles os consomem como dependências externas, resolvidas por um import map que o main injeta em cada janela, em vez de embutir cópias próprias. O CSS segue a mesma ideia: o tema emite uma única vez o preflight, os tokens e os estilos dos componentes, e cada bundle compila só os utilitários Tailwind das próprias classes. Os tokens do tema são definidos uma vez em `packages/desktop-ui` e publicados pelo contrato `doric.tokens/v1`, com uma saída CSS para os bundles e uma saída JSON para o main. `packages/desktop-client` é um pacote novo: o runtime client do loader, usado por `app/doric-renderer`, e nenhum bundle o importa.

## Pacotes compartilhados da plataforma

React, Lexical, shadcn, Tailwind e o tema principal passam a ser pacotes compartilhados da plataforma. Monaco, xterm e a geometria atual continuam dependências dos respectivos bundles padrão.

O app fornece um conjunto fixo de pacotes, pré-construídos como ESM e versionados junto com a plataforma. Os bundles os consomem como dependências externas, em vez de embutir cópias próprias:

| Especificador                                                 | Conteúdo                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime` | Uma instância única de React 19                                                                                                                                                                                                                                                                                                                                    |
| `lexical`, `@lexical/*`                                       | Singleton do editor, exigido pelas classes de node registradas                                                                                                                                                                                                                                                                                                     |
| `desktop-ui/<componente>`                                     | Todos os componentes do registro shadcn, gerados pelo CLI no estilo atual, mais `cn`                                                                                                                                                                                                                                                                               |
| `radix-ui`, `lucide-react`, `@tanstack/react-query`           | Dependências dos componentes e da camada de dados                                                                                                                                                                                                                                                                                                                  |
| `desktop-ui/theme.css`                                        | Preflight, tokens, fontes vendorizadas e estilos base, carregado pelo shell em toda janela                                                                                                                                                                                                                                                                         |
| `desktop-ui/tailwind.css`                                     | Entrada de referência para o Tailwind de cada bundle, sem emitir CSS                                                                                                                                                                                                                                                                                               |
| `bundle/contracts`                                            | Subpath browser-safe de `packages/bundle`: funções `define*` e `ref`, tipos `HostContext`, `DesktopContext`, `ClientContext`, `Services` e `Call`, constantes dos contratos `doric.*` da plataforma (inclusive `DoricTokensV1`) e as referências e os tipos dos contratos básicos, como `UiV1`, `NavigationV1`, `RegionsV1`, `CommandsV1`, `WindowsV1` e `MenusV1` |

`packages/desktop-client` não aparece na tabela porque não é um pacote compartilhado com os bundles. Ele é o runtime client do loader que `app/doric-renderer` usa para ativar as partes `client` de cada janela, montar o `ClientContext` e ligar a ponte com o main; os bundles não o importam e chegam a esse runtime só pelos serviços de `ctx.services`. As referências e os tipos de `ui/v1`, `navigation/v1`, `regions/v1` e dos demais contratos básicos ficam em `bundle/contracts`, não em `desktop-client` nem em `core/contracts`; as definições com `execute` vêm de quem fornece o serviço, que é o core por padrão, e qualquer bundle pode fornecer a sua com `defineService(UiV1, {...})`. `core/contracts` traz só o que é do core (`CoreHooksV1` e `OpenSettingsCommandV1`, a referência ao comando `core.open-settings/v1`), e os contratos de outros bundles vêm de `<bundle>/contracts`; esses entrypoints pertencem aos bundles, não aos pacotes da plataforma. Nenhum código importa o entrypoint `bundle`, que é o loader Node.

`desktop-ui` continua com os componentes, os tokens e a entrada do Tailwind.

### Import map por janela

No boot de cada janela, o main gera o import map da plataforma e o injeta no shell antes de qualquer módulo. Um import map não muda depois de carregado, então a versão dos pacotes fica fixa durante a vida da janela, o que combina com a regra de recarregar para trocar de geração (ver [composição e distribuição pelo host](./composition-and-distribution.md)):

```html
<script type="importmap">
  {
    "imports": {
      "react": "doric://app/platform/react@19.2.0/index.js",
      "react/jsx-runtime": "doric://app/platform/react@19.2.0/jsx-runtime.js",
      "lexical": "doric://app/platform/lexical@0.51.0/index.js",
      "desktop-ui/": "doric://app/platform/desktop-ui@1.0.0/",
      "bundle/contracts": "doric://app/platform/bundle@1.0.0/contracts.js"
    }
  }
</script>
```

Os endereços `doric://app/platform/...` são servidos pela origem única descrita em [protocolo `doric://`](./doric-protocol.md).

### Externals e compatibilidade

Cada bundle compila com esses especificadores como `externals`. Como a plataforma muda de major quando um desses pacotes muda de major, `engines.doric` basta para garantir a compatibilidade; uma faixa incompatível coloca a parte client em quarentena antes do import (ver [versionamento](./versioning.md) e [bundle core e quarentena](./core.md)).

Um bundle pode dispensar esses pacotes, por exemplo escrevendo Web Components sem React: só `theme.css` é carregado sempre, e os outros só quando importados.

## `desktop-ui` e o registro shadcn

Os componentes shadcn saem de `app/doric-renderer/src/components/ui` para `packages/desktop-ui`, que passa a ser a fronteira vendorizada. O `components.json` muda junto, e o pacote recebe o registro completo pelo CLI (`npx shadcn add --all`). A mudança é uma regeneração com proveniência, não uma movimentação manual de pastas.

## A regra do Tailwind

O Tailwind gera CSS a partir das classes encontradas no código-fonte, e cada bundle é compilado separadamente. A regra é:

- `desktop-ui/theme.css` emite uma única vez o preflight, as variáveis dos tokens e as classes usadas pelos componentes de `desktop-ui`.
- Cada bundle compila só os utilitários das suas próprias classes, referenciando os tokens da plataforma sem emiti-los de novo, dentro da camada `utilities`. Classes repetidas entre bundles geram regras idênticas, e as camadas fixam a ordem.
- Bundles não estendem `@theme` nem criam tokens; valores novos de design entram nos tokens da plataforma.

Esboço do CSS de um bundle (a sintaxe exata do Tailwind 4 será validada na primeira extração):

```css
/* bundles/features/git/client/styles.css */
@reference 'desktop-ui/tailwind.css';
@import 'tailwindcss/utilities.css' layer(utilities);
@source '../src';
```

## Tokens do tema

O app fornece o tema principal para todos os bundles pelo contrato `doric.tokens/v1`. Os tokens são definidos uma vez, num arquivo fonte de `packages/desktop-ui`, e o build gera duas saídas: variáveis CSS em `theme.css` para os bundles e um JSON para o main, que precisa de medidas e cores sem ler CSS.

| Grupo      | Exemplos                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------- |
| Cores      | `--background`, `--foreground`, `--primary`, `--muted`, `--border`, `--sidebar-*`, nos nomes shadcn |
| Forma      | `--radius`, espaçamentos e tamanhos de fonte                                                        |
| Tipografia | `--font-sans`, `--font-mono`, com as fontes vendorizadas                                            |
| Janela     | `--doric-titlebar-height`, `--doric-window-background`, `--doric-safe-top`, `--doric-safe-left`     |

O uso dos tokens de janela pelo main e pela área segura está em [aparência nativa da janela](./window-appearance.md).

### Variantes de tema

Uma contribuição `theme` é uma variante dos valores dos tokens da plataforma e não redefine a estrutura do tema. Ela pode trocar valores, por exemplo uma variante de alto contraste, mas não cria nem remove tokens. Componentes de qualquer bundle que usam os tokens seguem a variante escolhida. O catálogo de contribuições client, onde `theme` aparece ao lado das outras, está em [UI composta por bundles](./ui-composition.md).

## Pacotes removidos e reduzidos

- `packages/host` foi removido. Os tipos do objeto `Host` por prompt estão em `bundles/runtime/runtime/src/contracts/tool-host`, exportados por `runtime/contracts`.
- `packages/desktop-reads` e `packages/desktop-ui` mantêm só primitivos genéricos: fila de atualização, utilitários de caminho, componentes de árvore e painel, e tokens. Leituras e UI que nomeiam um conceito de bundle (arquivos, Git, mudanças) passam para o bundle dono: as leituras de arquivos e de Git estão em `bundles/features/files/src/client/reads` e `bundles/features/git/src/client/reads`. Ainda há resíduos de conceito de Git em `packages/desktop-ui/src/code`, a conferir na BWP-11.

## Relações

- [UI composta por bundles](./ui-composition.md): os Web Components e as contribuições client, incluindo `theme`, são construídos sobre estes pacotes e tokens.
- [React dentro de Web Components](./react-web-components.md): usa a instância única de React fornecida pelo import map; a referência a `ui/v1` (`UiV1`) e os tipos `ClientContext` e `Services` vêm de `bundle/contracts`, e a definição de `ui/v1` com `execute` vem do core por padrão e o bundle a obtém por `services.use`. Bundles não importam `desktop-client`, que é o runtime client do loader em `app/doric-renderer`.
- [Protocolo `doric://`](./doric-protocol.md): serve os pacotes da plataforma na origem `doric://app` referenciada pelo import map.
- [Aparência nativa da janela](./window-appearance.md): consome os tokens de janela, em CSS no renderer e em JSON no main.
- [Versionamento semântico](./versioning.md): explica por que uma major desses pacotes força uma major da plataforma e por que `engines.doric` basta.
- [Bundle core e quarentena](./core.md): define a quarentena aplicada à parte client com faixa de `engines.doric` incompatível.
- [Composição e distribuição pelo host](./composition-and-distribution.md): cada janela mantém sua geração client até recarregar, regra que combina com o import map imutável.
- [O bundle chat](./chat.md): o serviço `chat.lexical/v1` aceita classes de node Lexical, que dependem do singleton de `lexical` fornecido pelo import map.
- [Contratos e a família `define*`](./contracts.md): descreve como os bundles definem seus próprios contratos, e quais definições `bundle/contracts`, `core/contracts` e `<bundle>/contracts` exportam.
