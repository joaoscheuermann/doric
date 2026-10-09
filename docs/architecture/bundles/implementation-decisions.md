# Decisões de implementação da migração para bundles

**Estado:** registro das decisões tomadas durante a implementação da [arquitetura de bundles](../bundles.md). Resolve os pontos que os documentos de conceito deixam em aberto ou contraditórios. Quando um documento de conceito e este registro divergirem, este registro vale para o código; `GROUNDING.md` continua sendo o contrato do comportamento implementado e é atualizado à medida que cada fase entra.

## Princípios

- **Paridade 1:1.** A migração preserva o comportamento atual observável, inclusive peculiaridades documentadas no inventário (por exemplo `POST /threads/:id/interrupt` ignora `promptId`, a seção Tools das settings não chega ao host, só a seleção de Thread persiste no renderer, o app só tem tema escuro, `alwaysAvailable` não filtra tools nem skills, a mensagem `resume_exhausted` em português). Nenhuma funcionalidade nova de produto entra; correções de bugs ficam fora desta migração.
- **API mínima.** Quando os documentos não nomeiam um método necessário para preservar uma funcionalidade atual, o método entra com o menor formato que cobre essa funcionalidade e é marcado aqui.
- **Etapas combinadas.** As etapas da [migração](./migration.md) são cortes de revisão. As etapas 5, 6 e 7 são implementadas juntas: `runtime` e `direct` nascem sobre os tipos e streams genéricos de `storage/v1`, e a migração de dados converte as tabelas atuais. A etapa 2 entrega diretamente as primitivas genéricas da etapa 3 no `postgres`.
- **Etapa 11.** Instalação externa de bundles, assinatura e consentimento continuam adiados. `notifications` e `transport` entram porque correspondem a funcionalidades atuais.

## Estrutura de pastas e pacotes

| Decisão                         | Valor                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pastas das partes               | `host/`, `desktop/` (ambiente `desktopMain`), `client/`, `contracts/`, `skills/` dentro de `bundles/<id>/src` (fonte) e `dist` (artefato), seguindo a convenção do manifesto. Os exemplos com `desktopMain/` são ilustrativos.                         |
| Nome do pacote npm de um bundle | Igual ao ID do bundle (`core`, `files`, `git`, `chat`...). Os pacotes de biblioteca `packages/docker` e `packages/firecracker` passam a se chamar `docker-sandbox` e `firecracker-sandbox` para liberar os nomes dos bundles `docker` e `firecracker`. |
| `<bundle>/contracts`            | Subpath `./contracts` no `exports` do pacote do bundle; no navegador, entrada do import map `"<id>/contracts"` para o artefato da geração.                                                                                                             |
| `bundle/contracts`              | Subpath browser-safe de `packages/bundle`; nenhum import de Node alcançável a partir dele. Contém também os schemas zod dos contratos básicos (janelas, menus, ui, navegação, regiões), para que provedores substitutos validem igual.                 |
| Runtime de serviços             | O diretório de serviços, o dispatcher e a propagação de `call` ficam num subpath browser-safe interno de `packages/bundle` (`bundle/runtime`), usado pelo loader do host, pelo `desktopMain` e por `packages/desktop-client`. Bundles não o importam.  |
| Pacotes novos                   | `packages/storage` (tipos do protocolo e kit de conformidade), `packages/desktop-client` (runtime client do loader) e `packages/desktop-ui` (componentes shadcn, tokens, Tailwind, tema e o helper de elemento React).                                 |
| Build das partes                | `host/` com `tsc` como hoje; `client/` e `desktop/` com esbuild em ESM, deixando externos os pacotes compartilhados e os `<id>/contracts`. CSS de cada bundle client gerado com Tailwind v4 e servido como `client/styles.css`.                        |

## Contratos e serviços

