# Aparência nativa da janela

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

A aparência nativa de uma janela do Doric, como barra de título, tamanho e cor de fundo, é dividida em três partes com donos distintos. A chamada de abertura declara só a intenção, os tokens da plataforma definem medidas e cores, e o Electron main converte intenção e tokens em opções nativas. O main devolve à janela a área segura resolvida, e o shell a expõe como variáveis CSS que o componente `ChromeBar` de `desktop-ui` aplica. Assim o main deixa de conhecer medidas do CSS do renderer, e o renderer deixa de adivinhar onde o main colocou os controles da janela.

## Problema atual

Hoje o main conhece medidas do CSS do renderer. `titleBarOptions` em `app/doric/src/main.ts` calcula `trafficLightPosition: { x: 14, y: 12 }` a partir da altura de `.chrome-bar` (2.25rem, 36px) em `styles.css`. O splash usa `backgroundColor: '#1c1b19'` fixo. O renderer, por sua vez, precisa reservar espaço para os controles da janela sem saber onde o main os colocou. Se um layout alternativo mudar a altura da barra, os controles ficam desalinhados.

## Divisão de responsabilidade

A proposta divide a responsabilidade em três partes:

| Parte           | Dono                 | Responsabilidade                                                                   |
| --------------- | -------------------- | ---------------------------------------------------------------------------------- |
| Intenção        | Chamada de abertura  | Declara o tipo de barra de título, tamanhos e o token de fundo                     |
| Medidas e cores | Tokens da plataforma | `--doric-titlebar-height` e `--doric-window-background`, exportados também em JSON |
| Aplicação       | Electron main        | Converte intenção e tokens em opções nativas e informa a área segura à janela      |

### Intenção na chamada de abertura

A chamada de abertura, por `windows/v1` ou `doric.windows/v1`, declara a intenção, nunca opções nativas. Um bundle comum abre janelas pelo serviço `windows/v1`, que o core expõe com suas políticas. `windows/v1` é um contrato básico: `bundle/contracts` exporta a referência `WindowsV1` e o seu tipo, como `DesktopContext`, e o core fornece a definição com `execute` (`coreWindows`, escrita com `defineService(WindowsV1, { open: defineMethod({ input, output, execute }) })`):

```ts
import { type DesktopContext, WindowsV1 } from 'bundle/contracts';

export const activate = async ({ services }: DesktopContext) => {
  await services.use(WindowsV1).open({
    key: 'graph',
    path: '/graph',
    appearance: {
      size: { width: 960, height: 640, minWidth: 600, minHeight: 400 },
    },
  });
};
```

A janela carrega o path `/graph`, que o bundle `graph` registra como rota na sua parte `client` ([navegação e rotas](./navigation.md)). O manifesto do bundle `graph` declara em `requires` tudo o que o código usa com `use`, embora o core forneça esses contratos por padrão: `windows/v1`, que o exemplo acima usa, e `ui/v1` e `navigation/v1`, porque a parte `client` define o elemento e registra a rota `/graph`:

```json
{
  "manifestVersion": 1,
  "id": "graph",
  "version": "1.0.0",
  "engines": { "doric": "^1.0.0" },
  "requires": ["windows/v1@^1.0.0", "ui/v1@^1.0.0", "navigation/v1@^1.0.0"]
}
```

`windows/v1` é fornecido no `desktopMain`, por isso uma parte `client` que o declara em `requires` também pode chamar `services.use(WindowsV1).open(...)` com a mesma `appearance`: a chamada atravessa a ponte até o core no main, e o dispatcher preenche `call.scope.windowKey` com a janela de origem.

O core abre a janela principal em `/`, a rota do [layout](./layout.md), pelo contrato nativo `doric.windows/v1` no `onAppReadyHook` com a mesma forma de aparência. O hook é definido pela plataforma em `AppHooksV1`; depois que o provedor de `hooks/v1` do `desktopMain` ativa (o core, por padrão, ou o escolhido em `providers`), a plataforma chama `define(AppHooksV1)` e dispara `execute` quando todos os bundles do desktop ativaram:

```ts
import {
  AppHooksV1,
  type DesktopContext,
  DoricWindowsV1,
  HooksV1,
} from 'bundle/contracts';

export const activate = ({ services }: DesktopContext) => {
  const nativeWindows = services.use(DoricWindowsV1);
  services
    .use(HooksV1)
    .use(AppHooksV1)
    .onAppReadyHook(async (_input, call) => {
      await nativeWindows.open(
        {
          key: 'workspace',
          path: '/',
          appearance: {
            size: { width: 1280, height: 800, minWidth: 900, minHeight: 600 },
          },
        },
        call,
      );
    });
};
```

Os dois serviços aceitam a mesma `appearance`; `windows/v1` só aplica as políticas do core antes de repassar a chamada para `doric.windows/v1`.

`doric.windows/v1` é contrato da plataforma: sempre existe, o core o usa com `use` sem declará-lo em `requires`, e nenhum bundle o fornece.

