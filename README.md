# LSports — sportsbook independente

React + TypeScript, API Node.js e worker persistente para LSports TRADE, com interface em espanhol argentino preparada para iframe. **O bilhete é sempre uma simulação com pontos fictícios. Não aceita apostas, depósitos, pagamentos ou retiros.**

## Executar

Requisitos: Node.js 22.13+ (recomendado Node 24 LTS) e npm 10+.

```sh
npm ci
# Opcional no modo demo. Não sobrescrever um .env existente:
test -f .env || cp .env.example .env
npm run dev
```

Frontend: porta 5173, rota `/sportsbook`. API: porta 3001 em loopback. Worker: processo contínuo. Em terminais separados, use `npm run dev:web`, `npm run dev:api` e `npm run dev:worker`.

```sh
npm run build
npm test
# Frontend compilado (API e worker continuam em terminais separados):
npm run preview -w @lsports/web
```

O build gera `apps/web/dist` e verifica os tipos dos serviços Node, que são executados com `tsx`. No ambiente cloud com HOME somente leitura, acrescente `--cache /workspace/.npm-cache` a `npm ci`.

## Modos de dados

- `DATA_MODE=demo`: dados fictícios isolados em `packages/demo`, sem chamadas ao fornecedor; identificação explícita em toda a interface.
- `DATA_MODE=connected`: consumo de PreMatch 4511 e InPlay 4510 via AMQP no worker, recuperação por Snapshot usando SDK oficial, publicação local atômica para API e atualização da interface. Sem credenciais, conexão ou snapshot válido, mostra falhas/ausência e bloqueia cuotas; **nunca usa demo como fallback**.

[Configuração completa TRADE, variáveis do Mac, parâmetros confirmados, recuperação, cobertura de Hípica e limites](docs/TRADE.md). A conexão real aos pacotes depende das credenciais e ainda não foi validada neste ambiente. `.env` e `.runtime` são ignorados; nunca use variáveis `VITE_*` para segredos.

## Estrutura

- `apps/web`: filtros de esportes, Prepartido/En vivo/Hípica, mercados e bilhete simulado, polling a cada três segundos.
- `apps/api`: `GET /api/health` e `GET /api/events`, sem wallet ou endpoints de apostas.
- `apps/worker`: consumidores separados, snapshot e reconexão, encerramento SIGINT/SIGTERM.
- `packages/contracts`: tipos públicos.
- `packages/demo`: fonte fictícia separada.
- `packages/feed-store`: projeção local compartilhada worker/API; requer mesmo filesystem e um único worker escritor.

## Incorporar por iframe

```html
<iframe
  src="https://sportsbook.example.com/sportsbook"
  title="LSports — simulador deportivo"
  width="100%"
  height="900"
  style="border:0"
  sandbox="allow-scripts allow-same-origin"
  loading="lazy"
></iframe>
```

Não depende de cookies de terceiros, login nem armazenamento local. Altura fixa com scroll; sem ajuste automático via `postMessage`. Não coloque informação sensível na URL.

Em dev/preview, `FRAME_ANCESTORS` contém os orígenes exatos autorizados, separados por espaços; reinicie Vite após alterar. Exemplo de pai local: `http://localhost:8080`.

Em produção, servir `apps/web/dist` com fallback SPA para `/sportsbook`, fazer reverse proxy de `/api` para Node e configurar no servidor HTTP `Content-Security-Policy: frame-ancestors 'self' https://seu-site-pai.example`. A variável Vite não configura headers no hosting estático. Não enviar `X-Frame-Options: DENY`/`SAMEORIGIN` se o pai for outro origen. Usar HTTPS. API permanece interna no mesmo origen; sem CORS aberto. Fontes externas são opcionais com fallback de sistema.

Para produção, use supervisor com reinício para API/worker e monitore saúde/freshness. Processos não sobrevivem à publicação de um snapshot do ambiente. O frontend preserva a identidade visual atual; esta etapa não habilita operações com dinheiro real.