- **Ambiente e cardinalidade antes do código.** O build gera, junto com os JSON Schemas, um descritor por bundle (`dist/contracts.json`) com cada contrato fornecido, seu ambiente, cardinalidade e tipo (serviço, hooks, evento, comando, settings, storage). O loader usa o descritor antes da ativação e confere em `provide`/`register`.
- **`requires` por ambiente.** Uma entrada de `requires` restringe a parte de um ambiente quando algum bundle habilitado fornece o contrato nesse ambiente. Partes `client` também são satisfeitas por provedores do `host` e do `desktopMain` pela ponte. Entradas sem provedor alcançável são dependência ausente.
- **Cardinalidade.** Tabela fixa em `bundle/contracts` para os básicos (`many` só para `models.provider/v1`); para os demais, o descritor do bundle dono. `use` de um contrato `many` lança `ContractError` com código `many_contract_use`.
- **`whenAvailable`.** Callback `(api, provider: { bundleId, version }) => void | Cleanup`. O que o callback registra é descartado quando aquele provedor desativa.
- **`use` fora de `requires`.** Lança `ContractError` `undeclared_requirement`, exceto contratos `doric.*`, contratos que o próprio bundle fornece e o core usando contratos básicos.
- **Escopo.** Escopo efetivo = `call.scope` do pai mesclado com o escopo de `use` (chaves de `use` prevalecem); o dispatcher sobrescreve `windowKey` nas chamadas que saem de uma janela.
- **`deadline` e `trace`.** `deadline` em milissegundos de época, `0` significa sem prazo. `trace` é `{ traceparent: string }` no formato W3C; cada salto cria um span filho com o mesmo trace ID.
- **Erros.** `bundle/contracts` exporta `ContractError` (`code`, `message`, `details?`). Valores lançados sem `code` viram `internal`; falhas de validação viram `invalid_input` e `invalid_output`.
- **Métodos síncronos.** Serviços só locais (com entradas `z.custom` ou funções) devolvem o resultado do `execute` diretamente, síncrono ou não; o dispatcher se recusa a levá-los pela ponte.
- **Hooks.** Tipos `observe`, `transform` e `decide`. `execute` aguarda os handlers `observe` em sequência, cada um com o prazo padrão; falha de `observe` vai ao diagnóstico. Só o bundle que lista o contrato de hooks em `provides` (ou a plataforma, para `doric.*`) pode chamar `define`; `define` é idempotente por dono.
- **Ordem entre bundles não relacionados.** Ordem topológica por dependência com desempate lexical pelo `id`; a mesma ordem vale para handlers de hooks.
- **Entradas dos hooks do app.** `onActivateHook`/`onDeactivateHook`: `{ bundleId, version, generation, environment }`; `onHostReadyHook`, `onAppReadyHook`, `onAppActivateHook`, `onBeforeQuitHook`: `{}`; `onGenerationReadyHook`: `{ generation }`; `onConnectionChangedHook`: `{ connected }`. Todos `.strict()`.
- **`log/v1`.** `debug | info | warn | error(message, fields?)`, sem lançar e sem esperar resposta.
- **`provide` seguido de `use` no mesmo `activate`.** `provide` registra de forma síncrona; a plataforma chama `define(AppHooksV1)` depois que o `activate` do provedor de `hooks/v1` termina.
- **Comandos.** Comandos são contratos versionados e entram em `provides`. Tipos de bloco de projeção não entram.

## Composição e boot

- **Arquivo de composição.** O host lê a composição de `DORIC_COMPOSITION` (caminho de um JSON) e, sem a variável, da composição padrão distribuída com o host (`agents/doric/composition.json`). Formato: `{ "core": "core", "enabled": [...], "providers": { ... } }`, validado por zod em `packages/bundle`. Os bundles instalados são lidos de `DORIC_BUNDLES_PATH` (padrão: o diretório `dist/bundles` do host).
- **Fundação por ambiente.** Um bundle escolhido em `providers` é fundação só nos ambientes em que fornece o contrato escolhido; nos outros, ativa com os demais. Bundles da fundação que substituem uma fachada do core (`events/v1`, `settings/v1`, `models/v1`) podem exigir `storage.backend/v1` e `secrets.backend/v1`, que ativam antes dentro da fundação.
- **Gerações.** Contador monótono por catálogo publicado. Bundles do kernel informam a geração em que o kernel os ativou.
- **`hostId` e `storageGeneration`.** O backend `postgres` guarda um registro de metadados reservado com os dois valores; o catálogo os publica.

