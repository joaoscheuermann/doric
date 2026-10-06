# Doric: monitor de hardware (máquina e sandbox)

Status: contrato de implementação em andamento na branch `feat/hardware-monitor`.
Este documento congela os contratos entre as camadas antes da implementação
paralela. Ele é a fonte de verdade para nomes, formatos e rotas.

## 1. Objetivo

Mostrar, no app, o consumo de recursos de dois sujeitos distintos:

- **Máquina**: o host onde o processo Doric roda (`agents/doric`).
- **Sandbox**: o container/sandbox do Project selecionado.

Não há histórico, gráfico ou alerta. É uma leitura sob demanda, com polling.

## 2. Decisões

- A máquina é lida pelo **próprio host Doric** (`node:os`), e não pelo Electron.
- O sandbox é lido pelo **provider**, através de uma nova capacidade
  `stats()` no boundary do sandbox.
- A UI vive no **footer do sidebar direito** (`project-files-footer`), hoje um
  strip vazio `aria-hidden`.

## 3. Contratos

### 3.1 Boundary do sandbox (já implementado neste branch)

`packages/sandbox/src/lib/types/sandbox.ts`:

```ts
export interface SandboxStats {
  readonly cpuPercent?: number;
  readonly cpuCount?: number;
  readonly memoryUsedBytes?: number;
  readonly memoryLimitBytes?: number;
  readonly at: string;
}

export interface SandboxRuntime {
  // ...
  stats?(): Promise<SandboxStats>;
}

export interface Sandbox {
  // ...
  stats?(): Promise<SandboxStats | undefined>;
}
```

`cpuPercent` é sempre a fração usada da **própria cota do sandbox** (`0..100`),
nunca a fração do host inteiro. Um sandbox usando toda a cota que recebeu lê
`100`, mesmo que existam outros 30 cores livres na máquina.

`SandboxStats` é o que um provider sabe medir. `Sandbox.stats()` é **opcional**
na interface e devolve `undefined` quando o provider não sabe medir; nunca rejeita
por ausência de capacidade.

### 3.2 Host (`agents/doric`)

`agents/doric/src/lib/workspace/resources.ts` (novo):

```ts
export interface HostResources {
  readonly at: string;
  readonly cpuCount: number;
  /** 0..100 entre todos os cores; ausente na primeira leitura. */
  readonly cpuPercent?: number;
  readonly loadAverage?: number;
  readonly memoryTotalBytes: number;
  readonly memoryUsedBytes: number;
  readonly uptimeSeconds: number;
}

export interface ContainerResources {
  readonly status: 'ready' | 'unavailable';
  readonly at: string;
  readonly cpuPercent?: number;
  readonly cpuCount?: number;
  readonly memoryUsedBytes?: number;
  readonly memoryLimitBytes?: number;
}

export const readHostResources = (now?: Date): HostResources;
export const readSandboxResources = (
  sandbox: Sandbox,
  now?: Date,
): Promise<ContainerResources>;
```

- `cpuPercent` da máquina vem de deltas de `node:os` `cpus()`, exigindo uma
  amostra anterior guardada em memória no processo. Sem amostra anterior, o
  campo fica ausente.
- `readSandboxResources` chama `sandbox.stats()` e traduz `undefined` para
  `{ status: 'unavailable', at }`.

### 3.3 Service e rotas (`agents/doric`)

`WorkspaceService.projects` ganha:

```ts
resources(id: string): Promise<ProjectResources>;
```

```ts
export type ProjectResources =
  | { readonly status: ProjectLeaseState }
  | { readonly status: 'ready'; readonly container: ContainerResources };
```

Implementação usa o `withLease` existente em `service.ts`: o monitor **não**
adquire lease, apenas responde o estado quando não há um vivo.

Rotas:

| Rota                          | Resposta                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `GET /resources`              | `200` `HostResources` (nunca depende de lease)                                          |
| `GET /projects/:id/resources` | estados de lease como os outros subresources; `200` `ContainerResources` quando `ready` |

O router da máquina é novo (`agents/doric/src/routes/resources.ts`) e é montado
em `lib/http/app.ts` com `app.use('/resources', ...)`. A rota de projeto segue o
padrão de `/:id/files`, reusando o helper `leaseResponse`.

### 3.4 Electron main (`app/doric`)

- `app/doric/src/workspace/resources.ts` (novo): cópia local de
  `HostResources` / `ContainerResources`, como `workspace/usage.ts` já faz.
- `api.ts`: `resources: { host(), project(projectId) }` sobre `request<T>`.
- `ipc.ts`: canais `doric:resources:host` e `doric:resources:project`
  (o segundo valida o id com `identifier`).
