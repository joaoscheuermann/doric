# Port forwarding: alcançar as portas do sandbox

**Estado:** proposta. Nada aqui descreve comportamento já implementado; `GROUNDING.md` continua sendo o contrato da implementação atual. Os caminhos citados como evidência existem hoje no repositório.

## Resumo

A funcionalidade alcança, de fora do sandbox, uma porta TCP que um processo do Project escuta dentro dele — um `npm run dev`, um servidor de API, um `docker run` da imagem que o Project descreve. A porta é servida na **própria origem que o host já expõe**, em `/ports/<token>/`, com WebSocket transparente, e o leitor abre essa URL numa janela do desktop do sandbox, ou copia a mesma URL para fora dele.

O precedente direto é o par `screen`/`screen-relay`, que já serve o cliente HTML5 do xpra do Project em `/screen/<token>/`. Port forwarding é a generalização desse caminho para qualquer porta, com um plano de controle que descobre, lista e expõe as portas de cada Project.

O que a funcionalidade **não** é:

- não publica portas do Docker (`-p`) nem muda a política de rede do sandbox: egress, SSH e DNS continuam como `SandboxNetworkPolicy` os define;
- não amplia a saída do sandbox nem a autoridade do host sobre a rede;
- não substitui o SSH, que continua o canal de inspeção de um operador (`DORIC_SANDBOX_SSH`).

## O que existe hoje (evidência)

O host já alcança uma porta que o sandbox escuta, e já a serve na sua origem, mas só para a tela:

- `bundles/features/screen/src/host/session.ts:271-288`: `hostOf` executa `hostname -I` no sandbox, escolhe o primeiro IPv4 roteável (`screenHost`, linhas 152-160, que descarta `127.*`) e o relay dialoga com `<endereço>:<porta>` — as portas do xpra saem de `SCREEN_PORT_CANDIDATES = [14500, 14501, 14502]` (linha 31) e o xpra é iniciado com `--bind-tcp=0.0.0.0:<porta>` (linha 139).
- `bundles/features/screen-relay/src/host/relay.ts:1-15`: o relay monta o token tree no router compartilhado e no `http.Server` do host, e o comentário registra a razão de ele não abrir um listener próprio: uma URL de loopback que só a máquina do host responde quebra o produto quando o host roda num servidor remoto e o app roda num laptop.
- `bundles/features/screen-relay/src/host/relay.ts:82`: o prefixo servido é `/screen/`; `screenPath` (linha 140) reserva esse prefixo e responde `404` a um token desconhecido, sem cair nas outras rotas.
- `bundles/features/screen-relay/src/host/relay.ts:17-20` e `263`: o upgrade é encaminhado de forma transparente, com o `Sec-WebSocket-Key` e os cabeçalhos do próprio browser, e os bytes crus são canalizados nos dois sentidos.
- `docs/architecture/bundles/feature-split.md:57`: o `screen-relay` existe porque `doric.network/v1.register` é local ao processo: o bundle que serve um protocolo nos listeners nativos roda residente, enquanto as sessões que precisam do sandbox rodam na geração, onde `runtime.lease/v1.withLease` entrega o sandbox.
- `packages/bundle/src/contracts/network.ts:17-33`: `NetworkResources` entrega `http`, `server` (para o listener de `upgrade`) e `sockets`; o kernel é dono do endereço, do bind e do close.