## Armazenamento e dados

- **`storage.backend/v1`.** Primitivas genéricas: documentos versionados por tipo e chave com revisão, índices declarados (igualdade, inclusive `null`, e ordenação), streams com sequência e lacunas, `commit` declarativo atômico (puts, deletes, appends, verificação de revisão esperada), feed de commits com cursor, blobs, truncamento de stream e saúde/admissão de escrita. `packages/storage` define os tipos e o kit de conformidade que qualquer backend precisa passar.
- **Dados atuais.** Uma migração offline e idempotente converte Project, Thread, eventos, fila, estado do executor, uso, configuração e providers para tipos e streams dos bundles donos, com leitura de verificação antes da troca. Credenciais continuam no envelope AES-256-GCM sob `DORIC_CREDENTIAL_KEY` e são lidas sem reescrever o segredo.
- **Eventos.** Eventos gravados nunca são reescritos; a etapa 7 copia os eventos para o stream novo com o mesmo tipo e payload. O tipo `prompt.finished` passa a ser lido também como `runtime.prompt-finished/v1`.
- **`settings/v1`.** `register(definição)`, `get(definição)`, `set(definição, valor, { expectedRevision? })` e `subscribe`. Cada definição é um espaço com `{ value, revision, version }`. Um contador global de geração de configuração preserva a proveniência que os Projects guardam hoje.
- **`secrets/v1`.** `resolve(ref)`, `list`, `describe(ref)` (nunca devolve o segredo), `create`, `update` (ausente mantém, `''` limpa, valor define), `delete` (recusado quando referenciado) e `resolveByKind(kind)`. Redação nos logs como hoje.
- **`usage`.** Fica no agregado do `runtime` enquanto não houver participação transacional de outro bundle; o bundle `usage` lê a projeção e fornece a UI.
- **Pressão de disco.** O `postgres` informa medidas e admissão; o `runtime` mantém a política atual (limiar de 10%, verificação a cada 3 s, mapeamento de `53100` e `ENOSPC`).

## Execução e domínio

- **Acesso ao sandbox pelas tools.** `runtime.lease/v1` expõe as operações do sandbox adquirido para `call.scope.projectId` (exec, arquivos, Git, diff, métricas), respondendo os estados atuais do lease sem adquirir. `files/v1`, `git`, `terminal/v1` e `resources` usam esse contrato.
- **Métodos de `runtime.*`, `terminal/v1` e `files/v1`.** Derivados um a um dos controles atuais de `packages/host` e das rotas atuais de Project, Thread e terminal.
- **Configuração de tools.** Vai para o `defineSettings` do bundle dono e é lida com `services.use(SettingsV1).get(...)` dentro do `execute`.
- **Skills.** O loader descobre `skills/*/SKILL.md` e registra pelo `skills/v1` em nome do bundle; `skills/v1.register(skill)` existe para registro por código; `skills/v1.list()` preserva a ordem dos bundles e a resolução de `allowed-tools` por bundle; `direct` lê skills e tools por `skills/v1` e `tools/v1`.
- **`models.provider/v1`.** `{ kind(): KindDescriptor; listModels(config, call); create(config, secrets, call): LlmProvider }`, espelhando `providerKinds` e `createProviderForKind` de `packages/llms`. `models/v1.resolve({ providerId, model, effort }, call)`.
- **Transporte.** O bundle `transport` monta as rotas REST e os namespaces Socket.IO atuais sobre as operações semânticas dos bundles, preservando caminhos, formatos, códigos de erro e cabeçalhos (inclusive o `Cache-Control: no-store` global). Além disso, o host expõe um endpoint técnico de ponte (`/doric/bridge`, Socket.IO) com mensagens `call`, `result`, `cancel`, `subscribe`, `event` e `unsubscribe`, usado pelo desktop para chamadas a serviços do host, catálogo e download de artefatos por hash.
- **Processos.** No host, o kernel (`agents/doric`) roda transporte técnico, catálogo, fundação e core; os demais bundles rodam num processo filho por geração (`child_process.fork`) com o envelope RPC. No desktop, todas as partes `desktopMain` de uma geração (fundação, core e demais) rodam no `utilityProcess` daquela geração.

