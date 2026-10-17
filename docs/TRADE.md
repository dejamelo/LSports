# LSports TRADE — integração Test

## Estado da validação

O código implementa os caminhos conectados, mas **a conexão aos pacotes 4511/4510 ainda não foi validada com credenciais reais**. Não havia `.env` nem variáveis `LSPORTS_*` neste ambiente. Nunca envie senhas pelo chat. Preencha o `.env` apenas no seu Mac ou no gerenciador de segredos do servidor.

O portal `https://docs.lsports.eu/lsports` retornou HTTP 403 pelo proxy do ambiente durante a implementação. Foram usados o repositório **oficial** `https://github.com/lsportsltd/trade360-nodejs-sdk` (inspeção do commit `ece873dfc9040e431662bc27e7c2bf8cbd519811`) e o pacote oficial npm **`trade360-nodejs-sdk@3.10.10`**, fixado no lockfile. A versão 3.10.11 do código consultado ainda não estava publicada; o nome `trade360-sdk` no README upstream retorna 404 no npm. O SDK instalado foi importado e exercitado nos testes.

## Parâmetros e fontes

| Parâmetro             | PreMatch                    | InPlay                      | Origem                                                      |
| --------------------- | --------------------------- | --------------------------- | ----------------------------------------------------------- |
| Package ID            | 4511                        | 4510                        | Fornecidos pelo usuário                                     |
| Host                  | stm-prematch.lsports.eu     | stm-inplay.lsports.eu       | Usuário + exemplo oficial                                   |
| Vhost                 | StmPreMatch                 | StmInPlay                   | `sample/feed-sample/src/config/app-config.json`             |
| Fila padrão           | _4511_                      | _4510_                      | `src/feed/utilities/consume-queue-name.ts`: `_{packageId}_` |
| Transporte do exemplo | AMQP, porta 5672, TLS false | AMQP, porta 5672, TLS false | Exemplo oficial; confirmar listener do pacote               |
| Recuperação           | POST /Prematch/GetEvents    | POST /Inplay/GetEvents      | Enums e serviços Snapshot do SDK                            |

Snapshot usa `https://stm-snapshot.lsports.eu`, fornecido pelo usuário. Customers/Distribution/Metadata usa `https://stm-api.lsports.eu`, presente no exemplo oficial. `Test` é um identificador local: **não inventa query string, prefixo, host alternativo ou parâmetro de autenticação**. A habilitação Test depende das credenciais e pacotes do fornecedor. Confirme com LSports se suas filas Test usam os vhosts/listeners padrão ou filas customizadas.

O SDK confirma username/password/packageId nas requisições HTTP POST. O adaptador usa `SnapshotApiFactory`, `CustomersApiFactory`, DTOs `GetEventRequestDto` e `GetInPlayEventRequestDto`, parser seguro de IDs grandes e entidades oficiais de mensagens. A serialização/autenticação HTTP é feita pelo SDK. O transporte AMQP usa `amqplib`, como o SDK, mas controla o ciclo de reconexão e acknowledgements na aplicação para coordenar a recuperação por snapshot. Não usa o `DistributionUtil` estático compartilhado entre pacotes.

`LSPORTS_MQ_TLS=false` e `5672` reproduzem o exemplo upstream e enviam credenciais AMQP sem criptografia de transporte. Para operar por rede não confiável, solicite ao fornecedor listener AMQPS e porta certificados; configure `LSPORTS_MQ_TLS=true` e a porta confirmada (normalmente 5671). Não se afirma que esse listener esteja habilitado no seu pacote. A verificação de certificados permanece habilitada; não há fallback automático entre TLS e plain AMQP.

## Configuração no Mac

```sh
git switch feat/sportsbook-demo
git pull --ff-only origin feat/sportsbook-demo
npm ci
# Somente se ainda não existir .env:
test -f .env || cp .env.example .env
chmod 600 .env
```

Edite `.env` localmente, sem enviar seus valores a terceiros:

```dotenv
DATA_MODE=connected
LSPORTS_ENVIRONMENT=Test
LSPORTS_PREMATCH_PACKAGE_ID=4511
LSPORTS_INPLAY_PACKAGE_ID=4510
LSPORTS_PREMATCH_HOST=stm-prematch.lsports.eu
LSPORTS_INPLAY_HOST=stm-inplay.lsports.eu
LSPORTS_SNAPSHOT_URL=https://stm-snapshot.lsports.eu
LSPORTS_CUSTOMERS_URL=https://stm-api.lsports.eu
```

Preencha também **`LSPORTS_PREMATCH_USERNAME`**, **`LSPORTS_PREMATCH_PASSWORD`**, **`LSPORTS_INPLAY_USERNAME`** e **`LSPORTS_INPLAY_PASSWORD`** com os dados dos respectivos pacotes. Se o fornecedor tiver dado um único par para ambos, use esse par nos dois grupos somente após confirmar essa atribuição. Nunca preencha `VITE_*` com segredos. Em valores contendo `#`, espaços ou `$`, use aspas simples no `.env`; o carregador Node lê o arquivo sem executá-lo como shell. Não use `source .env`.

Mantenha os defaults de `.env.example` para arquivos e intervalos; ajuste `LSPORTS_MQ_TLS` e `LSPORTS_MQ_PORT` conforme o listener confirmado. As variáveis `LSPORTS_PREMATCH_QUEUE`/`LSPORTS_INPLAY_QUEUE` só são necessárias para filas personalizadas. Os vhosts são os padrões verificados acima.

```sh
npm run build
npm test
npm run dev
```