- O provider Docker só publica a porta 22, e só quando o SSH está habilitado: `packages/docker-sandbox/src/lib/provider.ts:331` usa `NetworkMode: 'none' | 'bridge'`, `:343-351` monta `PortBindings` apenas para `22/tcp` (com `HostPort: ''`, porta efêmera escolhida pelo daemon), e `packages/docker-sandbox/src/lib/host.ts:352-358` lê o bind de volta do inspect e faz `net.createConnection` nele — prova de que o host dialoga IP:porta. O firewall do Docker (`host.ts:422-456`) só governa egress; nada filtra host → container.
- O provider Firecracker dá ao sandbox um `/30` privado e regras nftables próprias (`packages/firecracker-sandbox/src/lib/network.ts:33-68`), com o host mantendo um endereço no TAP (`:55-59`); o preflight exige `ip_forward` e `CAP_NET_ADMIN` (`packages/firecracker-sandbox/src/lib/preflight.ts:140-145`). As regras filtram só `iifname "<tap>"` (tráfego originado no guest), então a conexão host → guest não é filtrada por elas.
- O único encaminhamento host → porta do sandbox que existe é o SSH: `exposeUserSsh` (`packages/firecracker-sandbox/src/lib/ssh.ts:199-261`) abre um listener `net.Server` no host e canaliza cada conexão para `guest:22` — o mesmo formato que um encaminhamento de porta precisaria. Ele é provider-owned, preso à porta 22 e só existe com `DORIC_SANDBOX_SSH`.
- No Docker Desktop (darwin/win32), o IP da bridge do container **não** é alcançável do host, e o caminho portável é a publicação de porta (`packages/docker-sandbox/README.md:44-46`, `host.ts:217-229`). Qualquer desenho que só dialoga o IP do container vale no Linux e não vale ali.
- A janela de uma funcionalidade **só** carrega um path sob a origem do host: `path: z.string().startsWith('/')` (`packages/bundle/src/contracts/basic/windows.ts:56-64`), resolvido com `new URL(path, hostUrl)` (`app/desktop/doric/src/platform/windows/view.ts:13-14`), com a navegação presa à origem da própria janela e `windowOpen` sempre negado (`app/desktop/doric/src/platform/windows/navigation-guard.ts:31-40`). A CSP empacotada (`default-src 'none'`, `connect-src 'none'`, nenhum `frame-src`, `app/desktop/doric/src/platform/protocol/csp.ts:9-30`) vale para as páginas do esquema `doric://` (`app/desktop/doric/src/platform/protocol/handler.ts:210-216`); a página que o host serve dentro da janela de view não recebe essa CSP (`app/desktop/doric/src/platform/windows/native-windows.ts:507-517`), e é a guarda de navegação que a mantém na origem.

O que **não** existe hoje:

- Nenhum contrato ou método expõe uma porta arbitrária: `Sandbox` e `SandboxRuntime` (`packages/sandbox/src/lib/types/sandbox.ts`) têm `exec`, `start`, `stats`, `readFile`, `putFile`, `getFile`, `diff`, `cloneRepo` e `ssh`, e nenhum equivalente a `openPort`/`forwardPort`. Não há alocador de porta no host: a única porta publicada é a efêmera do SSH, escolhida pelo daemon.
- Não há descoberta de portas escutando: nada lê `/proc/net/tcp` nem roda `ss` no sandbox. `ss` e `netstat` não constam entre os pacotes que a imagem de sandbox instala (`app/backend/doric-host/.sandbox.Dockerfile:75-120`).
- Não há como uma janela ou um bundle abrir uma URL externa: não existe `shell.openExternal` no código, nenhuma superfície carrega origem fora da origem do host (a navegação da janela de view é presa a ela) e a CSP do esquema `doric://` não permite frames nem conexões a outra origem.
- Também não há túnel SSH como atalho: o Dropbear do guest roda com o encaminhamento desabilitado (`-g -j -k`) nos dois providers (`packages/docker-sandbox/src/lib/host.ts:336-344`; `app/backend/doric-host/firecracker/guest-start:22-25`), então `ssh -L`/`-R` não é mecanismo disponível hoje — o encaminhamento tem de ser feito pelo host.

## Decisões de arquitetura