## Desktop e UI

- **Preload.** Um único namespace `window.doric.desktop`: `describeWindow()`, `ready()`, `reportFailure(info)`, `onCloseRequested(cb)` com canal de resposta, `onChromeChanged(cb)`, `catalog()`, `call(envelope)`, `cancel(id)` e assinatura de streams. Os canais semânticos atuais saem quando a UI em bundles assume.
- **Import map.** React, ReactDOM, Lexical e `@lexical/*`, `desktop-ui`, `zod`, `bundle/contracts` e os `<id>/contracts` da geração. O handler do protocolo renderiza a shell por requisição com o import map da geração e calcula o hash da CSP na mesma resposta.
- **Dev.** Em desenvolvimento as janelas também abrem por `doric://app`; o handler encaminha a shell e os assets ao servidor de desenvolvimento.
- **Privilégios do esquema.** `standard`, `secure`, `supportFetchAPI`, `corsEnabled` e `codeCache`, confirmados no primeiro teste da etapa 8.
- **Janelas.** `open({ key, path })` sempre respeita `path`. O main guarda o último path e os limites de cada chave. No `onAppReadyHook`, o core reabre `workspace` no último path guardado (ou `/`), o que preserva a seleção de Thread entre reinícios; a seleção antiga em `localStorage` (`doric.selection`) é convertida em path uma vez.
- **Gerações no desktop.** Na troca, o novo `utilityProcess` sobe, define `AppHooksV1` e dispara `onGenerationReadyHook` (não `onAppReadyHook`); janelas abertas continuam na geração em que nasceram e recarregam para trocar.
- **Comandos.** O `commands/v1` do client procura primeiro no registro da janela e depois encaminha ao `desktopMain` pela ponte. O main resolve menu e atalho no registro do `desktopMain` e depois na janela em foco. Comandos ligados a menu ou atalho aceitam entrada vazia.
- **Atalhos.** Papéis do menu Editar mantêm aceleradores nativos; os demais atalhos são tratados por um único listener na shell, que recebe do main a tabela efetiva filtrada por `when`. Como hoje o app usa o menu padrão do Electron, o esqueleto do core reproduz esse menu padrão e os atalhos atuais.
- **Lexical.** O `chat` congela o próprio registro de nodes na criação do primeiro editor da janela.
- **Renderizadores.** `registerRenderer({ blockType, elementTag })` estrito; ações de bloco são IDs de comando, despachadas pelo `chat` por um único evento de intenção `{ command, input }`.
- **Notificações.** Capacidade de plataforma `doric.notifications/v1` no `desktopMain` (`show({ title, body })`, com o mesmo relato de recusa do sistema que existe hoje); o bundle `notifications` decide quando avisar a partir de `runtime.prompt-finished/v1`.
- **Histórico local.** O bundle `history` fornece no `desktopMain` `history.snapshots/v1` (`read(threadId)`, `write`), gravando em `<hostId>/<storageGeneration>/<threadId>` dentro do diretório de `doric.cache/v1`; o `chat` o usa por `whenAvailable`.
- **Rotas.** Casamento só por `pathname`; barra final normalizada, exceto em `/`; segmentos estáticos antes de parâmetros; padrões de mesma especificidade que casam os mesmos paths são conflito.
- **Elementos React.** `dispose()` idempotente; o helper `defineReactElement` fica em `desktop-ui`, não em `desktop-client`.
- **Abas do layout.** Estado das abas indexado pelo `threadId` da rota ativa.
- **Seções de settings.** Os contratos de configuração e credenciais são serviços do host (`settings/v1`, `secrets/v1`, `models/v1`) alcançados pela ponte.