O core repassa ao stub de `doric.windows/v1`, como último argumento, o `call` recebido pelo handler do hook ou pela operação de `windows/v1`. O dispatcher herda desse pai `scope`, `signal` e `trace`, mas não o `caller`: o `call.caller` do salto novo é sempre `{ bundleId, version, generation }` do core, preenchido pelo dispatcher. Assim, quando `graph` chama `windows/v1`, o `caller` que o core recebe é `graph`, e o `caller` do salto seguinte, para `doric.windows/v1`, é o core. Sem um `call` pai, o stub aceita `{ signal, deadline }`.

`titleBar` aceita:

- `native`: barra do sistema.
- `integrated`: controles nativos sobre o conteúdo, como hoje no macOS. É o padrão.
- `none`: sem moldura, reservado às janelas técnicas do app, como o splash.

`background` nomeia um token, não uma cor literal, e o padrão é `window`.

Os serviços `windows/v1` e `doric.windows/v1`, as chaves de janela e `describeWindow` são descritos em [janelas abertas pelo core](./windows.md).

### Tokens da plataforma

As medidas e cores vêm dos tokens do tema: `--doric-titlebar-height` e `--doric-window-background`. Eles são publicados pelo contrato `doric.tokens/v1` e exportados também em JSON, para que o main e o splash os leiam sem depender do CSS do renderer. A origem e a distribuição dos tokens estão em [pacotes compartilhados e tokens do tema](./platform-packages.md).

### Aplicação pelo main

O main lê os tokens em JSON e resolve as opções:

```ts
const nativeOptions = (
  appearance: WindowAppearance,
  tokens: ThemeTokens,
): Electron.BrowserWindowConstructorOptions => {
  const size = clampToWorkArea(appearance.size);
  const backgroundColor = tokens.color(
    appearance.background,
    nativeTheme.shouldUseDarkColors,
  );
  if (appearance.titleBar !== 'integrated' || process.platform !== 'darwin') {
    return { ...size, backgroundColor };
  }

  const height = tokens.titlebarHeight; // 36
  return {
    ...size,
    backgroundColor,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: (height - trafficLightSize) / 2 },
  };
};
```

Fora do macOS, a primeira entrega mantém a moldura nativa, como hoje; `titleBarOverlay` fica como evolução para Windows e Linux.

## Área segura

O main devolve à janela a área segura resolvida em `describeWindow().chrome`:

```json
{
  "titleBar": "integrated",
  "height": 36,
  "safeArea": { "top": 0, "left": 78, "right": 0 }
}
```

O shell grava esses valores como `--doric-safe-top`, `--doric-safe-left` e `--doric-titlebar-height` em `:root`. Em tela cheia o macOS esconde os controles; o main envia a nova área segura, e o shell atualiza as variáveis.

## `ChromeBar`

`desktop-ui` fornece um componente `ChromeBar` que aplica a altura, o recuo da área segura e as regiões de arraste. Na janela principal, quem o usa é o header do `<layout-workspace>`, do [bundle layout](./layout.md):

```tsx
import { ChromeBar } from 'desktop-ui/chrome-bar';

<ChromeBar>
  <WorkspaceTitle />
</ChromeBar>;
```

```css
.chrome-bar {
  height: var(--doric-titlebar-height);
  padding-inline-start: var(--doric-safe-left);
  -webkit-app-region: drag;
}
```

## Limites

- O main limita os tamanhos à área de trabalho do monitor e a um mínimo fixo.
- O splash continua técnico e usa os mesmos tokens em JSON para a cor de fundo.

## Relações

- [Janelas abertas pelo core](./windows.md): define `windows/v1` sobre `doric.windows/v1`, as chaves e `describeWindow`, que carregam a intenção de aparência e devolvem a área segura; partes `client` chamam `windows/v1` pela ponte.
- [Pacotes compartilhados e tokens do tema](./platform-packages.md): fornece `desktop-ui`, onde vive `ChromeBar`, e os tokens do tema exportados em CSS e JSON.
- [Splash e recuperação](./splash-and-recovery.md): o splash é a janela técnica com `titleBar: 'none'` que lê a cor de fundo dos mesmos tokens em JSON.
- [Protocolo doric://](./doric-protocol.md): o shell que grava as variáveis da área segura é servido pela origem `doric://app` sob a CSP da plataforma.
- [Bundle core e quarentena](./core.md): o core é quem abre as janelas pelo `doric.windows/v1`, expõe `windows/v1` aos outros bundles e abre a janela principal em `/`.
- [O bundle layout](./layout.md): desenha o workspace da rota `/`, cujo header usa `ChromeBar` para alinhar a barra com a área segura.
- [Hooks e ciclo de vida](./hooks.md): define `AppHooksV1`, registrado pela plataforma no provedor de `hooks/v1`, e o `onAppReadyHook` em que o core abre a janela principal.
- [Contratos](./contracts.md): descreve `bundle/contracts`, de onde vêm as referências `WindowsV1`, `HooksV1` e `DoricWindowsV1`, a definição `AppHooksV1` e `DesktopContext`, e a propagação de `call` entre saltos.
- [Arquitetura de bundles](../bundles.md): documento principal que mostra como a aparência da janela se encaixa no restante da proposta.