- **D-1 — A porta é servida na origem do host, em `/ports/<token>/`.** É a mesma escolha do relay das telas e vale para os dois tipos de implantação (host local e host remoto). Um listener em `127.0.0.1` fica como opção explícita (D-7), não como padrão.
- **D-2 — Dois bundles, como nas telas: `ports` na geração e `ports-relay` residente.** `doric.network/v1.register` é local ao processo (`docs/architecture/bundles/feature-split.md:57`), e o `withLease` que entrega o sandbox só existe na geração. O `ports` publica o upstream de cada sessão por `ports.relay/v1`; o `ports-relay` responde o token tree.
- **D-3 — O `token` é a capacidade.** Como nas telas, a superfície HTTP do host é não autenticada por desenho; quem alcança a origem e tem o token alcança a porta. O limite operacional (túnel, proxy reverso, VPN) continua sendo o controle de quem opera o host.
- **D-4 — O relay só dialoga o endereço do sandbox do Project.** O upstream é gravado por sessão a partir do endereço lido do próprio sandbox, e o relay recusa expor um alvo de host arbitrário. Isso impede que o proxy vire uma porta de saída para a rede interna do host (SSRF).
- **D-5 — Descoberta por `/proc/net/tcp` e `/proc/net/tcp6`.** Ler os dois arquivos por `exec` e filtrar sockets em `LISTEN` (estado `0A`) não depende de pacote nenhum na imagem, ao contrário de `ss`/`netstat`. A porta continua sendo escolhida pelo leitor ou pelo modelo: a descoberta só alimenta a lista e a UI.
- **D-6 — Fidelidade de caminho declarada.** O caminho prefixado não é transparente para aplicações que usam caminhos absolutos. O relay injeta `<base href="/ports/<token>/">` em respostas HTML que não declarem um `<base>`, reescreve `Location` para o prefixo do token e reescreve o `Path` de `Set-Cookie`. O que isso não cobrir é limitação documentada e conhecida, preferível a um listener de loopback que não funciona com host remoto.
- **D-7 — Listener local opcional, fora do padrão.** `DORIC_PORT_FORWARD_BIND=127.0.0.1` pode abrir uma porta local por sessão, para quem roda host e app na mesma máquina e precisa da fidelidade total de caminho. Não é o padrão e exige uma decisão explícita do operador, porque reintroduz a quebra do host remoto.
- **D-8 — Uma sessão por par (Project, porta).** O sandbox é do Project e compartilhado pelas Threads; duas leituras da mesma porta são duas janelas sobre a mesma sessão, como duas telas do mesmo Project são duas janelas sobre uma sessão só.
- **D-9 — Quem resolve a alcançabilidade é o provider, não o bundle.** A forma de alcançar uma porta do sandbox varia por provider e por plataforma (IP do container no Docker do Linux, porta publicada no Docker Desktop, o `/30` do Firecracker com `exposeUserSsh` como precedente de listener no host). O bundle de portas pede um alvo já resolvido, ao lado de `stats?()` ou de um helper público de `packages/sandbox`, e nunca deriva isso de `hostname -I`. Assim um provider novo escolhe o seu caminho sem mudar o bundle.

## Componentes

| Camada                     | Onde                                        | O que faz                                                                                                                                                           |
| -------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alcançabilidade do sandbox | `packages/sandbox`                          | Resolve por onde o host alcança uma porta do sandbox, em vez de cada funcionalidade reparsar `hostname -I` (`bundles/features/screen/src/host/session.ts:271-288`). |
| Sessões                    | `bundles/features/ports` (host)             | Descobre portas escutando no sandbox do Project, mantém uma sessão por par (Project, porta) na lease, e publica o upstream no relay.                                |
| Contratos                  | `bundles/features/ports/contracts`          | `ports.sessions/v1` e `ports.views/v1`; `ports.relay/v1` fica no bundle residente.                                                                                  |
| Relay                      | `bundles/features/ports-relay` (residente)  | Serve `/ports/<token>/` no router e no `http.Server` do host, com upgrade transparente.                                                                             |
| Tool                       | `bundles/features/ports` (host)             | `ports.forward_port`, para o agente expor uma porta e devolver a URL ao leitor.                                                                                     |
| UI                         | `bundles/features/ports` (client e desktop) | Grupo na sidebar, janela própria por sessão e a ação de copiar a URL.                                                                                               |
| Configuração               | `bundles/features/ports` (host e client)    | `ports.settings/v1` no host, com portas proibidas e faixa permitida; seção e rota pela `settings.sections`/`navigation`, como o `git`.                              |
| Composição                 | `app/backend/doric-host/composition.json`   | `ports` em `enabled`, `ports-relay` em `enabled` e `resident`.                                                                                                      |