## Validação

- Toda fase passa `npx nx run-many -t typecheck test build`, `npm run format:check` e `npm run lint`.
- A paridade é verificada por uma suíte end-to-end que roda os mesmos cenários de API (REST e Socket.IO) e de UI (Electron por CDP) contra o baseline e contra a implementação nova, com um servidor de modelo falso compatível com OpenAI Responses.
- A imagem Docker do host (`agents/doric/.Dockerfile`, alvos `agent-runtime`, `docker-runtime` e `runtime`) compila todos os bundles, inclusive os artefatos `client` e `desktop` que o desktop baixa durante o splash.

## Etapa 1 (Contrato)

Decisões tomadas ao implementar a etapa 1. Os identificadores **D-n** são citados no código e nos testes.

### Contratos e runtime de serviços

- **D-1 Ordem das skills.** O loader descobre `skills/*/SKILL.md` em ordem lexical de pasta. As pastas do `files` levam prefixos de dois dígitos que reproduzem a ordem do antigo manifesto, então o system prompt é idêntico byte a byte.
- **D-2 Marcas e erros entre instâncias.** Definições, `Call` e o protocolo de registro usam `Symbol.for`; erros são reconhecidos por `name`/`code`, nunca por `instanceof`; os mapas do runtime usam o ID do contrato como chave.
- **D-3 Argumento de chamada no fim.** Um `Call` no fim é sempre o argumento de chamada. Opções `{ signal, deadline }` só contam como argumento de chamada além do comprimento da tupla ou quando o item da tupla naquela posição as recusa; assim `log.info('x', { deadline: 5 })` mantém `deadline` como campo.
- **D-4 Registros.** Toda API de registro devolve `Disposable` (`{ dispose() }`), inclusive `navigation.subscribe`.
- **D-7 Saída original.** Dentro do processo a saída é validada e o valor original é devolvido, nunca a cópia do zod; schemas de saída são descritivos.
- **D-8 Erro original.** Dentro do processo o valor lançado por `execute` propaga sem mudança; `toContractError` só onde um código é exigido.
- **D-10 Protocolo de registro.** `bindRegistrant` liga um argumento registrável (tool, comando) aos serviços do bundle que chamou antes da validação.
- **D-11 `invalid_input` síncrono.** A validação dos argumentos lança de forma síncrona no processo; os wrappers das tools são `async`, então quem chama vê uma rejeição.
- **D-12 Provedores de contratos básicos.** `provide` confere nomes de métodos e JSON Schema de cada método contra a especificação da plataforma (`contract_mismatch`).
- **D-13 `whenAvailable`.** Cada callback roda num escopo filho ligado à vida daquele provedor.
- **D-14 Chamador da plataforma.** `{ bundleId: 'doric', version: PLATFORM_VERSION, generation }`.
- **D-16 Fachada de `hooks/v1`.** O provedor implementa métodos planos (`define`, `register`, `whenDefined`, `execute`); o runtime monta a API de consumo.
- **D-17 Entradas de `WindowHooksV1`.** `{}` estrito.
- **D-18 `doric.log/v1`.** Contrato de plataforma novo (API mínima), `write(record)`, por onde um provedor de `log/v1` chega aos arquivos de log do host.
- **D-29 Segurança no navegador.** Além do teste do grafo de imports, `tsconfig.browser.json` (só typecheck, `lib` es2022+dom, `types: []`) compila `bundle/contracts` e `bundle/runtime`.
- **D-30 Partes puras no runtime.** Schemas de manifesto, composição e descritor, o resolvedor por ambiente `resolveEnvironment` e o laço genérico de ativação ficam em `bundle/runtime`; `loader/` guarda só leitura de arquivos, descoberta, skills e o `startHost` de Node.
- **D-31 `skills/v1.list`.** Assíncrono (método não local).
- **D-32 `define` de hooks.** O `define` do provedor devolve um `Disposable` registrado no escopo do dono; ao descartá-lo, os registros feitos dentro de callbacks `whenDefined` caem. A fachada devolve um handle por contrato.
- **D-33 Sem corrida de sinal.** O dispatcher no processo não confere nem corre contra `call.signal`/prazo; o cancelamento chega aos provedores só por `call.signal`.
- **D-34 JSON Schema por direção.** `io: 'input'` para entradas e `io: 'output'` para saídas.
- **Plataforma reservada.** `defineService` recusa IDs `doric.*`, como `defineHooks`; a plataforma usa uma variante interna.
- **Saídas somente leitura.** `defineMethod` aceita formas readonly do tipo de saída.
- **Chamada a método inexistente.** Um método que o provedor não tem responde `unavailable`.
- **Schemas frouxos tipados.** Os schemas de registros de `runtime/contracts` e `terminal/contracts` são `z.looseObject` anotados com a interface correspondente (`z.ZodType<T, T>`), para que o provedor devolva o tipo que já tem.