- `app/api/preload.ts`: `window.doric.resources.host()` e
  `window.doric.resources.project(id)`.

### 3.5 Renderer (`app/doric-renderer`)

- `domain/workspace.ts`: `WorkspaceApi` ganha
  `readonly resources: { host(): Promise<HostResources>; project(projectId: string): Promise<ProjectResourcesResult> }`,
  com `ProjectResourcesResult` carregando os estados de lease do host.
- `domain/resources.ts` (novo, puro e testável): formatação e regras de limiar.
- `hooks/use-resources.ts` (novo): duas queries TanStack com
  `refetchInterval: 3000`, `refetchOnWindowFocus: true`, `staleTime: 1000`,
  `retry: 2`; a query do projeto só roda com `projectId` definido.
- `queries/keys.ts`: `hostResources: ['resources', 'host']` e
  `projectResources: (projectId) => ['resources', projectId]`.
- `components/organisms/resource-monitor.tsx` (novo) + footer em
  `components/organisms/project-files-sidebar.tsx`.

## 4. UX congelada

- No footer do painel direito, o strip deixa de ser decorativo: sai o
  `aria-hidden`, entra `className="flex chrome-bar shrink-0 items-center gap-1
border-t bg-sidebar px-2 text-xs"`.
- Dois controles `Button variant="ghost" size="xs"` (o mesmo controle que
  `WorkspaceCwd` usa), cada um dentro de `Tooltip` + `Popover` (`side="top"`):
  sandbox primeiro, máquina depois de um `ToolbarDivider`.
- Texto: percentual e absoluto compacto, `tabular-nums`, `min-w-0 truncate`.
  Unidades: a maior que caiba, um decimal, com `.0` final removido (`512 MiB`,
  `1.5 GiB`); um par usado/limite compartilha a unidade do limite (`0.3 / 2
GiB`), para que os dois números leiam na mesma escala.
  Sem barra de progresso em repouso; gauge só dentro do popover.
- Cor: `text-muted-foreground` em repouso. `text-warning` apenas no valor que
  cruzou o limiar (memória ≥ 85% do limite; CPU ≥ 90% sustentado em 3 leituras).
- Erro de leitura **não** apaga o valor: mantém o último e marca staleness no
  tooltip ("Last read 12s ago"). Nada de toast, nada de `ReadFeedback`, nada de
  `aria-live`.
- Estados: `—` + tooltip "Preparing environment…" (pending),
  "Environment unavailable" (unavailable/expired),
  "Resources unavailable in this provider" (provider sem `stats()`).
- `aria-label` descritivo por controle, com os valores atuais.

## 5. Frentes e propriedade de arquivos

| Frente | Dono             | Arquivos                                                        |
| ------ | ---------------- | --------------------------------------------------------------- |
| A      | subagente        | `packages/docker/**`, `packages/firecracker/**` (e seus testes) |
| B      | subagente        | `agents/doric/**`, `app/doric/**`                               |
| C      | subagente        | `app/doric-renderer/**`                                         |
| D      | thread principal | `packages/sandbox/**` (feito), `docs/**`, `GROUNDING.md`        |

Nenhuma frente edita arquivo de outra. `packages/sandbox` já tem o contrato e
não deve ser alterado pelas frentes A, B ou C.

Pontos de integração que não podem ser esquecidos:

- `agents/doric/src/lib/vms.ts` envolve o runtime num `tracked(...)` que copia
  métodos explicitamente: `stats` precisa ser repassado, senão o sandbox do
  registry perde a capacidade (o tipo `SandboxRuntime.stats` é opcional, então o
  compilador não avisa).
- `packages/sandbox/tests/fake-sandbox.ts` implementa a interface `Sandbox`:
  `stats()` é obrigatório nela e já foi implementado no fake retornando
  `undefined`, que significa "este sandbox não sabe medir".

## 6. Validação

```console
npx tsc -p packages/docker/tsconfig.lib.json --emitDeclarationOnly --outDir /tmp/docker-decl
npx tsc -p packages/firecracker/tsconfig.lib.json --emitDeclarationOnly --outDir /tmp/fc-decl
npx tsc -p agents/doric/tsconfig.spec.json --noEmit
npx tsc -p app/doric-renderer/tsconfig.app.json --noEmit
npx tsc -p app/doric-renderer/tsconfig.spec.json
NX_SOCKET_DIR=/tmp/nx-tmp npx nx test doric-renderer
npx biome check <arquivos tocados> --formatter-enabled=false
npx biome format <arquivos tocados>
npx prettier --check <arquivos tocados>
```

O baseline de `npm run lint` no repositório já é vermelho por violações
anteriores em outros pacotes; isso não é responsabilidade desta feature.