### Alcançabilidade da porta (`packages/sandbox`)

“Como o host alcança a porta” é um detalhe do provider, não de cada funcionalidade, e hoje varia assim:

| Provider        | Caminho                                                                                                                                                 | Evidência                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker no Linux | o host dialoga o IP da bridge do container                                                                                                              | `screen` faz exatamente isso (`bundles/features/screen/src/host/session.ts:271-288`); nada do firewall Docker filtra host → container (`packages/docker-sandbox/src/lib/host.ts:422-456`) |
| Docker Desktop  | o IP da bridge não é alcançável; é preciso publicar a porta no host                                                                                     | `packages/docker-sandbox/README.md:44-46`, `host.ts:217-229`                                                                                                                              |
| Firecracker     | o host mantém um endereço no TAP do `/30` (`packages/firecracker-sandbox/src/lib/network.ts:55-59`) e as regras só filtram o tráfego originado no guest | `network.ts:130-170`; o precedente de listener no host é `exposeUserSsh` (`packages/firecracker-sandbox/src/lib/ssh.ts:199-261`)                                                          |

Desenho proposto: um método no boundary do sandbox que responde o alvo já resolvido — por exemplo `reach(port): Promise<{ host: string; port: number } | undefined>`, ao lado de `stats?()` em `SandboxRuntime` e em `Sandbox` (`packages/sandbox/src/lib/types/sandbox.ts:77-95, 161-187`). O provider que não souber responder deixa ausente, como faz com medição, e no Docker Desktop pode resolver publicando a porta antes de responder — mas publicação adicionada depois da criação não é vista pelo caminho de reúso, que compara `exposedPorts`, `networkMode` e `portBindings` do container existente (`packages/docker-sandbox/src/lib/reuse.ts:39-52`), então esse provider precisa decidir se a publicação entra no `create` desde o início (`packages/docker-sandbox/src/lib/mapping.ts:30-36`) ou se o reúso passa a considerá-la.

Alternativa menor, se a interface do sandbox não deve crescer: extrair o `hostOf`/`screenHost` de `bundles/features/screen/src/host/session.ts` para um helper público de `packages/sandbox`, sem tocar na interface. Ela resolve Linux e Firecracker e deixa o Docker Desktop sem resposta, então é a opção que ficaria devendo.

A escolha fica aberta, mas o ponto de D-9 permanece: o bundle de portas não deve adivinhar o caminho.

### `ports` (host, geração)

- `list({ projectId })` responde as portas escutando no sandbox do Project, com o estado da lease (`pending`, `unavailable`, `ready`) mapeado como as telas fazem em `bundles/features/screen/src/host/provider.ts:58-80`, sem falhar a chamada quando só falta sandbox.
- `list`, `forward` e `forget` levam `expose: 'desktop'` (`packages/bundle/src/contracts/expose.ts:4-5`), porque é a janela que os chama pela ponte, como `screen.sessions/v2` faz (`bundles/features/screen/src/host/provider.ts:152`).
- `forward({ projectId, port, label? })` resolve a lease pelo `runtime.lease/v1.withLease` (que nunca adquire, como `bundles/features/resources/src/host/index.ts:26-32`), pede ao sandbox o alvo resolvido para aquela porta (D-9), confirma que ela escuta e publica o upstream no relay, respondendo o path `/ports/<token>/`.
- `forget({ token })` e `dispose()` esquecem os tokens desta geração no relay, no mesmo desenho de `screen.sessions/v2.attach`/`dispose` em `bundles/features/screen/src/host/provider.ts`.
- A sessão guarda o que a janela precisa: token, porta do sandbox, rótulo, protocolo e o estado. O protocolo é HTTP com upgrade de WebSocket, que é o que o seam `doric.network/v1` oferece (`NetworkResources.http` e o listener de `upgrade`, `packages/bundle/src/contracts/network.ts:17-33`); TCP cru exigiria um seam novo na plataforma, e fica fora desta proposta.