### Manifesto, composição, catálogo e ativação

- **D-19 Tools v0.** Uma tool de manifesto v0 precisa exportar por padrão uma definição atual de `tool`; uma fábrica antiga coloca o bundle em quarentena (`invalid_part`).
- **D-20 Backends na composição.** A regra de `storage.backend/v1`/`secrets.backend/v1` sempre em `providers` começa na etapa 2.
- **D-21 Fundação em quarentena.** Um provedor de fundação escolhido em quarentena leva o host à recuperação, sem cair para o core. Um provedor escolhido que não é de fundação, em quarentena, deixa o contrato sem provedor ativo, e seus dependentes recebem `dependency_quarantined`.
- **D-22 Ambiente pelo build.** O ambiente e a cardinalidade de cada contrato no descritor vêm de uma ativação a seco no build, não de declaração.
- **D-35 Manifesto.** O `id` não pode ser `doric`; manifestos v0 convertidos recebem um descritor vazio. Um bundle cujo manifesto não pode ser lido não tem ID conhecido e fica sempre em quarentena (`invalid_manifest`).
- **Raiz ausente.** Uma raiz de bundles ilegível vira um problema da composição e recuperação (core ausente), não uma exceção.
- **Contadores.** A geração é um contador por processo; os provedores de contrato no snapshot do catálogo também trazem `bundleVersion`.
- **Isenção do core no build.** O gravador do build não isenta o core de declarar contratos básicos (no build não existe composição); na etapa 1 o core só usa contratos que fornece e `doric.*`.

### Core, bundles e adaptador