Abra `http://localhost:5173/sportsbook` no navegador do Mac. Para terminais separados: `npm run dev:api`, `npm run dev:worker`, `npm run dev:web`. Reinicie os processos após mudar `.env`. Para servir o frontend compilado, mantenha API e worker ativos e execute `npm run preview -w @lsports/web` (porta 4173).

## Fluxo e recuperação

1. O worker valida configuração, adquire um lock local exclusivo e publica estado `recovering`. API e worker resolvem `LSPORTS_STATE_FILE` a partir da raiz do checkout.
2. Cada pacote verifica o status de distribuição via Customers API e inicia a distribuição se estiver desligada. Isso é uma operação real sobre o pacote. Ao encerrar, **não desliga a distribuição do fornecedor**, para não interromper outros consumidores.
3. Conecta à fila existente, prefetch 100, acknowledgements manuais. Não cria nem altera filas. Não execute dois consumidores concorrentes da mesma fila: RabbitMQ divide as mensagens entre eles.
4. Começa a receber mensagens e as mantém sem ACK durante `GetEvents`. Aplica snapshot completo, substitui os eventos anteriores daquele pacote, reaplica os deltas recebidos durante a recuperação e só libera as cuotas após terminar. ACK ocorre depois da publicação local. Não há reenvio de payload ou credenciais aos logs.
5. Mensagens 1/2/3/35 atualizam fixture, livescore, mercados e liquidações; 31/32 são keep-alive/heartbeat. `FeedInterrupted` dispara recuperação. IDs de bets grandes são preservados como strings pelo parser oficial. MsgGuid deduplica uma janela de 10.000 mensagens; LastUpdate e timestamps evitam regressões de odds. O sistema não assume que MessageSequence seja global ou contíguo.
6. Desconexão/cancelamento/erro força estado indisponível e reconexão com backoff de até 30s, seguida de novo snapshot. Por padrão, um snapshot completo também é obtido a cada cinco minutos; 90s sem mensagem da fila força reconexão. Ajuste apenas conforme cadência e limites autorizados pelo fornecedor.
7. Um arquivo JSON local, escrito via rename atômico a cada publicação, entrega eventos normalizados e saúde à API. É uma projeção local para esta aplicação independente, não um banco multi-host. Um único worker deve escrever esse arquivo. No reinício, recupera snapshot novo; não usa preços antigos do disco como se fossem atuais.
8. O worker mantém pulso local de cinco segundos. Após 20s sem publicação, a API retorna feed vazio indisponível; `/api/health` responde 503 se todos os pacotes estiverem indisponíveis. `/api/events` mantém HTTP 200 com estado explícito para a interface exibir o diagnóstico. Conexão parcial é indicada como `degraded`.
9. A interface consulta a API a cada três segundos, sem acesso às credenciais. Cuotas sem mercado Open, seleção Open, estado de evento permitido, ou conexão saudável ficam bloqueadas. Mudanças de odds em seleções existentes exigem aceitar as cuotas atualizadas; remoções/suspensões bloqueiam a simulação. Não existem endpoints de aposta/pagamento.

## Hípica e cobertura

O worker consulta `getSports()` por pacote e registra `catalogHorseRacing` quando há resposta válida. Esse catálogo **não comprova entitlement**. A API também retorna `horseRacing.status`:

- `observed`: há pelo menos um evento identificado como Horse Racing recebido via snapshot/feed.
- `not_observed`: ambos os snapshots foram consultados, sem eventos observados. Ausência no momento não prova falta de cobertura.
- `unknown`: falta consulta autenticada suficiente.

Sem credenciais reais, a disponibilidade nos pacotes 4511/4510 permanece **não verificada**. Caso não apareçam eventos, confirme com o suporte LSports a cobertura de horse racing nesses pacotes Test e a assinatura dos eventos. A aplicação não altera assinaturas automaticamente. O adaptador cobre fixtures esportivas e mercados agregados `Bets`; não escolhe arbitrariamente preços de `ProviderMarkets`, não implementa outright nem apostas mútuas. Se o pacote entregar apenas mercados por provedor, a interface mostrará ausência de cuotas até configurar esse modelo com o fornecedor.

## Como confirmar uma conexão real

Com `.env` preenchido e rede liberada no Mac, rode os três processos. O worker deve registrar `snapshot_recovered` separadamente para `prematch` e `inplay`, sem senhas, e continuar recebendo mensagens. Consulte `/api/health`: examine os estados, `lastMessageAt`, `lastSnapshotAt`, contagens e diagnóstico de Hípica. Um snapshot vazio pode ser válido e é exibido sem fixtures inventados. Teste interromper o worker/rede e confirme bloqueo das cuotas e recuperação antes de considerar a integração validada.

Destinos necessários: hosts AMQP fornecidos nas portas confirmadas; HTTPS 443 para Snapshot e Customers. O ambiente cloud pode restringir TCP AMQP mesmo com allowlist HTTPS; isso deve ser validado no host de execução. Não há túnel HTTP substituto inventado.

## Testes

`npm test` exercita SDK real contra servidor HTTP local controlado, envelopes oficiais de mensagens, IDs grandes, deltas de snapshot, ACK após persistência, suspensões, liquidações, deduplicação, expiração da projeção local, modo conectado sem fallback e configuração sem credenciais. Não são testes de autenticação ou cobertura do fornecedor. Testes de navegador usam respostas controladas para validar estados da interface. Build inclui verificação TypeScript de API/worker/frontend. Credenciais e arquivos `.runtime` são ignorados pelo Git.
