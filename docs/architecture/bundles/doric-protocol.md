# Protocolo doric://

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

O app deixa de carregar o renderer por `file://` e passa a servir tudo por um esquema próprio e privilegiado, `doric`, numa **única origem**, `doric://app`. Shell, pacotes da plataforma e artefatos de bundles ficam na mesma origem, de modo que `'self'` na CSP cobre todos eles. O handler do protocolo, registrado no main, serve arquivos dos recursos do app ou do cache local e aplica a CSP empacotada ao shell. O Electron mantém o que já faz hoje.

## Problema atual

Hoje o renderer carrega `index.html` e `settings.html` por `file://`, e a CSP é aplicada só a essas duas URLs (`app/doric/src/main.ts`, `rendererUrls` e `contentSecurityPolicy`). Bundles baixados para o cache local não são `'self'` nessa origem.

## Origem única `doric://app`

O main passa a registrar o esquema privilegiado `doric` e a servir tudo por uma **única origem**, `doric://app`, para que `'self'` cubra shell, plataforma e bundles:

| Caminho                                    | Conteúdo                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `doric://app/<path>`                       | Shell técnico único de todas as janelas, servido para qualquer path de rota, como `/` ou `/settings` |
| `doric://app/platform/<pacote>@<versão>/…` | Pacotes compartilhados que vêm com o app                                                             |
| `doric://app/bundles/<id>@<versão>/…`      | Artefatos de bundles no cache local                                                                  |
| `doric://app/schemas/…`                    | JSON Schemas publicados pela plataforma, gerados do zod no build                                     |

O shell é o mesmo para todas as janelas; ele carrega o runtime client do loader, que vem de `packages/desktop-client` pelo build de `app/doric-renderer` (bundles não importam esse pacote). A janela carrega `doric://app/<path>`, e o path da URL escolhe o que ela mostra: o bootstrap descrito em [janelas abertas pelo core](./windows.md) põe um `<core-outlet>` no `body`, e o outlet mostra a rota que casa com `location.pathname` ([navegação e rotas](./navigation.md#o-outlet-core-outlet)). Os pacotes em `platform/` são os descritos em [pacotes compartilhados e tokens do tema](./platform-packages.md), e os artefatos em `bundles/` chegam ao cache pelo fluxo de [composição e distribuição pelo host](./composition-and-distribution.md). Os JSON Schemas em `schemas/` são o formato canônico serializável gerado das definições zod de [contratos](./contracts.md); nenhum bundle os escreve à mão.

## Handler do protocolo

Pseudocódigo da API proposta, no main:

```ts
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'doric',
    privileges: { standard: true, secure: true, codeCache: true },
  },
]);

app.whenReady().then(() => {
  protocol.handle('doric', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response(null, { status: 404 });

    // /platform/, /bundles/ e /schemas/ são arquivos; qualquer outro path é uma rota
    // e recebe a shell, como o fallback de um SPA.
    const file = isAssetPath(url.pathname)
      ? servedFiles.resolve(url.pathname)
      : servedFiles.shell();
    if (file === undefined) return new Response(null, { status: 404 });

    const headers: Record<string, string> = { 'content-type': file.mime };
    if (file.kind === 'shell') {
      headers['content-security-policy'] = contentSecurityPolicy(importMapHash);
    }
    return new Response(await readFile(file.path), { headers });
  });
});
```

`isAssetPath` reconhece os caminhos de arquivos, `/platform/`, `/bundles/` e `/schemas/`. `servedFiles.resolve` devolve esses arquivos dos recursos do app ou do cache local de bundles; um arquivo ausente dentro deles responde `404`. Qualquer outro path, como `/projects/p1/threads/t1`, recebe a shell, então recarregar a janela mantém a rota; o roteador do core decide no client o que esse path mostra. Qualquer host diferente de `app` responde `404`. A CSP é anexada como cabeçalho apenas à resposta do shell.

## CSP empacotada

A CSP empacotada mantém a política atual, acrescenta `worker-src 'self'` para os workers de Monaco e permite o import map inline pelo hash:

```text
default-src 'none'; script-src 'self' 'sha256-<hash do import map>'; worker-src 'self';
style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Bundles não acrescentam diretivas de CSP.

## IPC e pontes

O IPC passa a esperar mensagens do shell na origem `doric://app`, com qualquer path de rota, em vez das URLs `file://` atuais.

As pontes client → desktopMain e client → host descritas em [serviços e canais](./services-and-channels.md) passam por esse IPC:

- qualquer serviço fornecido no `desktopMain` ou no host é alcançável por uma parte client que o declara em `requires`, como `windows/v1` e `menus/v1` do core; as partes client do próprio core alcançam também o que o core fornece em outro ambiente (como `menus/v1.setContext`, chamado pelo roteador do core para informar o `path` da rota ativa), já que o core não declara em `requires` contratos que ele mesmo fornece;
- o dispatcher preenche `call.caller` (`{ bundleId, version, generation }`) com o bundle que faz a chamada e `call.scope.windowKey` com a janela de origem, identificada pelo `webContents`;
- `scope` (exceto `windowKey`), `signal` e `trace` vêm do `call` pai ou de `{ signal, deadline }` que o stub recebeu como último argumento.

## Desenvolvimento

Em desenvolvimento, o servidor do webpack continua servindo o shell com a CSP de desenvolvimento atual.

## Relações

- [Janelas abertas pelo core](./windows.md): toda janela carrega a mesma shell em `doric://app/<path>` e faz seu bootstrap a partir dela.
- [Pacotes compartilhados e tokens do tema](./platform-packages.md): define os pacotes servidos em `doric://app/platform/` e resolvidos pelo import map cujo hash entra na CSP.
- [Composição e distribuição pelo host](./composition-and-distribution.md): baixa para o cache local, com hash conferido para garantir a integridade do cache, os artefatos que o handler serve em `doric://app/bundles/`.
- [Contratos e a família define\*](./contracts.md): gera do zod os JSON Schemas publicados em `doric://app/schemas/`.
- [Serviços e canais](./services-and-channels.md): as pontes client → desktopMain e client → host que passam por este IPC e preenchem `call.caller` e `call.scope.windowKey`.
- [Navegação e rotas](./navigation.md): o roteador do core muda `location.pathname` com a History API, e o handler responde a shell para qualquer path de rota.
- [Splash e recuperação](./splash-and-recovery.md): mostra o carregamento enquanto os artefatos são baixados.