- **D-5 `runtime.lease/v1`.** Entra na etapa 1 no adaptador com `describe`, `exec`, `readFile` e `writeFile`; `exec` não repassa sinal de cancelamento ao sandbox e não devolve bytes.
- **D-6 Terminal opcional.** O `files` consome `terminal/v1` por `whenAvailable` (fora de `requires`) e mantém o fallback da tool `terminal` para um comando simples no sandbox, recusando `background` e `pty` com `This host does not support live terminals.`. O adaptador responde `unavailable` para um prompt cujo `Host` não tem terminais, o que leva ao mesmo fallback.
- **D-9 Configuração de tools.** Os valores deixam de chegar ao `execute`; os metadados `settings`, `requireToolConfigs`, `resolveToolConfigs` (ainda chamado em cada prompt, que continua recusando settings não satisfeitas) e `GET /tools` mantêm o comportamento até `settings/v1`.
- **D-15 Recuperação no host.** Na etapa 1 o modo de recuperação termina no caminho fatal de inicialização existente (`Doric failed to start`, estágio `bundle_load`) depois de registrar no log `Bundle recovery mode` com o estado e os motivos de cada bundle.
- **D-23 Contratos do core no desktop.** `core.hooks/v1` e `core.open-settings/v1` entram nos `provides` do core na etapa 8; `core/contracts` já publica as referências.
- **D-24 Prazo dos hooks.** 10 000 ms por handler no core; `doric.window.hooks/v1` segue as regras próprias (`onCloseHook` sem prazo, `onFlushHook` com o prazo da chamada).
- **D-25 Nomes.** Projetos Nx `bundle-<id>`; pacotes npm `<id>`.
- **D-26 Pacotes só de contratos.** `bundles/runtime` e `bundles/terminal` existem desde a etapa 1 apenas como `runtime/contracts` e `terminal/contracts`, sem manifesto e sem staging.
- **D-27 Adaptador embutido.** O bundle embutido `host-adapter` (sempre habilitado pelo host, fora da composição) fornece `runtime.threads/v1`, `runtime.workspace/v1`, `runtime.lease/v1` e `terminal/v1` sobre o `Host` e o sandbox de cada prompt, ligados ao escopo do prompt durante a execução (`attach`/`release`, com a liberação protegida pela identidade da ligação). Sai quando os bundles extraídos assumirem esses contratos.
- **D-28 Diagnóstico sem rota.** Nenhuma rota HTTP de diagnóstico na etapa 1; o diagnóstico fica em `doric.diagnostics/v1`, `HostPlatform.diagnostics()` e nas linhas de log `Bundle quarantined`.
- **Executor obrigatório.** O serviço de workspace recebe o executor do Direct do composition root (`createDirectExecutor({ call, attach })`); não existe mais executor padrão.
- **Caminhos.** `DORIC_BUNDLES_PATH` (padrão: `dist/bundles` ao lado do entrypoint compilado) e `DORIC_COMPOSITION` (padrão: `agents/doric/composition.json`).
- **Mudanças observáveis aceitas.** `Bundles loaded` conta 4 bundles em vez de 3 (o core novo); um bundle não-core que falha fica em quarentena em vez de impedir a inicialização; os quadros de pilha de erros persistidos em `tool.failed`/`agent.failed` mudam de caminho, mantendo `name`, `message` e `cause`.

### Pontos abertos

- Etapa 4: invocação de tools e handlers de hooks entre processos (referências de handler no envelope); o erro do envelope precisa manter `name`, `message` e a cadeia `cause` para a paridade dos eventos `tool.failed`/`agent.failed`; métodos só locais (`tools/v1.register/list`, `hooks/v1.register`) precisam de handles do lado do envelope; limpeza no provedor por `caller.generation` quando uma geração sai.
- Etapa 2: valores das settings de tools por `settings/v1`; saída de `events/v1.append`; a regra dos backends em `providers`; contador de geração persistido e `hostId`.
- Etapas 8/9: gravador de descritor com DOM para partes `client`; registros que devolvem `Promise<void>` pela ponte (`menus/v1`) descartados do lado do provedor no `onDeactivateHook`; promover o core mínimo de teste a `bundle/testing`.
- Rotação de arquivos de log não entra na etapa 1; `doric.log/v1` escreve nos destinos pino existentes.
- Acesso por escopo (HC-007): qualquer bundle que exija `runtime.lease/v1`, `runtime.threads/v1` ou `terminal/v1` e monte um escopo com os IDs de um prompt em execução alcança os controles desse prompt. Todos os bundles da etapa 1 são de primeira parte e bundles externos continuam adiados; a etapa 5 precisa manter esses formatos (extensão minor) ou registrar uma mudança major.
