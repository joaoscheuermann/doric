# Versionamento semântico

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

A plataforma, cada bundle e cada contrato têm sua própria versão semver. O ID de um contrato carrega a sua major no sufixo `/vN`, então majors diferentes são contratos diferentes e podem ser fornecidos ao mesmo tempo, enquanto minors e patches da mesma major são intercambiáveis. Consumidores pedem faixas em `requires`, e um bundle cuja faixa não é atendida entra em quarentena com o motivo. A verificação de build que compara os JSON Schemas gerados do zod com a versão publicada e recusa uma versão menor do que a mudança exige está suspensa; a seção [estado atual da verificação](#estado-atual-da-verificação) explica quando ela volta.

## Estado atual da verificação

Até existir publicação de bundles (etapa 11), não há `contracts.published.json` commitado: os arquivos foram removidos, o comando `baseline` do CLI de build e os alvos `contracts-baseline` do Nx também. O build gera `dist/contracts.json` e os JSON Schemas, mas não compara nada com uma versão anterior, e um arquivo `contracts.published.json` deixado no bundle é ignorado. Quando a publicação existir, a verificação volta comparando com o registro publicado, não com um arquivo commitado no repositório. As regras desta página (tabela de mudanças, major no ID e faixas) continuam sendo a referência para escolher a versão; só a checagem automática está suspensa.

## O que tem versão

Três coisas têm versão semver, cada uma com seu escopo:

| O quê      | Onde é declarada                                                 | Exemplo                             |
| ---------- | ---------------------------------------------------------------- | ----------------------------------- |
| Plataforma | Host e desktop técnicos, preload, loader, pacotes compartilhados | `doric 1.6.0`                       |
| Bundle     | `version` do manifesto                                           | `git 1.4.0`                         |
| Contrato   | Serviços, hooks, eventos, comandos, settings                     | `git.commands/v1` na versão `1.3.0` |

Serviços, hooks, eventos, comandos e settings são definidos em zod pelas funções `define*` descritas em [contratos](./contracts.md): `defineService` com `defineMethod`, `defineHook` com `defineHooks`, `defineEvent`, `defineCommand` e `defineSettings`. O ID versionado do contrato é o primeiro argumento de `defineService` e `defineHooks` (por exemplo `defineService('git.commands/v1', ...)` ou `defineHooks('git.hooks/v1', ...)`), o campo `type` de `defineEvent` e o campo `id` de `defineCommand` e `defineSettings`. Rotas não são contratos e não têm versão: uma rota é um path de URL registrado com `register({ path, create, parent? })` de `navigation/v1`, e o path é a sua identidade, como está em [navegação e rotas](./navigation.md). Um path registrado por dois bundles é conflito, e o segundo vai para quarentena com motivo.

Os contratos básicos seguem as mesmas regras. `bundle/contracts` exporta as referências e os tipos deles (`HooksV1`, `LogV1`, `SettingsV1`, `SecretsV1`, `SecretsBackendV1`, `ToolsV1`, `SkillsV1`, `StorageV1`, `StorageBackendV1`, `EventsV1`, `ModelsV1`, `ModelsProviderV1`, `CommandsV1`, `UiV1`, `NavigationV1`, `RegionsV1`, `WindowsV1`, `MenusV1`), e os versiona, porque qualquer bundle pode fornecê-los; o core fornece as definições com `execute`, por exemplo `defineService(WindowsV1, { open: defineMethod({ input, output, execute }) })`. O core fornece por padrão `hooks/v1`, `log/v1`, `settings/v1`, `secrets/v1`, `tools/v1`, `skills/v1`, `storage/v1`, `events/v1`, `models/v1`, `commands/v1`, `ui/v1`, `navigation/v1`, `regions/v1`, `windows/v1` e `menus/v1`; o bundle `postgres`, da fundação, fornece por padrão `storage.backend/v1` e `secrets.backend/v1`. Os contratos próprios do core (`CoreHooksV1` e `OpenSettingsCommandV1`, a referência ao comando `core.open-settings/v1`) vêm de `core/contracts` e são versionados pelo core.

Um bundle que substitui o provedor padrão de um contrato de cardinalidade `one`, escolhido em `providers` da composição, declara em `provides` uma versão da mesma major; os consumidores continuam pedindo faixas em `requires`, e a plataforma usa o provedor ativo sem conhecer a implementação. A escolha vale em cada ambiente em que o bundle escolhido fornece o contrato; nos outros, o provedor padrão continua, e a faixa de `requires` é conferida contra o provedor ativo de cada ambiente. Quando a composição escolhe outro provedor para um contrato que o core também fornece, o loader não registra a implementação do core naquele ambiente. Sem escolha em `providers`, o segundo provedor de um contrato `one` vai para quarentena com motivo; como a fundação e o core ativam antes, é o bundle substituto que fica em quarentena. Num contrato `many` (por exemplo `models.provider/v1`, pelo qual `openai`, `openrouter` e `codex` registram seus provedores de modelo, agregados pelo `models/v1` do core), vários provedores convivem sem conflito, cada um declarando sua própria versão em `provides`, e o consumidor os agrega.

Os contratos `doric.*` (por exemplo `doric.app.hooks/v1`, `doric.window.hooks/v1`, `doric.windows/v1`, `doric.menus/v1`, `doric.catalog/v1`, `doric.diagnostics/v1`, `doric.bundle/v1`, `doric.cache/v1`, `doric.tokens/v1`, `doric.drawio/v1`, que chegou na plataforma 1.1.0) são versionados junto com a plataforma e não aceitam outro provedor. Eles sempre existem e nunca entram em `requires`; a compatibilidade com eles é declarada só por `engines.doric`. Por isso um bundle da fundação, que só pode declarar `requires` de contratos `doric.*`, na prática depende apenas de `engines.doric`.

A plataforma 1.2.0 (`PLATFORM_VERSION`) acrescentou o subpath `desktop/ui/canvas` ao pacote compartilhado `packages/desktop`: as peças de canvas que não dependem da âncora (viewport, gestos, threads, log compartilhado da Thread, cabeçalho, barra, pinos, popover e o `CanvasModal`), antes internas ao papercraft. Um bundle que importa `desktop/ui/canvas` pede essa versão em `engines.doric`.

## Major no ID e faixas em `requires`

O sufixo `/vN` do ID de um contrato é a sua major; a versão depois do `@` em `provides` precisa ter a mesma major. Um consumidor pede uma faixa em `requires` (`git.commands/v1@^1.2.0` significa “1.2.0 ou mais nova, ainda major 1”). Assim, majors diferentes são contratos diferentes e podem ser fornecidos ao mesmo tempo, enquanto minors e patches da mesma major são intercambiáveis.

Todo contrato que um bundle usa com `services.use` entra em `requires` com uma faixa, inclusive os básicos fornecidos pelo core (`hooks/v1`, `log/v1`, `events/v1`, `settings/v1` e os demais). Contratos opcionais, usados com `whenAvailable`, não entram em `requires`. O core também declara faixas em `requires`, mas só para os contratos que a fundação fornece (`storage.backend/v1`, `secrets.backend/v1`); se uma faixa não for atendida ali, a parte `host` do core não ativa e o host entra no modo de recuperação, descrito em [bundle core e quarentena](./core.md) e mostrado em [splash e recuperação](./splash-and-recovery.md).

O formato de `provides` e `requires` no manifesto está em [manifesto](./manifest.md).

## Regras por tipo de contrato

| Mudança                                                                      | Serviço | Evento durável                                         | Settings                                         |
| ---------------------------------------------------------------------------- | ------- | ------------------------------------------------------ | ------------------------------------------------ |
| Correção sem mudança de schema                                               | patch   | patch                                                  | patch                                            |
| Método novo, campo opcional novo na entrada, campo novo na saída             | minor   | minor (campo opcional novo)                            | minor (campo opcional com default)               |
| Remover ou renomear campo ou método, campo obrigatório novo, outra semântica | major   | major: novo tipo `/v2` e upcaster registrado pelo dono | major: migração explícita registrada pelo bundle |

Em settings, a migração de uma major nova é registrada junto da definição feita com `defineSettings`.

## Regras de leitura e escrita

- Consumidores tratam códigos de erro desconhecidos como erro genérico do contrato, por isso um código novo é minor. O código é o `code` do erro com que o método rejeita a Promise.
- O produtor de um evento valida a escrita com o schema fechado da sua versão (o `payload` em zod do `defineEvent`, com `.strict()`). O leitor valida pela major e ignora campos de uma minor mais nova que ele não conhece. Eventos gravados nunca são reescritos; um upcaster `v1 → v2` converte na leitura.
- A versão do bundle segue a maior mudança entre seus contratos: major se algum contrato fornecido muda de major ou some, minor se um contrato ou contribuição aparece ou recebe minor, patch nos outros casos.
- Os JSON Schemas dos contratos são os gerados do zod no build, os mesmos publicados no catálogo; nenhum bundle escreve JSON Schema à mão. Até a publicação existir, o build não recusa uma versão menor do que a mudança exige (ver [estado atual da verificação](#estado-atual-da-verificação)).
- A plataforma muda de major quando um pacote compartilhado muda de major (por exemplo, React 20) ou quando a ponte ou o loader quebram compatibilidade. Por isso `engines.doric` basta para cobrir os pacotes compartilhados. Os pacotes compartilhados estão em [pacotes compartilhados](./platform-packages.md).
- Um contrato descontinuado é fornecido junto com a major nova até ser removido; o diagnóstico lista os consumidores de cada contrato, então mostra quem ainda usa a major antiga.

## Exemplos

1. `git 1.4.0` fornece `git.commands/v1` na versão `1.3.0`. O client de Git pede `^1.2.0` e ativa.
2. `graph 0.3.0` pede `git.commands/v1` `^1.4.0`, porque usa `listGraph`, adicionado na 1.4.0. Com a 1.3.0 ativa, ele entra em quarentena com o motivo “requer git.commands/v1 ≥ 1.4.0; ativo 1.3.0 (git 1.4.0)”.
3. `git 2.0.0` renomeia `switchBranch`. Ele fornece `git.commands/v2` `2.0.0` e continua fornecendo `v1` `1.3.0`, que chama a lógica da `v2`. Consumidores antigos continuam funcionando; os novos pedem `v2`. Na `3.0.0`, `v1` sai, e quem só pede `v1` entra em quarentena com motivo.
4. `git.branch-switched/v1` `1.1.0` adiciona `upstream`, opcional. O projetor de conversa escrito para a `1.0.0` lê o evento e ignora o campo. Uma `v2` que renomeia `repository` para `repositoryPath` vem com upcaster; o projetor novo só conhece `v2` e recebe os eventos antigos já convertidos.
5. Um bundle declara `engines.doric: "^1.4.0"`. Num desktop 1.3.2, sua parte client fica em quarentena até o app ser atualizado. Num desktop 2.0.0, que trouxe React 20, ela também fica, porque `^1.4.0` não aceita a major 2.

A quarentena e o motivo exibido estão em [bundle core e quarentena](./core.md) e em [splash e recuperação](./splash-and-recovery.md).

### Exemplo 3 no código

Pseudocódigo da API proposta. As duas majors são contratos diferentes e convivem como duas definições, cada uma com seus `execute`; o nome do método muda na `v2` (o novo nome abaixo é ilustrativo), e a `v1` chama a lógica da `v2`:

```ts
// git, host/git-commands.ts
import {
  defineMethod,
  defineService,
  HooksV1,
  LogV1,
  type Call,
  type Services,
} from 'bundle/contracts';
import { z } from 'zod';
import { GitHooksV1 } from '../contracts/index.js';

const branchInput = z
  .object({ projectId: z.string(), to: z.string() })
  .strict();
const branchOutput = z.object({ from: z.string(), to: z.string() }).strict();

const checkoutBranch = async (
  { projectId, to }: z.infer<typeof branchInput>,
  call: Call,
  services: Services,
) => {
  const gitHooks = services.use(HooksV1).define(GitHooksV1);
  services.use(LogV1).info('checkout', { projectId, to });
  /* ... dispara gitHooks.onBeforeSwitchBranchHook.execute(..., call), troca o branch e devolve { from, to } ... */
};

export const gitCommandsV2 = defineService('git.commands/v2', {
  checkoutBranch: defineMethod({
    input: branchInput,
    output: branchOutput,
    execute: checkoutBranch,
  }),
});

export const gitCommandsV1 = defineService('git.commands/v1', {
  switchBranch: defineMethod({
    input: branchInput,
    output: branchOutput,
    // a v1 repassa o call recebido; o dispatcher herda scope, signal e trace
    execute: (input, call, services) => checkoutBranch(input, call, services),
  }),
});
```

O entrypoint `contracts/` exporta só as referências, com `import type` das definições, que some no build:

```ts
// git, contracts/index.ts
import { ref } from 'bundle/contracts';
import type { gitCommandsV1, gitCommandsV2 } from '../host/git-commands.js';

export const GitCommandsV1 = ref<typeof gitCommandsV1>('git.commands/v1');
export const GitCommandsV2 = ref<typeof gitCommandsV2>('git.commands/v2');
```

No código do host, `activate` recebe só `services` e fornece as duas definições; o loader rastreia os dois `provide` e os descarta em ordem inversa na desativação:

```ts
// git, host/index.ts
import { type HostContext } from 'bundle/contracts';
import { gitCommandsV1, gitCommandsV2 } from './git-commands.js';

export const activate = ({ services }: HostContext) => {
  services.provide(gitCommandsV2);
  services.provide(gitCommandsV1);
};
```

Cada `execute` recebe `(input, call, services)`; `services` são os serviços do `git`, ligados no `provide`. `call.caller` (`{ bundleId, version, generation }`) é preenchido pelo dispatcher e identifica quem chamou o Git; quando o Git repassa `call` a outro contrato, o `caller` desse novo salto é `git`, nunca herdado. Como o `execute` da `v1` chama a lógica da `v2` dentro do próprio bundle, sem passar pelo dispatcher, o `caller` e o diagnóstico de quem usa cada contrato continuam apontando para o consumidor que ainda pede `v1`.

O manifesto de `git` lista em `provides` a `v2` na versão `2.0.0`, a `v1` na versão `1.3.0` e `git.hooks/v1`, cujo dono é o git, e em `requires` os contratos que o código usa com `use`:

```json
{
  "manifestVersion": 1,
  "id": "git",
  "version": "2.0.0",
  "engines": { "doric": "^1.6.0" },
  "provides": [
    "git.commands/v2@2.0.0",
    "git.commands/v1@1.3.0",
    "git.hooks/v1@1.0.0"
  ],
  "requires": ["hooks/v1@^1.0.0", "log/v1@^1.0.0"]
}
```

Quando a verificação de build voltar (etapa 11), ela compara o JSON Schema gerado de `gitCommandsV1` com o registro publicado e confirma que a `v1` não mudou de forma incompatível. Até lá a comparação está suspensa, como explica a seção [estado atual da verificação](#estado-atual-da-verificação).

## Relações

- [Contratos e a família define\*](./contracts.md): define os contratos versionados e gera os JSON Schemas que a verificação de build vai comparar quando voltar.
- [Manifesto v1](./manifest.md): declara `version`, `engines.doric`, `provides` e `requires`, onde as versões e faixas aparecem.
- [Bundle core e quarentena](./core.md): aplica a quarentena quando uma faixa de `requires` ou `engines.doric` não é atendida e define a ordem de ativação da fundação, do core e dos demais bundles.
- [Splash e recuperação](./splash-and-recovery.md): mostra os bundles em quarentena e o motivo de versão de cada um.
- [Composição e distribuição pelo host](./composition-and-distribution.md): resolve quais versões de bundles estão ativas numa composição e escolhe, em `providers`, o provedor de cada contrato `one` por ambiente.
- [Serviços entre bundles e canais de mensagens](./services-and-channels.md): o diretório de serviços resolve contratos por ID com major e lista consumidores de contratos descontinuados.
- [Hooks e ciclo de vida](./hooks.md): contratos de hooks agrupados por `defineHooks` também são versionados pelo ID.
- [Eventos e nodes](./events-and-nodes.md): eventos duráveis seguem a regra de minor por campo opcional e de major com upcaster.
- [Armazenamento genérico e histórico](./storage.md): eventos gravados nunca são reescritos, o que exige upcasters na leitura.
- [Pacotes compartilhados e tokens do tema](./platform-packages.md): uma major de pacote compartilhado vira uma major da plataforma.
- [Observabilidade e diagnóstico](./observability.md): o diagnóstico lista consumidores de contratos descontinuados.
