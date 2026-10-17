# Referências e decisões aproveitadas

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

A arquitetura de bundles do Doric reaproveita decisões de sistemas existentes, mas não copia nenhum deles inteiro. Do DeepSeek Harness vêm o modelo de composição, os serviços por contexto e a separação entre KV genérico e log de sessão; o armazenamento do Doric, porém, precisa de um contrato mais forte que o KV do Harness. VS Code, Discord, gRPC, Web Components e Lexical inspiram manifesto, ativação, IDs estáveis, stubs, fronteiras client e nodes. Dentro do repositório, o `defineTool` atual de `packages/tool` é o molde da família `define*` dos contratos, exportada por `bundle/contracts`.

## O que aproveitar do DeepSeek Harness

### Como o Harness organiza o armazenamento

O Harness já separa o KV genérico `ctx.storageDomain`, usado por domínios de plugins, do log de Session e de `ctx.sessionPersistence`. Seu KV valida schemas e grava cada operação antes de notificar, mas hoje não oferece transações entre tabelas, índices secundários nem migração automática. O log da Session é append-only em memória; `deriveMessages()` reconstrói o contexto do modelo a partir dele, e um backend pode gravar em lote até uma política exigir `flush`. [Storage](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/storage.md), [limitações do KV](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/storage/storage-domain/README.md#known-limitations-and-deferred-work), [Sessions](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md), [persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md).

### Por que o Doric precisa de mais

O Doric atual usa PostgreSQL como fonte do log publicado, grava mensagens preparadas separadamente, só emite um evento após seu commit e faz rewind removendo eventos, mantendo lacunas de sequência e cobranças anteriores. Além disso, um Project possui um sandbox compartilhado por Threads independentes; persistir o ID do Project não persiste automaticamente o processo nem seus arquivos. Um bundle pode implementar pool, provider e política de lease, mas o runtime de domínio precisa coordenar aquisição, cancelamento, liberação única e recuperação conforme a capacidade real de persistir workspace.

### Decisão

Podemos seguir o modelo de composição do Harness sem reduzir o armazenamento do Doric ao KV que ele fornece hoje. O contrato de storage do Doric está em [armazenamento genérico e histórico](./storage.md).

## Referência interna: `defineTool`

O `defineTool` atual de `packages/tool/src/lib/tools.ts` é o molde da família `define*` descrita em [contratos](./contracts.md):

- Recebe `name`, `description`, `input` (um `z.object`), `output` (um schema zod) e `execute`.
- Recusa uma entrada que não seja `z.ZodObject`, com o erro `invalid_schema`.
- Converte os schemas de entrada e saída para JSON Schema com `z.toJSONSchema` e guarda o resultado na `definition` inspecionável da tool.
- Valida a saída de `execute` com `safeParse` e, se ela não bater com o schema, lança `invalid_output` com as issues do zod.
- Hoje chama `execute(sandbox, host, payload, config)`: o sandbox, o objeto `Host` por prompt de `packages/host/src/lib/host.ts` (com `threads`, `workspace` e `terminals`) e a configuração chegam como argumentos posicionais.

Os contratos de bundle seguem o mesmo padrão: `defineHook`/`defineHooks`, `defineService`/`defineMethod`, `defineEvent`, `defineCommand`, `defineSettings` e `defineStorageType`, exportados pelo subpath browser-safe `bundle/contracts` de `packages/bundle`, recebem schemas zod, geram o JSON Schema canônico no build e, onde há execução (`execute` de hooks e comandos, métodos de serviço), validam entrada e saída. Como numa tool, a lógica de serviços e comandos fica na própria definição, num `execute(input, call, services)` de cada `defineMethod` e de cada `defineCommand`; o entrypoint `contracts/` do bundle exporta deles só uma referência tipada criada com `ref`, com o ID. Nenhum bundle escreve JSON Schema à mão. `defineService` vai além do molde só em um ponto: suas opções podem declarar `cardinality: 'many'`; sem a opção, o contrato tem um único provedor.

Na proposta, o `execute` de `defineTool` passa a `execute(payload, call, services)`, como `defineMethod` e `defineCommand`, uma mudança proposta do pacote `tool`. `services` são os serviços do bundle que registrou a tool, ligados no `register` de `tools/v1`. O que hoje chega como `sandbox` e `host` passa a ser obtido como serviço no escopo da chamada, dentro do `execute`: os controles do `Host` passam a `runtime.threads/v1`, `runtime.workspace/v1` e `terminal/v1`, alcançados com `services.use(RuntimeThreadsV1, call.scope)` e equivalentes. O `call` carrega `caller`, `scope`, `signal` e `trace`, e a tool o repassa como último argumento dos stubs que chama, conforme [serviços entre bundles e canais de mensagens](./services-and-channels.md).

## Referências externas

- [DeepSeek Harness: arquitetura](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) e [Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md): serviços por contexto, eventos com semântica explícita e registros que se desfazem. O [subsistema de conversa](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/conversation.md) separa interpretação de eventos e visualização.
- [DeepSeek Harness: storage](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/storage.md), [sessions](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md) e [persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md): o KV versionado dos plugins e o log durável da sessão são contratos diferentes. Seu KV não oferece transações entre domínios, enquanto o Doric precisa de transações que atravessem estado da Thread, evento e contabilidade; a separação conceitual continua útil, mas o contrato de storage do Doric precisa ser mais forte.
- [VS Code: anatomia de extensões](https://code.visualstudio.com/api/get-started/extension-anatomy), [pontos de contribuição](https://code.visualstudio.com/api/references/contribution-points), [ativação](https://code.visualstudio.com/api/references/activation-events) e [comandos](https://code.visualstudio.com/api/extension-guides/command): manifesto indexável, ativação ligada ao uso e descarte de registros. Doric precisa ir além dos pontos de contribuição do VS Code porque o workspace inteiro deve ser substituível: ele é o elemento da rota `/`, e trocar o bundle `layout` troca a moldura toda.
- [VS Code: extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host) e [webviews](https://code.visualstudio.com/api/extension-guides/webview): entrypoints por ambiente e isolamento visual quando necessário.
- [Discord: Gateway](https://docs.discord.com/developers/events/gateway), [interactions](https://docs.discord.com/developers/interactions/receiving-and-responding) e [componentes](https://docs.discord.com/developers/components/reference): IDs estáveis para eventos e comandos, interesses declarados e respostas assíncronas. Doric usa suas próprias sequências duráveis e seu próprio ciclo de execução.
- [gRPC: core concepts](https://grpc.io/docs/what-is-grpc/core-concepts/): contratos de serviço, métodos, stubs, prazos e cancelamento inspiram o stub entre bundles. Como a propagação de deadline e cancelamento do gRPC, todo stub aceita como último argumento opcional o `call` pai ou `{ signal, deadline }`, e o dispatcher herda do pai `scope`, `signal` e `trace`; diferente de um metadado repassado, `call.caller` de cada salto é sempre o bundle que faz a chamada, preenchido pelo dispatcher e nunca herdado. O dispatcher local e a ponte Electron não precisam usar o protocolo gRPC.
- [MDN: Web Components](https://developer.mozilla.org/en-US/docs/Web/API/Web_components), [eventos compostos](https://developer.mozilla.org/en-US/docs/Web/API/Event/composed) e [registro de custom elements](https://developer.mozilla.org/en-US/docs/Web/API/CustomElementRegistry/define): componentes e eventos DOM são fronteiras client; Shadow DOM encapsula DOM/CSS, e uma tag já definida não pode ser substituída no mesmo registro.
- [Lexical: extensões](https://lexical.dev/docs/extensions/intro) e [nodes](https://lexical.dev/docs/concepts/nodes): nodes entram na configuração antes da criação do editor; `DecoratorNode` hospeda views arbitrárias. O serviço visual genérico do Doric permanece independente de Lexical.

## Relações

- [Contratos e a família define\*](./contracts.md): especifica a API que generaliza o molde do `defineTool`, incluindo a cardinalidade nas opções de `defineService`.
- [Armazenamento genérico e histórico](./storage.md): define o contrato de storage mais forte que o KV do Harness.
- [Eventos e nodes](./events-and-nodes.md): aplica a separação entre log durável e estado e os nodes inspirados no Lexical.
- [Serviços entre bundles e canais de mensagens](./services-and-channels.md): usa os serviços por contexto do Harness e os stubs inspirados no gRPC, com a propagação de `call` entre saltos e a mudança do `execute` de `defineTool` para `execute(payload, call, services)`.
- [Pacotes da plataforma](./platform-packages.md): descreve `bundle/contracts`, o subpath que exporta a família `define*`.
- [Manifesto v1](./manifest.md): adota o manifesto indexável e a ativação ligada ao uso do VS Code.
- [Isolamento por processo](./process-isolation.md): trata entrypoints por ambiente e isolamento, como os extension hosts do VS Code.
- [UI composta por bundles](./ui-composition.md): usa Web Components, eventos compostos e Shadow DOM como fronteira client.
- [O bundle chat](./chat.md): separa interpretação de eventos e visualização, como o subsistema de conversa do Harness, e mantém o serviço visual independente de Lexical.
- [Bundle core e quarentena](./core.md): fornece o [`ui/v1`, o roteador e o `<core-outlet>`](./core.md#ui-no-client) sem desenhar nenhuma tela própria.
- [O bundle layout](./layout.md): concretiza o workspace substituível que vai além do VS Code, como o elemento da rota `/`.