### `ports-relay` (residente)

Espelha `bundles/features/screen-relay` linha a linha, com as diferenças que a generalidade exige:

- prefixo `/ports/`, com `portsPath` reservando o prefixo e respondendo `404` a token desconhecido, sem cair nas outras rotas do router (`relay.ts:114-140`);
- filtros hop-by-hop iguais (`relay.ts:85-95`) e upgrade transparente (`relay.ts:263`);
- injeção de `<base>` e reescrita de `Location` e `Set-Cookie` (D-6), que o relay de telas não precisa porque o cliente xpra já serve seus assets por caminhos relativos;
- montagem e desmontagem por `doric.network/v1.register`, com o cleanup devolvido na desativação (`bundles/features/screen-relay/src/host/index.ts:11-25`).

### UI

A UI se divide como a das telas: a parte **client** é a única que tem ponte com o host e faz as chamadas de `ports.sessions/v1`; a parte **desktopMain** não chama contrato de host algum, e é ela que possui a janela.

- Um grupo na sidebar, por um pane de `layout.stack/v1` (`stack.register({ id: 'ports-sidebar', tag: PORTS_SIDEBAR_TAG, order: …, title: 'Ports', minSize: … })`, como `bundles/features/screen/src/client/index.ts:35-45`), abaixo da árvore de Threads — o mesmo stack, e portanto o mesmo desenho de painéis, em que as telas registram o seu (`GROUNDING.md:498-500`) —, com uma linha por sessão e o estado dela, alimentado pelo mesmo desenho de dial das telas (`bundles/features/screen/src/client/index.ts:56-91`).
- Cada linha abre (ou foca) uma janela própria, por `doric.windows/v1`, com o path `/ports/<token>/`, partição própria e barra de título nativa, sem preload — o pedido exato que o `screen` monta em `bundles/features/screen/src/desktop/windows.ts:14-46`.
- A janela carrega o path sob a origem do host e nada mais; a ação "copiar URL" monta a mesma URL a partir de `DORIC_HOST_URL`/origem conhecida. "Abrir no browser da máquina" **não** é possível hoje: não existe `shell.openExternal`, nenhuma superfície carrega origem fora da origem do host — a janela de view está presa a ela — e a CSP do esquema `doric://` não permite frames nem conexões a outra origem. Fica como pedido explícito de nova superfície da plataforma, listado nas decisões abertas.
- A janela é reaberta e re-apontada quando a sessão muda de token, como o heal loop das telas faz com `focus`/`navigate`.
- A seção de settings usa as costuras que o `git` já usa: um item em `settings.sections` e uma rota registrada em `navigation.register({ path, parent: '/settings', create })` (`bundles/features/git/src/client/index.ts:61-90`). O `settings.config/v1` que aparece nesse caminho é o rascunho único de autosave da janela de settings, provido pelo bundle `settings` (`bundles/desktop/settings/src/client/services/settings-config.ts:36`), não um espaço por funcionalidade — é por isso que a política de portas precisa de um espaço de configuração próprio no host.

### Tool

`ports.forward_port`, registrada em `tools/v1` como as demais (`bundles/features/resources/manifest.json` mostra o formato mínimo de manifesto), recebe `{ port, label? }` e devolve o path servido. Assim o modelo pode expor o servidor que ele mesmo subiu e entregar a URL na conversa, sem que o leitor precise descobrir a porta.

## Contratos (esboço)

No formato dos contratos existentes, com `defineService` e `defineMethod` de `bundle/contracts`:

