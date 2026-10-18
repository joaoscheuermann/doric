# UI composta por bundles

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

A UI do Doric passa a ser inteiramente composta por bundles: as fronteiras públicas da UI são Web Components definidos por eles, e o renderer só tem um bootstrap técnico que põe um `<core-outlet>` no `body`; o path da URL escolhe a rota que aparece. No client, o core fornece por padrão `ui/v1` (definição e criação de elementos por tag), `navigation/v1` (rotas por path) e `regions/v1` (lugares com nome nos templates), descritos em [UI no client](./core.md#ui-no-client); outro bundle pode substituir qualquer um deles quando a composição o escolhe em `providers`. O bootstrap fica em `packages/desktop`, o runtime client do loader usado por `app/doric-renderer`, que nenhum bundle importa. Componentes se comunicam por propriedades JavaScript tipadas, atributos simples e eventos DOM de intenção visual; operações de domínio passam por stubs de serviço tipados. O catálogo client reúne as contribuições de UI dos bundles (rotas, views, comandos, componentes, menus, atalhos, temas). Tags de custom elements começam com o ID do bundle dono. Shadow DOM é escolha de cada componente, não exigência da plataforma.

## Web Components como fronteira pública

As **fronteiras públicas da UI são Web Components** definidos pelos bundles. O bootstrap do renderer, implementado em `packages/desktop` (o runtime client do loader que `app/doric-renderer` carrega; bundles não o importam), ativa as partes client, com o core primeiro, e põe um `<core-outlet>` no `body`. O outlet mostra a rota que casa com `location.pathname` chamando o `create` dela, que normalmente usa `ui.create` para entregar ao elemento os serviços do bundle dono por propriedade JavaScript. O bootstrap não contém `App`, `Settings`, sidebar, conversa, janelas nem lista fixa de nodes; carrega apenas o import map e o CSS base dos [pacotes compartilhados](./platform-packages.md).

O core client não desenha telas de produto: define só `<core-outlet>`, `<core-region>`, `<core-not-found>` e `<core-unavailable>`. O workspace é o `<layout-workspace>` do bundle [layout](./layout.md), na rota `/`; o template dele tem as regiões `layout.sidebar`, `layout.header`, `layout.panel` e `layout.footer` e um `<core-outlet>` na área principal, onde `<chat-view>`, do bundle `chat`, aparece pela rota filha `/projects/:projectId/threads/:threadId`. A página de settings é o `<settings-page>` do bundle `settings`, na rota `/settings`, com a região `settings.sections` e um `<core-outlet>` para as seções. Outra composição pode registrar outras rotas ou dispensar a conversa.

Itens de região têm IDs sem versão, como `providers` na região `settings.sections`; são distintos das rotas, que são paths como `/settings/providers` ou `/projects/:projectId/threads/:threadId`.

Cada bundle controla internamente o comportamento, estado local e renderização de seus elementos: pode usar Web Components puros, React montado dentro de um elemento ([React dentro de Web Components](./react-web-components.md)) ou outra tecnologia. Isso não obriga cada botão ou primitive vendorizada a virar um custom element.

## Propriedades, atributos e eventos DOM

- As propriedades tipadas carregam objetos e handles de serviço; atributos HTML servem apenas para valores simples e refletíveis.
- Eventos DOM com `bubbles: true` e `composed: true` comunicam intenções visuais que precisam atravessar um ShadowRoot. O elemento que contém o emissor decide como agir e usa o stub do serviço correspondente para operações de domínio ([serviços e canais](./services-and-channels.md)).
- Toda tag começa com o ID do bundle dono seguido de hífen (`core-outlet`, `layout-workspace`, `chat-view`, `git-branch-event`, `settings-providers`). O `ui/v1` recusa em `define` uma tag que não comece com `<id do bundle chamador>-`, o que evita conflitos sem registro extra. IDs de contribuição continuam únicos no catálogo.
- Como `customElements.define` não substitui uma definição na janela existente, troca de implementação ou versão de componente exige recarga da janela.
- Fechar definitivamente uma view chama seu descarte (`dispose` de `ui/v1`); um mero movimento no DOM não deve destruir o estado de editor, terminal ou Monaco.

## Catálogo client de contribuições

O catálogo client admite, conforme as funcionalidades reais forem extraídas:

| Contribuição             | Uso                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `route`                  | Padrão de path (como `/projects/:projectId/threads/:threadId`), `create(params)` do elemento e `parent` opcional.                             |
| `view` e `tab`           | Tags de conteúdo navegável, com identidade e estado próprios; abas são abertas por `layout.tabs/v1`, não por rotas.                           |
| `command` e `menuAction` | Ação visível e comando com `execute`, registrados no client ou no `desktopMain`.                                                              |
| `settingsSection`        | Link na região `settings.sections` de `<settings-page>` (`{ id, tag: 'settings-link', props: { label, path } }`) e rota filha de `/settings`. |
| `component`              | Tag reutilizável, ou montada numa região de `regions/v1`, com propriedades e eventos documentados pelo bundle dono.                           |
| `menu`                   | Item do menu da aplicação ou do dock, pedido a `menus/v1` e ligado a um comando.                                                              |
| `keybinding`             | Atalho de teclado pedido a `menus/v1`, ligado a um comando, com escopo e condição.                                                            |
| `theme`                  | Variante dos valores dos tokens da plataforma (`doric.tokens/v1`); não redefine a estrutura do tema.                                          |

Comandos são definidos com `defineCommand({ id, input, execute })`, cujo `execute(input, call, services)` recebe os serviços do bundle que registrou o comando, e registrados com `services.use(CommandsV1).register` na parte `client` (ou `desktopMain`), como descrito em [contratos](./contracts.md); `commands/v1` existe só no `desktopMain` e no `client`, nunca no `host`, então uma parte host não registra comandos; menus e atalhos ligados a eles estão em [menus nativos e atalhos](./menus-and-keybindings.md). As rotas usam o serviço de [navegação e rotas](./navigation.md), e os tokens do tema estão em [pacotes compartilhados e tokens do tema](./platform-packages.md).

## Janelas, regiões e dependências visuais

O core padrão abre a janela `workspace` em `/` e a janela `settings` em `/settings`; o que aparece nelas vem das rotas registradas, e os bundles preenchem as regiões dos templates por `regions/v1`. Uma janela é uma chave mais um path: um bundle que precisa de uma janela própria, como um diff ou um dashboard, a pede por `windows.open({ key, path })` de `windows/v1`, que o core expõe com suas políticas sobre o nativo `doric.windows/v1`, sem alterar `app/doric` (ver [janelas abertas pelo core](./windows.md)). O core fornece `windows/v1` e `menus/v1` no `desktopMain`; uma parte `client` que os declara em `requires` os alcança pela ponte para abrir e focar janelas ou pedir itens, atalhos e `setContext`. O dispatcher preenche `call.scope.windowKey` em toda chamada que sai de uma janela client, e é por ele que o core sabe de qual janela veio o pedido.

Monaco, xterm e a geometria atual continuam dependências dos respectivos bundles padrão. React, Lexical, shadcn, Tailwind e o tema principal passam a ser [pacotes compartilhados da plataforma](./platform-packages.md).

## Shadow DOM

Shadow DOM é escolha do componente, não exigência da plataforma. Ele isola árvore e CSS.

Para a conversa atual, a primeira extração deve usar Light DOM: Tailwind e fontes globais, portais Radix, seleção/caret e estilos Lexical já dependem do documento compartilhado.

Um componente que adotar Shadow DOM precisa:

- distribuir suas folhas de estilo;
- expor custom properties/parts para tema;
- direcionar portais ao próprio root;
- verificar foco, seleção e acessibilidade.

## Exemplos de consumo da UI

Os trechos seguintes são **pseudocódigo da API proposta**, não código que o renderer atual já exporta. Cada parte client recebe um `ClientContext`, que só tem `services`, e obtém o serviço de UI na ativação com `const ui = services.use(UiV1)`; por isso declara `ui/v1` em `requires`. As referências `UiV1` e `CommandsV1` e o tipo `ClientContext` vêm de `bundle/contracts`, as referências e as definições sem lógica (hooks, eventos, settings) de outros bundles vêm de `<bundle>/contracts`, e o próprio bundle importa seus contratos por caminho relativo (`../contracts/index.js`). `ui.create(tag, props?)` cria o elemento de uma tag e lhe entrega, antes de conectá-lo ao DOM, os serviços do bundle dono da tag, com as chamadas atribuídas a ele em `call.caller` ([`ui.create` passo a passo](./core.md#uicreate-passo-a-passo)). Um consumidor não repassa os próprios serviços a outro bundle.

### Bootstrap da janela

O bootstrap técnico de `packages/desktop` não enumera janelas: o path da URL decide o que aparece. Depois de ativar as partes client, ele faz só isto:

```ts
document.body.replaceChildren(document.createElement('core-outlet'));
```

O outlet mostra a rota que casa com o path da janela e, seguindo `parent`, a rota filha dentro do outlet do pai; veja [o outlet](./navigation.md#o-outlet-core-outlet).

### A conversa por rota ou por tag

O `chat` define `<chat-view>` e registra a rota da Thread na própria ativação client:

```ts
import { NavigationV1, UiV1, type ClientContext } from 'bundle/contracts';

export function activate({ services }: ClientContext) {
  const ui = services.use(UiV1);
  ui.define('chat-view', ChatView);

  services.use(NavigationV1).register({
    path: '/projects/:projectId/threads/:threadId',
    parent: '/',
    create: (params) => ui.create('chat-view', params),
  });
}
```

O manifesto client do `chat` declara `requires: ['hooks/v1', 'ui/v1', 'navigation/v1', 'commands/v1', 'runtime.threads/v1']` (`hooks/v1` pela definição de `chat.hooks/v1` na ativação, omitida no recorte acima, `navigation/v1` pelo registro da rota, `commands/v1` pelo despacho de comandos a partir das intenções DOM dos cards, descrito adiante, e `runtime.threads/v1` pelo envio de prompt mostrado adiante) e `provides: ['chat.views/v1', 'chat.lexical/v1', 'chat.hooks/v1']`, como em [o bundle chat](./chat.md).

Quem quer mostrar a conversa navega para o path dela ou cria o elemento pela tag:

```ts
navigation.navigate(`/projects/${projectId}/threads/${threadId}`);

// ou, para pôr a conversa num lugar próprio, como um dashboard:
const chat = ui.create('chat-view', { projectId, threadId });
container.replaceChildren(chat);
```

`projectId` e `threadId` são propriedades tipadas do elemento. Se o `chat` não estiver ativo, `ui.create` devolve um `<core-unavailable>`. Uma conversa alternativa substitui o bundle `chat` na composição: registra o mesmo path `/projects/:projectId/threads/:threadId` com o próprio elemento, cuja tag leva o prefixo do seu ID. Sem o `chat`, `ui.create('chat-view', …)` devolve `<core-unavailable>`. Quem cria o elemento o mantém enquanto ele só muda de posição no DOM e chama `ui.dispose` ao fechar a view definitivamente.

### Renderizador de bloco de outro bundle

Um bundle client de Git registra sua tag e a associa a um tipo de **bloco projetado**, não diretamente ao evento bruto. Seu módulo host registra o evento em outra fase: o evento é definido com `defineEvent` no entrypoint `git/contracts`, que a parte host do próprio Git importa por `../contracts/index.js`, e registrado com `services.use(EventsV1).register(branchSwitchedEvent)` na ativação host, com `events/v1` no `requires` do host ([contratos](./contracts.md), [eventos e nodes](./events-and-nodes.md)). `ChatViewsV1` é a referência (`ref`) ao serviço `chat.views/v1`, cuja definição `chatViews`, com `defineService` e os `execute` dos métodos, fica no código client do `chat`; como `registerProjector` recebe funções e os dois métodos devolvem um `Disposable` (`z.custom`), eles só funcionam no mesmo processo, e o Git usa o serviço na parte client; o Git o importa de `chat/contracts`. Como a conversa é opcional para o Git, ele usa `whenAvailable` e não põe `chat.views/v1` em `requires`; o recorte abaixo usa com `use` apenas `ui/v1` e `commands/v1`. O manifesto client completo do Git, em [o bundle chat](./chat.md), declara no client `requires: ['hooks/v1', 'ui/v1', 'commands/v1', 'navigation/v1', 'regions/v1', 'windows/v1', 'menus/v1', 'git.commands/v1']`: `navigation/v1` porque a parte client registra as rotas `/git/diff/:threadId/:repository` e `/settings/git` com `services.use(NavigationV1)`, `regions/v1` pelo item `<git-changes>` que ela põe na região `layout.panel` do [layout](./layout.md), `windows/v1` porque `openComparisonCommand` abre a comparação com `windows.open({ key, path })` no path `/git/diff/:threadId/:repository`, `menus/v1` pelo item de menu, `hooks/v1` para consumir `chat.hooks/v1` com `whenAvailable`, e `git.commands/v1` porque `switchBranchCommand`, omitido aqui, usa o stub desse contrato.

```ts
import { CommandsV1, UiV1, type ClientContext } from 'bundle/contracts';
import { ChatViewsV1 } from 'chat/contracts';
import { openComparisonCommand } from './commands.js';

class GitBranchEvent extends HTMLElement {
  block!: { threadId: string; repository: string };

  // Chamado pelo botão interno do card.
  openComparison() {
    this.dispatchEvent(
      new CustomEvent('git:open-comparison', {
        detail: {
          threadId: this.block.threadId,
          repository: this.block.repository,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

export function activate({ services }: ClientContext) {
  const ui = services.use(UiV1);

  // A tag começa com o ID do bundle chamador (`git-`); outra seria recusada.
  ui.define('git-branch-event', GitBranchEvent);

  // `git.open-comparison/v1` é um comando definido com `defineCommand`.
  services.use(CommandsV1).register(openComparisonCommand);

  // A conversa é opcional para o Git: o registro só acontece se `chat` existir.
  services.whenAvailable(ChatViewsV1, (views) =>
    views.registerRenderer({
      blockType: 'git.branch-change/v1',
      elementTag: 'git-branch-event',
    }),
  );
}
```

A definição e o registro são rastreados pelo loader e descartados em ordem inversa na desativação. O projetor de Git registra separadamente como `git.branch-switched/v1` produz ou atualiza esse bloco (ver [o bundle chat](./chat.md)). A conversa obtém o renderizador registrado e cria o card pela `elementTag` com `ui.create`, que acha o dono da tag no catálogo da janela e atribui ao elemento os serviços do Git, não os da conversa:

```ts
const renderer = viewRegistry.resolve(block.type);
const card = ui.create(renderer.elementTag, { block });
blockList.replaceChildren(card);
```

### Intenção DOM tratada pela conversa

O card emite uma intenção DOM local. A conversa, ou outro elemento acima dele, a trata e despacha o comando `git.open-comparison/v1`, definido pelo Git com `defineCommand` e registrado em `commands/v1` do client; não é um serviço. O `execute` do comando, na definição do Git, decide onde abrir a comparação, por exemplo numa aba de `layout.tabs/v1` ou numa janela própria pedida a `windows/v1` com os serviços que recebe; nesse último caso, o manifesto client do Git declara também `windows/v1` em `requires`. O despacho é `commands.execute(ref ou id, input)`, como em [contratos](./contracts.md#comandos-definecommand); a conversa usa o ID para não importar `git/contracts`, e um bundle que quisesse a entrada tipada usaria a referência que o Git exportasse em `git/contracts`:

```ts
const commands = services.use(CommandsV1);

blockList.addEventListener('git:open-comparison', (event) => {
  const { threadId, repository } = (
    event as CustomEvent<{ threadId: string; repository: string }>
  ).detail;
  void commands.execute('git.open-comparison/v1', { threadId, repository });
});
```

Quem despacha o comando por `commands/v1` declara esse contrato em `requires`: o `chat` o declara no client, como visto acima, e qualquer outro bundle que despache o comando também o declara.

### Comando de domínio como chamada de serviço

Já uma operação de domínio é uma chamada de serviço. Por exemplo, o próprio `<chat-view>` envia um prompt por `runtime.threads/v1` (`RuntimeThreadsV1`, importado de `runtime/contracts`) sem conhecer HTTP, Socket.IO nem o preload concreto:

```ts
const threads = this.services.use(RuntimeThreadsV1, {
  projectId: this.projectId,
});
await threads.sendPrompt(
  { threadId: this.threadId, text },
  { signal: this.abortController.signal },
);
```

`RuntimeThreadsV1` é a referência (`ref`) ao serviço `runtime.threads/v1`; o bundle `runtime` escreve a definição com `defineService` e `defineMethod`, com o `execute` de cada método, e a fornece com `services.provide(definição)`. O serviço reúne o envio de prompt, a leitura de Threads e os controles de Threads filhas do `Host` atual, enquanto o bundle `threads` fica só com as tools de delegação e os cards. O dispatcher valida entrada e saída com o zod no mesmo processo e com o JSON Schema gerado quando a chamada atravessa processos ([contratos](./contracts.md)).

O último argumento opcional de todo stub é um `call` pai ou `{ signal, deadline }`, como no `{ signal }` acima. No host, o `execute` do método recebe `(input, call, services)`: `call.caller` é o bundle que fez a chamada (aqui, `chat`), preenchido pelo dispatcher e nunca herdado; `call.scope.windowKey` identifica a janela de origem; e `call.signal` está ligado ao cancelamento do client. `services` são os serviços do `runtime`, ligados no `provide`. Se esse `execute` chamar outro serviço repassando o `call` recebido, o novo salto herda `scope`, `signal` e `trace`, mas seu `caller` passa a ser o próprio `runtime`.

O stub faz o percurso client → preload → Electron main → serviço host e entrega a resposta ou um erro com `code` e `message`. O componente cancela assinaturas e chamadas ao fechar definitivamente; um simples reordenamento no DOM não deve apagar seu editor. `CustomEvent` é comunicação visual local, enquanto o histórico permanece no stream durável.

### React, bootstrap das janelas e navegação

Um exemplo completo de **React dentro de um Web Component** está em [React dentro de Web Components](./react-web-components.md); o bootstrap das janelas e a abertura de janelas pelo core estão em [janelas abertas pelo core](./windows.md); o registro e consumo de rotas estão em [navegação e rotas](./navigation.md); o workspace, as regiões `layout.*` e as abas estão em [o bundle layout](./layout.md).

O core fornece o roteador `navigation/v1` (`register`, `navigate`, `back`, `current`, `subscribe`), que usa a History API e muda `location.pathname`, então voltar, avançar e recarregar funcionam como num site. As rotas são dos bundles: a rota de Thread, por exemplo, é `/projects/:projectId/threads/:threadId`, registrada pelo `chat` com `parent: '/'`, e aparece no `<core-outlet>` que o layout põe na área principal. Abas não são rotas: o layout cria e guarda os elementos delas. Abrir outra janela é `windows.open({ key, path })`, não navegação dentro da janela.

## O que continua no Electron

O Electron permanece responsável por `BrowserWindow`, splash, protocolo `doric://app` ([protocolo doric://](./doric-protocol.md)), download dos artefatos com verificação de integridade do cache, ciclo das conexões e IPC mínimo, e mantém o que já faz hoje no sandbox e no isolamento de contexto. Adaptadores para HTTP/Socket.IO e operações semânticas podem ser fornecidos por bundles.

Os hooks do ciclo de vida são da plataforma. Depois que o provedor de `hooks/v1` de um ambiente ativa (o core, por padrão, ou o escolhido em `providers`), a plataforma daquele ambiente chama `define(AppHooksV1)` e passa a disparar `execute` nos pontos do ciclo de vida. No `client`, o bootstrap de cada janela define `WindowHooksV1` (`onCloseHook`, `onFlushHook`) no `hooks/v1` do client e o executa quando o main pede o fechamento da janela ([hooks e ciclo de vida](./hooks.md)). Qualquer bundle, não só o core, registra handlers desses hooks, como `hooks.use(AppHooksV1).onAppReadyHook(handler)` no desktop ou `hooks.use(WindowHooksV1).onCloseHook(handler)` no client, com `hooks/v1` em `requires`. O core abre a janela `{ key: 'workspace', path: '/' }` e monta o esqueleto do menu no seu handler de `onAppReadyHook`, não direto no `activate`. Uma falha do `activate` de um bundle leva à quarentena; uma falha de um handler de `onActivateHook` só vai ao diagnóstico; o Electron encerra janelas mesmo se um hook falhar. A tela de settings atual torna-se o `<settings-page>` do bundle `settings`, na rota `/settings`, com os links que os bundles põem em `settings.sections` e as seções como rotas filhas, como `/settings/providers`. Splash e recuperação continuam técnicos e na plataforma, como descrito em [splash e recuperação](./splash-and-recovery.md).

## Distribuição padrão e composições alternativas

Na distribuição padrão, o core abre a janela `workspace` em `/` e a janela `settings` em `/settings`. A sequência na janela principal é: janela em `/` → `<core-outlet>` → `<layout-workspace>`, do [layout](./layout.md), com sidebar, header, painel, abas e rodapé → `<chat-view>` no outlet do layout, quando o path é o de uma Thread. A página e as seções de settings vêm de `settings` e dos bundles de domínio.

Uma composição alternativa troca o `layout` por outro bundle que registre `/`, troca o `chat` por outra conversa, ou troca o core (`"core"` na composição), usando os mesmos serviços e eventos; ela também pode substituir só `ui/v1`, `navigation/v1` ou `regions/v1`, escolhendo o provedor em `providers`. A escolha vale em cada ambiente em que o bundle escolhido fornece o contrato (aqui, o `client`); nos outros ambientes o provedor padrão continua. Os três são contratos de cardinalidade `one`: quando a composição escolhe outro provedor, o loader não registra a implementação do core para esse contrato naquele ambiente, e o `services.use` do próprio core devolve o provedor escolhido. Sem escolha em `providers`, o bundle substituto, que ativa depois do core, vai para quarentena com motivo. Ela pode usar os pacotes compartilhados ou ignorá-los; só o CSS base da plataforma é carregado sempre. Fontes de produto vêm dos tokens da plataforma; imagens e CSS específicos seguem junto do bundle client que os usa.

A escolha visual pertence à composição do host; quando o host está indisponível, o splash mostra o estado da conexão e pode abrir a última composição conhecida em modo desconectado ([composição e distribuição pelo host](./composition-and-distribution.md)).

## Relações

- [Bundle core e quarentena](./core.md): abre as janelas em seus paths, fornece `ui/v1`, `navigation/v1`, `regions/v1`, `<core-outlet>` e `<core-region>` no client ([UI no client](./core.md#ui-no-client)) e `windows/v1` e `menus/v1` alcançáveis pelo client.
- [O bundle layout](./layout.md): o workspace na rota `/`, as regiões `layout.*`, o outlet da área principal e `layout.tabs/v1`.
- [Contratos e a família define\*](./contracts.md): comandos, serviços e eventos usados pela UI são definidos com `defineCommand`, `defineService` e `defineEvent`.
- [Serviços entre bundles e canais de mensagens](./services-and-channels.md): define os stubs tipados, a ponte client→host e o papel do `CustomEvent` entre os canais.
- [Contextos e capacidades](./contexts.md): descreve o `ClientContext`, só com `services`, que `ui.create` atribui a cada elemento, e a propagação de `call`.
- [React dentro de Web Components](./react-web-components.md): mostra como publicar uma UI React atrás da fronteira de Web Component.
- [Navegação e rotas](./navigation.md): rotas como paths, `parent` e o funcionamento de `<core-outlet>`.
- [Janelas abertas pelo core](./windows.md): cobre `windows.open({ key, path })` e o bootstrap de cada janela no renderer.
- [Pacotes compartilhados e tokens do tema](./platform-packages.md): define o import map, o CSS base e os tokens que a contribuição `theme` varia.
- [Menus nativos e atalhos](./menus-and-keybindings.md): explica as contribuições `menu` e `keybinding` ligadas a comandos.
- [O bundle chat](./chat.md): é dono de `<chat-view>`, da rota `/projects/:projectId/threads/:threadId` e do serviço de projetores e renderizadores usado no exemplo do Git.
- [Eventos e nodes](./events-and-nodes.md): explica os eventos duráveis de onde vêm os blocos que os cards recebem.
- [Protocolo doric://](./doric-protocol.md): cobre a origem `doric://app` de onde os bundles client são carregados e a shell servida para qualquer path de rota.
- [Hooks e ciclo de vida](./hooks.md): a plataforma define `AppHooksV1` e `WindowHooksV1` e os dispara; qualquer bundle registra handlers.
- [Splash e recuperação](./splash-and-recovery.md): a superfície técnica que permanece fora da UI composta.
- [Composição e distribuição pelo host](./composition-and-distribution.md): a composição do host decide a escolha visual e o modo desconectado.
