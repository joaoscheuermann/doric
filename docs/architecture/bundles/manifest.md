# Manifesto v1

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

O manifesto de um bundle traz só o que o loader precisa saber **antes de executar código** do bundle: quem ele é, com qual plataforma é compatível e quais contratos fornece e exige. Todo o resto vem de convenções de diretório ou é registrado pelo próprio código na ativação, com os contratos escritos em zod pela família `define*`. O manifesto v1 é validado por um JSON Schema gerado do schema zod de `packages/bundle`, e o formato atual passa a ser o manifesto v0, convertido em memória até os bundles atuais migrarem. Esses nomes representam um contrato futuro; não são campos aceitos pelo loader atual.

## Formato

```json
{
  "manifestVersion": 1,
  "id": "git",
  "version": "1.4.0",
  "engines": { "doric": "^1.0.0" },
  "provides": [
    "git.commands/v1@1.3.0",
    "git.settings/v1@1.0.0",
    "git.branch-switched/v1@1.0.0"
  ],
  "requires": [
    "tools/v1@^1.0.0",
    "events/v1@^1.0.0",
    "settings/v1@^1.0.0",
    "ui/v1@^1.0.0",
    "runtime.lease/v1@^1.0.0"
  ]
}
```

O exemplo é um recorte: corresponde só ao código de [registro em código](#registro-em-código), e não ao bundle Git completo. Os contratos que o Git fornece entram em `provides`, e todo contrato que o código usa com `use` entra em `requires`: os serviços básicos (`tools/v1`, `events/v1` e `settings/v1` no host, `ui/v1` no client), embora o core os forneça por padrão, e `runtime.lease/v1`, do bundle `runtime`. `chat.views/v1` não aparece porque o Git o consome como dependência opcional, com `whenAvailable`. Nenhum contrato `doric.*` aparece, porque esses são da plataforma e sempre existem. O manifesto completo do `git`, que também define `git.hooks/v1`, registra comandos, rotas, um item de região, janelas e menus no client e consome `runtime.workspace/v1` e `runtime.hooks/v1`, está em [o bundle chat](./chat.md#exemplo-a-troca-de-branch-do-git-na-conversa); ele acrescenta `git.hooks/v1` a `provides` e `hooks/v1`, `commands/v1`, `navigation/v1`, `regions/v1`, `windows/v1`, `menus/v1`, `git.commands/v1`, `runtime.workspace/v1` e `runtime.hooks/v1` a `requires`. `git.commands/v1` entra em `requires` embora o próprio `git` o forneça no host, porque `switchBranchCommand` usa o stub com `use` no client; `runtime.workspace/v1` é usado pela tool do Git em [contextos](./contexts.md). O manifesto do exemplo 3 de [hooks e ciclo de vida](./hooks.md#3-consumir-um-hook-e-definir-outro-no-mesmo-bundle-observe-e-decide-host) explica por que cada um desses contratos entra.

| Campo             | Obrigatório | Para que o loader usa                                                           |
| ----------------- | ----------- | ------------------------------------------------------------------------------- |
| `manifestVersion` | Sim         | Distinguir o formato v1 do formato atual                                        |
| `id`              | Sim         | Identidade curta, em minúsculas, única no catálogo, sem prefixo `doric.`        |
| `version`         | Sim         | Versão semver do bundle                                                         |
| `engines.doric`   | Sim         | Faixa da plataforma compatível, que também cobre os pacotes compartilhados      |
| `provides`        | Não         | Contratos fornecidos, no formato `<id>/v<major>@<versão>`                       |
| `requires`        | Não         | Contratos exigidos, no formato `<id>/v<major>@<faixa>`, para ordenar a ativação |
| `description`     | Não         | Texto curto para o catálogo e o diagnóstico                                     |

### `provides` e `requires`

O loader usa `provides` e `requires` para ordenar a ativação e detectar ausências e versões incompatíveis sem executar nada. A major no sufixo `/vN` e a da versão ou faixa precisam coincidir. O ambiente de cada contrato é o da parte do bundle que o fornece (`host/index.js`, `desktop/index.js` ou `client/index.js`, onde roda o `services.provide` ou o `register`) e é conferido na ativação, assim como a cardinalidade (`one` ou `many`), a única opção de `defineService`, que o manifesto não repete. Os IDs que aparecem aqui são os IDs de contrato versionados das definições `define*`, por exemplo o ID de `defineService('git.commands/v1', ...)` ou de `defineHooks('git.hooks/v1', ...)`; as regras de semver de cada tipo de contrato estão em [versionamento semântico](./versioning.md).

Um bundle pode declarar em `provides` qualquer contrato sem prefixo `doric.`, inclusive os serviços básicos que o core fornece por padrão (`hooks/v1`, `settings/v1`, `storage/v1` e os demais) e os backends que o bundle `postgres` fornece por padrão (`storage.backend/v1` e `secrets.backend/v1`).

A cardinalidade é `one` por padrão; um contrato `many` a declara com `{ cardinality: 'many' }` em `defineService`:

- `one` (padrão): um único provedor ativo por ambiente. Se dois bundles habilitados fornecem o contrato, a composição escolhe o provedor em `providers`, por exemplo `"providers": { "hooks/v1": "myhooks", "storage.backend/v1": "postgres" }`. A escolha vale em cada ambiente em que o bundle escolhido fornece o contrato; nos outros ambientes o provedor padrão continua. Sem escolha, o segundo provedor vai para quarentena com motivo; como a fundação e o core ativam antes, é o bundle substituto que vai para quarentena se a composição não o escolher. `storage.backend/v1`, `secrets.backend/v1`, `runtime/v1`, `executor/v1` e `sandbox/v1` são contratos `one`.
- `many`: vários provedores ativos sem conflito, agregados pelo consumidor. Por exemplo, `openai`, `openrouter` e `codex` fornecem `models.provider/v1`, e o `models/v1` do core agrega os tipos configuráveis, campos e catálogos de modelos de todos eles. Um contrato `many` não aparece em `providers`.

Quando a composição escolhe outro provedor para um contrato que o core também fornece, o loader não registra a implementação do core para esse contrato naquele ambiente, e o `services.use` do próprio core devolve o provedor escolhido.

Contratos `doric.*` são da plataforma: não aparecem no `provides` de nenhum bundle, sempre existem e nunca entram em `requires`; `use` deles é sempre permitido. Os bundles da fundação (abaixo) só podem declarar `requires` de contratos `doric.*`, e o core só pode declarar `requires` de contratos que a fundação fornece (`storage.backend/v1` e `secrets.backend/v1`).

Dependências opcionais não entram no manifesto: o código as consulta com `services.whenAvailable(...)` (ou `services.use(HooksV1).whenAvailable(...)`, no caso de hooks) e degrada sozinho quando elas não existem.

### `optional`, `desktopScope` e exposição de métodos

- `optional` lista IDs de contrato que o bundle pode chamar em melhor esforço, sem dependência de ativação. Sem provedor ativo, a chamada cai no comportamento indisponível do próprio chamador. O transporte usa esse campo para `files/v1`, `git.commands/v1`, `usage/v1`, `resources/v1` e `terminal/v1`.
- `desktopScope` é um mapa de contrato para as chaves de escopo que uma janela desktop pode enviar a esse contrato. Qualquer outra chave é recusada, e `windowKey` é só da plataforma.
- A exposição de um método segue a mesma regra. Um método só chega a uma janela desktop com `expose: 'desktop'`: nos contratos da plataforma, a declaração fica no `MethodSpec` de `packages/bundle`; nos contratos de um provedor, fica em `x-doric-expose` do documento do contrato. O padrão é negar. Ver [serviços e canais](./services-and-channels.md#exposição-à-janela-desktop).

## Convenções de pastas

As partes do bundle e os recursos estáticos são encontrados por convenção:

| Caminho no bundle   | Significado                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| `host/index.js`     | Parte `host`                                                               |
| `desktop/index.js`  | Parte `desktopMain`                                                        |
| `client/index.js`   | Parte `client`                                                             |
| `contracts/`        | Entrypoint público com as referências e as definições sem lógica do bundle |
| `skills/*/SKILL.md` | Skills; `alwaysAvailable` passa para o frontmatter do próprio `SKILL.md`   |

Não existe convenção de pasta para JSON Schemas. Nenhum bundle escreve JSON Schema à mão: os schemas são escritos em zod nas definições `define*`, e o JSON Schema canônico é gerado deles no build e publicado no catálogo. Consumidores de outros bundles importam só o entrypoint `contracts/` (por exemplo `git/contracts`). O formato desse entrypoint e da família `define*` está em [contratos](./contracts.md).

## Registro em código

Tools, eventos, comandos, rotas, views, custom elements, settings, tipos de storage, hooks, janelas, menus e atalhos são registrados pelo código de ativação por meio dos serviços correspondentes (`tools/v1`, `events/v1`, `commands/v1`, `navigation/v1`, `ui/v1`, `settings/v1`, `storage/v1`, `hooks/v1`, `windows/v1` e `menus/v1`), cada um com seu schema zod, do qual a plataforma gera o JSON Schema. Cada registro acontece na parte do ambiente em que o serviço existe: `commands/v1` existe no `desktopMain` e no `client`, não no `host`, então comandos de UI e de menu são definidos com `defineCommand` e registrados na parte `client` (ou `desktopMain`), e a parte `host` nunca registra comando. Janelas, menus e atalhos passam por `windows/v1` e `menus/v1`, que o core expõe com suas políticas sobre os contratos nativos `doric.windows/v1` e `doric.menus/v1`, usados pelo core (veja [bundle core e quarentena](./core.md)). Como `windows/v1` e `menus/v1` são fornecidos no `desktopMain`, uma parte `client` que os declara em `requires` abre e foca janelas e registra itens, atalhos e `setContext` pela ponte, sem precisar de parte `desktopMain`. O provedor de cada serviço valida o registro com o schema do contrato e detecta conflitos no momento do registro; o loader rastreia o registro em nome do bundle, e um conflito coloca o bundle em quarentena com motivo.

As definições sem lógica (eventos, settings, hooks, tipos de storage) ficam em arquivos separados de `contracts/` (`contracts/events.ts`, `contracts/settings.ts`). Serviços e comandos têm `execute`, então a definição fica na parte que os fornece (`host/git-commands.ts`), e `contracts/refs.ts` exporta só uma referência tipada criada com `ref`. `contracts/index.ts` reexporta tudo. Os imports seguem três origens:

- `bundle/contracts`, o subpath browser-safe de `packages/bundle`, exporta as funções `define*` e `ref`, os tipos `HostContext`, `DesktopContext`, `ClientContext`, `Services` e `Call`, as constantes dos contratos da plataforma (`AppHooksV1`, `WindowHooksV1`, `DoricWindowsV1`, `DoricMenusV1` e as demais `Doric*V1`) e as referências dos contratos básicos, com seus tipos (`HooksV1`, `EventsV1`, `SettingsV1`, `ToolsV1`, `UiV1`, `NavigationV1`, `RegionsV1`, `StorageV1`, `StorageBackendV1` e os demais). As referências ficam na plataforma porque qualquer bundle pode fornecer esses contratos; o core fornece as definições com `execute`, por exemplo `defineService(WindowsV1, { open: defineMethod({ input, output, execute }) })`.
- `<bundle>/contracts` exporta os contratos de cada bundle para consumidores de outros bundles, por exemplo `chat/contracts` e `runtime/contracts`; `core/contracts` exporta só o que é do core (`CoreHooksV1` e a referência `OpenSettingsCommandV1`, do comando `core.open-settings/v1`).
- O próprio bundle importa seus contratos por caminho relativo (`../contracts/index.js`).

Nenhum código de bundle importa o entrypoint `bundle`, que é o loader Node.

Pseudocódigo da API proposta:

```ts
// contracts/events.ts
import { defineEvent } from 'bundle/contracts';
import { z } from 'zod';

export const branchSwitchedEvent = defineEvent({
  type: 'git.branch-switched/v1',
  payload: z
    .object({
      projectId: z.string(),
      repository: z.string(),
      from: z.string(),
      to: z.string(),
    })
    .strict(),
});

// contracts/settings.ts
import { defineSettings } from 'bundle/contracts';
import { z } from 'zod';

export const gitSettings = defineSettings({
  id: 'git.settings/v1',
  schema: z.object({ defaultRemote: z.string().default('origin') }).strict(),
});

// host/git-commands.ts: a definição com execute fica na parte que fornece o serviço
import {
  defineMethod,
  defineService,
  EventsV1,
  SettingsV1,
} from 'bundle/contracts';
import { RuntimeLeaseV1 } from 'runtime/contracts';
import { z } from 'zod';
import { branchSwitchedEvent, gitSettings } from '../contracts/index.js';

export const gitCommands = defineService('git.commands/v1', {
  switchBranch: defineMethod({
    input: z.object({ projectId: z.string(), to: z.string() }).strict(),
    output: z.object({ from: z.string(), to: z.string() }).strict(),
    // call.caller é o bundle que chamou o git; services são os do git.
    execute: async (input, call, services) => {
      const { defaultRemote } = await services.use(SettingsV1).get(gitSettings);
      const { repository, from, to } = await checkoutUnderLease(
        services.use(RuntimeLeaseV1),
        input,
        defaultRemote,
        call,
      );
      // Repassar call herda scope, signal e trace; o caller deste salto é git.
      await services
        .use(EventsV1)
        .append(
          branchSwitchedEvent,
          { projectId: input.projectId, repository, from, to },
          call,
        );
      return { from, to };
    },
  }),
});

// contracts/refs.ts: só o ID e o tipo; o import type some no build
import { ref } from 'bundle/contracts';
import type { gitCommands } from '../host/git-commands.js';

export const GitCommandsV1 = ref<typeof gitCommands>('git.commands/v1');

// contracts/index.ts: reexporta as definições sem lógica e as referências
export { branchSwitchedEvent } from './events.js';
export { gitSettings } from './settings.js';
export { GitCommandsV1 } from './refs.js';

// host/index.js: aqui o próprio dono importa seus contratos por caminho relativo
import {
  EventsV1,
  SettingsV1,
  ToolsV1,
  type HostContext,
} from 'bundle/contracts';
import { branchSwitchedEvent, gitSettings } from '../contracts/index.js';
import { gitCommands } from './git-commands.js';
import { gitTool } from './git-tool.js';

export const activate = ({ services }: HostContext) => {
  services.use(ToolsV1).register(gitTool, { alwaysAvailable: false });
  services.use(EventsV1).register(branchSwitchedEvent);
  services.use(SettingsV1).register(gitSettings);
  services.provide(gitCommands);
};

// client/index.js
import { UiV1, type ClientContext } from 'bundle/contracts';
import { ChatViewsV1 } from 'chat/contracts';

export const activate = ({ services }: ClientContext) => {
  services.use(UiV1).define('git-branch-event', GitBranchEvent);
  services.whenAvailable(ChatViewsV1, (views) =>
    views.registerRenderer({
      blockType: 'git.branch-change/v1',
      elementTag: 'git-branch-event',
    }),
  );
};
```

`gitTool` continua sendo definido com o `defineTool` de `packages/tool/src/lib/tools.ts`, que é o molde das outras definições. Como mudança proposta do pacote `tool`, o `execute` deixa de receber `(sandbox, host, payload, config)` e passa a receber `(payload, call, services)`, com os serviços do bundle ligados no `register` de `tools/v1`, como o `execute` de `defineMethod` e de `defineCommand`. Todo stub aceita como último argumento opcional um `call` pai (o `call` recebido) ou `{ signal, deadline }`; o dispatcher herda do pai `scope`, `signal` e `trace` e preenche `call.caller` (`{ bundleId, version, generation }`) com o bundle que faz a chamada, sem herdá-lo. Partes `host` recebem `HostContext`, partes `desktopMain` recebem `DesktopContext` e partes `client` recebem `ClientContext`; os três só têm `services` (`provide`, `use`, `whenAvailable`), descritos em [contextos e capacidades](./contexts.md). `tools/v1`, `events/v1`, `settings/v1` e `ui/v1` são fornecidos pelo core por padrão e podem ser substituídos por outro bundle.

`services.use(UiV1).define` recusa uma tag que não comece com `<id do bundle chamador>-` e confere se a tag já existe no catálogo da janela antes de chamar `customElements.define`. Os hashes SHA-256 dos arquivos não ficam no manifesto: o host os calcula na instalação e os publica no catálogo, que o desktop usa para conferir a integridade do cache (veja [composição e distribuição](./composition-and-distribution.md)).

### IDs, ordem de ativação e descarte

IDs de contribuição de um bundle começam com o ID dele: contratos no formato `<bundle>.<nome>/vN` ou `<bundle>/vN` (`git.settings/v1`, `runtime/v1`), tags de custom elements no formato `<bundle>-<nome>` (`git-branch-event`) e regiões no formato `<bundle>.<nome>` (`layout.panel`, `settings.sections`). Itens de região têm IDs sem versão (`providers`, na região `settings.sections`), distintos do path da rota `/settings/providers`; rotas são paths de URL e não levam prefixo de bundle (veja [navegação e rotas](./navigation.md)). Há duas exceções ao prefixo: os contratos básicos, que só levam o domínio (`hooks/v1`, `settings/v1`, `ui/v1`, `navigation/v1`, `regions/v1`, `storage.backend/v1` e os demais); e os nomes de tools já públicos, cuja unicidade global precisa ser preservada durante a migração.

Em cada ambiente, o loader ativa nesta ordem:

1. A **fundação**: os bundles escolhidos em `providers` para contratos que o core fornece ou consome, por exemplo `myhooks` para `hooks/v1` e `postgres` para `storage.backend/v1` e `secrets.backend/v1`. Um provedor que substitui uma fachada básica pode exigir os backends de storage e segredos; os demais não podem depender de bundles ativados depois.
2. O core, cujo `requires` só pode citar contratos da fundação (`storage.backend/v1` e `secrets.backend/v1`).
3. Os demais bundles, em ordem de dependência.

O loader só publica entradas íntegras, ou seja, cada bundle ativo tem todas as suas dependências obrigatórias ativas. Como o core fornece os serviços básicos, ele é dependência de quase todos os bundles, e uma falha do core leva ao modo de recuperação. Depois que o provedor de `hooks/v1` de um ambiente ativa, a plataforma daquele ambiente define `AppHooksV1` e passa a dispará-los; qualquer bundle registra handlers desses hooks. Uma falha do `activate` de um bundle leva à quarentena; uma falha de um handler de `onActivateHook` só vai ao diagnóstico. Cada registro feito por meio de serviços pertence a um escopo e é rastreado pelo loader, que o descarta em ordem inversa na desativação; `activate` pode devolver uma função de limpeza, executada no mesmo descarte. Uma falha de ativação desfaz os registros reversíveis daquela tentativa; uma tag já definida em `customElements` exige recarga da janela para troca ou nova tentativa.

## Validação do manifesto

O manifesto v1 é validado por um JSON Schema publicado em `doric://app/schemas/bundle-manifest/v1.json`, gerado a partir do schema zod de `packages/bundle`. A plataforma publica esse schema; ele não é uma pasta `schemas/` de bundle.

## Manifesto v0

O formato legado (`name`, `description`, `tools`, `skills`) é o manifesto v0, reconhecido pela ausência de `manifestVersion`. O loader converte v0 em memória:

- `id` preserva o `name` informado pelo autor, sem renomeações específicas de produto;
- `version` é `0.0.0`;
- o próprio loader registra as tools e skills listadas em nome do bundle.

Os bundles distribuídos já usam v1. A conversão de v0 permanece como compatibilidade do loader (veja [migração](./migration.md)).

## Relações

- [Contratos e a família define\*](./contracts.md): define os IDs de contrato que aparecem em `provides` e `requires` e o entrypoint `contracts/` das convenções de pastas.
- [Bundle core e quarentena](./core.md): explica quais serviços básicos o core fornece, por que a fundação e depois o core ativam antes dos demais bundles, por que o core só declara `requires` de contratos da fundação e o que acontece com um bundle cujo registro conflita.
- [Versionamento semântico](./versioning.md): dá as regras de semver para `version`, `engines.doric` e as versões e faixas de `provides` e `requires`.
- [Contextos e capacidades](./contexts.md): descreve `HostContext`, `DesktopContext` e `ClientContext`, que só entregam `services`, e o `call` recebido por cada handler e repassado aos stubs.
- [Composição e distribuição pelo host](./composition-and-distribution.md): explica como o host calcula os hashes e publica o catálogo que substitui hashes no manifesto.
- [Serviços entre bundles e canais de mensagens](./services-and-channels.md): detalha `services.provide`, `services.use` e `services.whenAvailable`, usados para dependências opcionais, a cardinalidade `one` ou `many` e a escolha de provedor em `providers` por ambiente.
- [Hooks e ciclo de vida](./hooks.md): detalha `hooks/v1` (`define`, `use`, `whenAvailable`), os hooks do ciclo de vida que a plataforma define e os contratos de hooks que um bundle declara.
- [Migração em entregas verificáveis](./migration.md): fixa a etapa em que os bundles atuais deixam o manifesto v0.