```ts
// ports, host/sessions.ts
export const portsSessions = defineService('ports.sessions/v1', {
  list: defineMethod({
    input: z.object({ projectId: z.string() }).strict(),
    output: portListSchema,
    execute: async ({ projectId }, call, services) => /* lease + /proc/net/tcp */,
  }),
  forward: defineMethod({
    input: z
      .object({
        projectId: z.string(),
        port: z.number().int().positive().max(65_535),
        label: z.string().min(1).optional(),
      })
      .strict(),
    output: forwardedPortSchema,
    execute: async (input, call, services) => /* lease + expose + path */,
  }),
  forget: defineMethod({
    input: z.object({ token: z.string().min(1) }).strict(),
    output: z.void(),
    execute: async ({ token }) => /* relay.forget + sessão */,
  }),
});

// ports-relay, host/service.ts
export const portsRelayMethods = {
  expose: { input: portsRelayExposeSchema, output: z.void() },
  forget: { input: portsRelayForgetSchema, output: z.void() },
} as const;
```

`portsRelayExposeSchema` repete `screenRelayExposeSchema` (`bundles/features/screen-relay/src/contracts/index.ts:26-32`, sobre `screenRelayTargetSchema`, `:16-21`) com a porta do sandbox obrigatoriamente dentro do sandbox do Project que está expondo; `forget` repete `screenRelayForgetSchema` (`:37-39`).

Sobre o nome: `ports` não colide com `bundles/runtime/runtime/src/host/ports.ts`, que é `RuntimePorts` — a camada hexagonal do domínio (`configuration`, `sandbox`, `executor`…), sem relação com portas TCP. Ainda assim, vale fixar na implementação que um é "porta do host" e o outro é "porta do domínio", para o vocabulário não se confundir.

O manifesto do `ports` segue `bundles/features/screen/manifest.json`:

```json
{
  "manifestVersion": 1,
  "id": "ports",
  "version": "1.0.0",
  "engines": { "doric": "^1.0.0" },
  "description": "Forwarded ports of a Project's sandbox.",
  "provides": ["ports.sessions/v1@1.0.0", "ports.views/v1@1.0.0"],
  "requires": [
    "log/v1@^1.0.0",
    "tools/v1@^1.2.0",
    "settings/v1@^1.0.0",
    "runtime.lease/v1@^1.1.0",
    "ui/v1@^1.0.0",
    "regions/v1@^1.0.0",
    "navigation/v1@^1.0.0",
    "layout.stack/v1@^1.0.0",
    "ports.relay/v1@^1.0.0"
  ],
  "desktopScope": {
    "ports.sessions/v1": ["projectId", "threadId", "promptId"]
  }
}
```

O `ports-relay` declara só `ports.relay/v1` em `provides`, como `screen-relay`.

## Fluxos

1. **Expor.** O leitor pede numa linha da UI, ou o modelo chama `ports.forward_port`. A chamada chega ao host do `ports`, que resolve a lease do Project, pede ao sandbox o alvo resolvido (D-9), confirma que a porta escuta (`connect` com prazo curto, como `portOpen` em `screen`), gera o token e publica o upstream por `ports.relay/v1.expose`.
2. **Abrir.** O desktop abre a janela em `/ports/<token>/` no path da origem do host; o relay responde encaminhando ao `host:port` do sandbox.
3. **WebSocket.** O upgrade é terminado nos dois lados com o handshake do browser e os bytes crus passam; nada de frame é interpretado.
4. **Reiniciar.** Um host reiniciado perde os tokens, como perde os das telas. O desktop re-anexa as sessões que conhece e re-aponta a janela para o novo path, em vez de perder o que estava aberto.
5. **Encerrar.** Terminar a Thread não fecha a sessão (o sandbox é do Project); terminar o Project, liberar a lease ou desativar o bundle esquece os tokens e derruba as conexões abertas (`dispose`), como o relay das telas faz hoje.

## Segurança e limites

- O token é a única credencial, como nas telas; a origem do host continua não autenticada por desenho.
- O relay recusa qualquer upstream que não seja o endereço do sandbox do próprio Project (D-4), e o `expose` valida a forma do alvo.
- Nada muda em `SandboxNetworkPolicy`: a funcionalidade só serve o que já está escutando dentro do sandbox, e não dá a ele nenhuma saída nova. Está de acordo com HC-007: nenhum limite de rede, sandbox ou sessão é enfraquecido.
- Os corpos encaminhados não entram em log operacional; o log registra token, porta e estado, não o payload.

## Arquivos a criar ou alterar

| Arquivo                                                      | Mudança                                                                                                                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundles/features/ports/**`                                  | Bundle novo: `manifest.json`, `contracts/`, `host/`, `client/`, `desktop/`, `tests/`, `project.json`, `package.json`, `tsconfig*.json`, seguindo `bundles/features/screen`. |
| `bundles/features/ports-relay/**`                            | Bundle novo residente: espelho de `bundles/features/screen-relay`, com o prefixo `/ports/` e as reescritas de D-6.                                                          |
| `app/backend/doric-host/composition.json`                    | `"ports"` e `"ports-relay"` em `enabled`; `"ports-relay"` em `resident`.                                                                                                    |
| `app/backend/doric-host/project.json`                        | `bundle-ports` e `bundle-ports-relay` no `build-bundles` (lista de staging e `dependsOn`), como `bundle-screen` e `bundle-screen-relay`.                                    |
| `tsconfig.json` e `package.json` da raiz                     | `paths`/referências do workspace e a entrada em npm workspaces (`npx nx sync`, `npm install`).                                                                              |
| `packages/sandbox`                                           | Alcançabilidade do sandbox (D-9), pela interface (`reach(port)`) ou pelo helper público.                                                                                    |
| `app/backend/doric-host/tests/bridge-exposure.snapshot.json` | O snapshot congelado do que uma janela pode chamar precisa ganhar `ports.sessions/v1` (e `ports.views/v1`, se o desktop a consumir), por `bridge-exposure.test.ts`.         |
| `docs/architecture/bundles.md`                               | Link para este documento no mapa.                                                                                                                                           |
| `GROUNDING.md`                                               | Só na implementação (ver abaixo).                                                                                                                                           |

## Testes

- `ports-relay`: resolução de token e path, prefixo reservado com `404`, hop-by-hop, injeção de `<base>`, reescrita de `Location` e `Set-Cookie`, upgrade transparente, `mount`/desmontagem com pass-through — o mesmo formato de `bundles/features/screen-relay/tests/{relay,host}.test.ts`, que já sobe um upstream HTTP com listener de `upgrade`, monta num router e `http.Server` compartilhados e verifica `GET /screen/t1/hello?q=1` pela porta efêmera do host.
- `ports`: parser de `/proc/net/tcp` (`LISTEN` incluído, IPv6, portas em hexadecimal), manager de sessão com `portOpen` injetável (como `ScreenSessionsOptions` faz em `bundles/features/screen/src/host/session.ts:162-170`), idempotência por (Project, porta), mapeamento de estado da lease, escopo da lease (`assert.deepEqual(lease.scopes, ['p-1'])` é o modelo de `bundles/features/resources/tests/resources.test.ts:164`) e `forget` no dispose. `bundles/features/screen/tests/provider.test.ts:96` fixa o caso que importa aqui: lease formando responde `pending` e não abre handle no relay.
- Cliente: store da lista, estado das linhas, decisão de abrir/focar/re-apontar a janela e o pedido de janela em si (`bundles/features/screen/tests/views.test.ts:259, 306-317` e o `applyWindowAction` de `bundles/features/screen/src/desktop/windows.ts:50-90` são os modelos).
- Integração: em `app/backend/doric-host-e2e`, provisionar um Project, subir um servidor HTTP dentro do sandbox e buscar a resposta pela origem do host, incluindo um upgrade de WebSocket.
- Formatação e lint: `npx biome format --write <arquivos>`, `npm run format:check` e `npm run lint`, como o `AGENTS.md` exige.

## Entrega em etapas

1. **Relay e contrato.** `ports-relay` servindo um upstream publicado à mão, provado por teste de integração pela origem do host.
2. **Sessões.** `ports.sessions/v1` sobre `runtime.lease/v1.withLease`, com descoberta por `/proc/net/tcp`.
3. **UI.** Grupo na sidebar, janela própria e a ação de copiar a URL.
4. **Tool e configuração.** `ports.forward_port` e `ports.settings/v1` — o espaço de configuração vive no host, como `host-config.configuration/v1` (`bundles/foundation/host-config/src/host/configuration.ts:34, 73-77, 190-191`), porque a configuração é única, sem variante por Project, e hoje nenhum bundle de funcionalidade tem espaço de configuração próprio: o `git` já registra seção e rota de settings, mas guarda o texto no rascunho autosave único da janela (`settings.config/v1`), não num espaço seu — e `defineSettings` só aparece em código de produção no próprio `host-config` (`bundles/foundation/host-config/src/host/configuration.ts:74`), com zero ocorrências em `bundles/features/**`.
5. **Paridade e opções.** Firecracker exercitado no mesmo teste, e as decisões sobre o listener local (D-7) e a alcançabilidade (D-9).

## Decisões abertas (portões humanos)

- Nome do bundle: `ports` (o mais próximo dos nomes mínimos de `docs/architecture/bundles/feature-split.md`) ou algo como `forwarding`.
- Se o listener local opcional entra em escopo ou fica fora até haver um pedido concreto.
- Se o modelo ganha a tool, e se cabe autoforward (expor toda porta nova detectada) ou só o pedido explícito.
- Se a lista de sessões é só de processo (como os tokens das telas) ou vira documento durável por Project.
- Se o relay das telas e o de portas convergem num relay genérico com dois prefixos, o que hoje significaria mexer no `screen-relay` existente.
- Se a plataforma ganha uma forma de abrir uma URL no browser do sistema (hoje não existe `shell.openExternal`, a navegação é presa à origem e a CSP não permite frames nem outra origem), o que é o que permitiria "abrir no browser da máquina".
- Se a alcançabilidade vira um método do boundary do sandbox (`reach(port)`) ou um helper público de `packages/sandbox` (D-9), e se o Docker Desktop entra na primeira fatia.
- Se a política de portas é um espaço global de settings (o caminho com precedente) ou uma lista por Project, que hoje não tem onde morar: a configuração é única, o `configSnapshot` do Project é explicitamente "nunca lido na execução" (`bundles/runtime/runtime/src/contracts/storage.ts:20-30`) e `SandboxNetworkPolicy.allowPrivate[].ports` são regras de saída, não bindings do host.
- Se TCP cru entra em escopo: hoje o seam `doric.network/v1` oferece HTTP e `upgrade`, não sockets crus, e servir um protocolo não-HTTP exigiria superfície nova.

## O que muda no `GROUNDING.md` quando for implementado

O `AGENTS.md` pede atualizar o contrato quando a tarefa muda comportamento de produto. Na implementação, e não nesta proposta, entram lá: os bundles `ports` e `ports-relay` em `alternatives`/composição, os contratos `ports.sessions/v1`, `ports.views/v1` e `ports.relay/v1`, o prefixo `/ports/<token>/` na origem do host, a alcançabilidade do sandbox em `packages/sandbox`, a tool e a seção de settings. Nada disso vale enquanto esta proposta não virar entrega verificável.

## Relações

- [Arquitetura de bundles](../bundles.md): situa os dois bundles novos no desenho de destino.
- [Divisão das funcionalidades atuais](./feature-split.md): o `screen-relay` residente e a razão de existir (`:55-57`), o padrão que o `ports-relay` repete.
- [Serviços entre bundles e canais de mensagens](./services-and-channels.md): `defineService`, `defineMethod`, `ref`, o `provide`/`use` e as pontes que a UI do `ports` usa.
- [Protocolo doric://](./doric-protocol.md): a origem do app e a CSP que impedem a janela de bundle de carregar uma origem arbitrária — por isso a porta é servida na origem do host.
- [Janelas abertas pelo core](./windows.md): `windows/v1`, as chaves de janela e o path que a janela carrega.
- [Isolamento por processo](./process-isolation.md): o kernel e os bundles residentes, o que explica por que o relay não pode viver na geração.
