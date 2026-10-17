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

## Diagnóstico de autenticação e acesso

Pare o worker antes de testar para evitar confundir as conexões. Preserve seu `.env` existente. Atualize a branch e as dependências e execute, na raiz:

```sh
git switch feat/sportsbook-demo
git pull --ff-only origin feat/sportsbook-demo
npm ci
npm run diagnose:trade
```

O comando usa o mesmo `.env` e o mesmo SDK do worker, independentemente de `DATA_MODE`. Faz consultas autenticadas de leitura para **cada pacote**: status da distribuição, snapshot, catálogo e conexão AMQP com verificação passiva da fila existente. Uma rejeição na distribuição não impede o teste independente de snapshot ou RabbitMQ. Não inicia/para distribuição, não altera assinaturas, não consome/ACK mensagens e não modifica `.env` nem o arquivo de eventos. Snapshot pode retornar muitos eventos; usa timeout de 20s e limite de resposta de 50 MiB. AMQP usa timeout de conexão de 15s. Não execute em loop se o fornecedor limitar requisições.

Exit code 1 significa falha ou requisito ausente; os JSONs anteriores ao aviso de lifecycle do npm mostram a causa. Exit code 0 confirma apenas as sondagens realizadas; **não comprova permissão de `basic.consume`, recebimento contínuo, sincronização do feed ou cobertura de Hípica**. Essa validação exige o worker real.

Cada resultado informa `lane`, `packageId`, `operation`, `status`, `protocol`, códigos disponíveis (`httpStatus`, `providerStatus` do Header LSports, `amqpCode`, `networkCode`) e mensagem sanitizada. A tela e `/api/health` também recebem o diagnóstico da operação que bloqueou o worker. Respostas e erros brutos, request bodies, headers, username, password, tokens, stacks e URLs com credenciais não são registrados. Mensagens do fornecedor são traduzidas para categorias controladas, sem reproduzir texto arbitrário. Campos não disponíveis não são inventados.

| Operação / resultado                         | Interpretação                                                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `config`, `missing_credentials`              | Lista **nomes** das variáveis ausentes/vazias; nenhuma autenticação foi tentada para esse pacote.                                         |
| `distribution.status`, HTTP 401 / Header 401 | Rejeição ao consultar `POST /Package/GetDistributionStatus`. O worker ainda não tentou snapshot ou RabbitMQ.                              |
| `distribution.start`, HTTP 403               | Distribuição estava desligada, mas o início em `POST /Distribution/Start` foi negado. O diagnóstico de leitura não chama esse endpoint.   |
| `snapshot.events`, HTTP 401/403              | Falhou especificamente `/Prematch/GetEvents` ou `/Inplay/GetEvents`. HTTP 403 pode vir do fornecedor ou de proxy; não prova senha errada. |
| HTTP 200, Header 401 / `Header.Errors`       | Erro semântico do fornecedor mesmo com transporte HTTP bem-sucedido; agora tratado como falha, não como snapshot vazio.                   |
| `amqp.connect`, AMQP 403                     | Broker recusou login/mecanismo PLAIN **ou** acesso ao vhost; o código sozinho não distingue esses casos.                                  |
| `amqp.queue`, AMQP 404                       | Fila ausente no vhost; o diagnóstico não a cria. A prova passiva não testa `basic.consume`.                                               |
| `amqp.consume`, AMQP 403                     | Worker foi impedido de consumir a fila. Confirme permissão de leitura.                                                                    |
| `network` / `tls`                            | Problema de rede, listener, timeout ou certificados, separado de credenciais ausentes.                                                    |

### Comparação com o SDK oficial

O portal `docs.lsports.eu` continuou retornando 403 **pelo proxy deste ambiente de desenvolvimento**; isso não é uma resposta dos seus pacotes no Mac. Foram reconferidos os fontes oficiais e a versão instalada:

- `HttpRequestDto`, `Mapper`, `BaseHttpClient` e `AxiosService`: autenticação HTTP por JSON POST com `packageId`, `username`, `password`. Sem Basic Auth, Bearer, senha em query string ou username derivado do package ID. O código continua usando as factories oficiais.
- Snapshot: `GetEventRequestDto`/`GetInPlayEventRequestDto`, sem filtros opcionais, para recuperação do pacote. Rotas oficiais permanecem `/Prematch/GetEvents` e `/Inplay/GetEvents`; não foi acrescentado um parâmetro `Test` inventado. Os testes verificam o corpo HTTP realmente enviado pelo SDK.
- `sample/feed-sample/src/config/app-config.json` e `consume-queue-name`: vhosts `StmPreMatch`/`StmInPlay`, filas `_4511_`/`_4510_`, conforme IDs informados. O mesmo par do pacote é usado em HTTP e AMQP por padrão. Não se presume que o username RabbitMQ seja `4511` ou `4510`.
- O `amqplib` direto foi alinhado à linha 0.10 usada pelo SDK; o lockfile fixa a instalação. Isso remove uma divergência de dependências, mas não prova a causa de uma rejeição de autenticação.
- Corrigida a observação dos erros HTTP: o SDK CommonJS usa uma instância de Axios diferente daquela carregada por import ESM. Timeout, bloqueio de redirects e captura de status agora são aplicados à instância efetivamente usada pelo SDK, inclusive quando há dependência aninhada. O observador guarda apenas códigos/categorias. Isso corrige os diagnósticos e limites, sem alterar o formato de autenticação.
- Corrigida a perda do erro original quando fechar a conexão AMQP após uma falha HTTP gerava um evento `close`. O diagnóstico preserva a operação que falhou.

### Credenciais diferentes para HTTP e RabbitMQ

Só configure overrides se o fornecedor tiver atribuído um par RabbitMQ ou vhost diferente. As variáveis existentes continuam válidas e não são alteradas automaticamente:

- `LSPORTS_PREMATCH_USERNAME` / `LSPORTS_PREMATCH_PASSWORD`: par HTTP do pacote 4511 e default AMQP.
- `LSPORTS_INPLAY_USERNAME` / `LSPORTS_INPLAY_PASSWORD`: par HTTP do pacote 4510 e default AMQP.
- `LSPORTS_PREMATCH_MQ_USERNAME` / `LSPORTS_PREMATCH_MQ_PASSWORD`: par AMQP explícito opcional, sempre completo.
- `LSPORTS_INPLAY_MQ_USERNAME` / `LSPORTS_INPLAY_MQ_PASSWORD`: equivalente para InPlay.
- `LSPORTS_PREMATCH_VHOST` / `LSPORTS_INPLAY_VHOST`: overrides opcionais; default conforme SDK.
- `LSPORTS_PREMATCH_QUEUE` / `LSPORTS_INPLAY_QUEUE`: filas específicas somente quando atribuídas pelo fornecedor.

Node dá precedência às variáveis já exportadas no shell sobre os valores do `.env`. Se você preencheu `.env` mas havia exports antigos, rode o diagnóstico em um terminal sem esses exports ou use `unset` apenas nos nomes conflitantes. Não imprima variáveis nem use `source .env`. Um valor composto só de espaços é tratado como ausente; os demais valores de credenciais não são recortados ou modificados silenciosamente.

Após corrigir o parâmetro identificado, execute `npm run diagnose:trade` outra vez e depois `npm run dev`. A causa da rejeição real só pode ser estabelecida com esse resultado autenticado; testes locais com respostas controladas não validam o acesso aos pacotes do fornecedor.

## Fila 404 com conexão e canal OK

A conexão RabbitMQ bem-sucedida confirma acesso ao broker/vhost usado no teste; não comprova que a fila solicitada exista. O SDK oficial `resolveConsumeQueueName` usa **um underscore antes e um depois** do package ID, a menos que `customQueueName` tenha sido configurado:

| Pacote        | Vhost do exemplo oficial | Fila default do SDK |
| ------------- | ------------------------ | ------------------- |
| PreMatch 4511 | `StmPreMatch`            | `_4511_`            |
| InPlay 4510   | `StmInPlay`              | `_4510_`            |

A configuração agora usa diretamente esse resolvedor oficial. O default já tinha os underscores; uma saída `queue: "4510"` indica um override efetivo, por exemplo `LSPORTS_INPLAY_QUEUE=4510` no `.env` **ou no shell**. Não se conclui, só pela captura, qual dessas fontes forneceu o valor. O diagnóstico mostra `queueSource`, `queueVariable`, `sdkDefaultQueue` e o nome solicitado também na linha `amqp.queue`, e alerta quando o override corresponde apenas ao ID numérico. Não altera overrides silenciosamente, pois o fornecedor pode ter atribuído uma fila personalizada válida.

Se LSports não atribuiu filas personalizadas, ajuste **você mesmo**, no `.env` do Mac:

```dotenv
LSPORTS_PREMATCH_QUEUE=_4511_
LSPORTS_INPLAY_QUEUE=_4510_
LSPORTS_PREMATCH_VHOST=StmPreMatch
LSPORTS_INPLAY_VHOST=StmInPlay
```

Alternativa: deixe as duas variáveis `*_QUEUE` vazias para usar os defaults do SDK. Se houver exports antigos dessas quatro variáveis, eles têm precedência sobre `.env`. Para repetir a prova usando os valores do arquivo sem modificar suas senhas, rode na raiz:

```sh
env -u LSPORTS_PREMATCH_QUEUE -u LSPORTS_INPLAY_QUEUE \
    -u LSPORTS_PREMATCH_VHOST -u LSPORTS_INPLAY_VHOST \
    npm run diagnose:trade
```

O código não modifica `.env` e continua usando somente `checkQueue`, declaração **passiva**. Não cria filas, não tenta variantes automaticamente e não consome eventos durante o diagnóstico. Se `_4511_`/`_4510_` ainda retornarem 404 nos vhosts confirmados pelo fornecedor, solicite a LSports confirmação das filas provisionadas para esses pacotes Test. Não crie filas manualmente para contornar o erro.

### Snapshot PreMatch sem código HTTP

Uma falha anterior a uma resposta completa não necessariamente tem código HTTP. Antes, o SDK podia remover o código Axios ao encapsular esse erro e o resultado acabava como `unexpected`. O diagnóstico agora preserva dados técnicos controlados antes desse encapsulamento:

- `clientCode`: somente códigos conhecidos, como `ERR_BAD_RESPONSE`, `ECONNABORTED` e `ECONNRESET`.
- `reason`: causa classificada, como `response_size_limit`, `timeout`, `sdk_conversion`, `non_json_response` ou `invalid_snapshot`; não é uma cópia do payload.
- `stage`: `request`, `response`, `sdk` ou `validation`.
- `elapsedMs`, `timeoutMs`, `responseLimitBytes`: duração e limites locais efetivamente usados, quando disponíveis.
- `httpStatus`: quando observado, inclusive em algumas falhas ao ler a resposta; não é inventado quando a requisição termina antes dos headers.

Exemplo: `category: "response_limit"`, `reason: "response_size_limit"`, `clientCode: "ERR_BAD_RESPONSE"`, `responseLimitBytes: 52428800` identifica uma resposta maior que o limite local de 50 MiB, não uma senha incorreta. `reason: "timeout"` informa a expiração do timeout configurado. `reason: "sdk_conversion"` identifica falha de conversão da resposta pelo SDK. Os testes reproduzem esses casos contra um servidor local, preservando a sanitização. Se continuar `unexpected`, o diagnóstico explicita `unknown_exception`/tipo seguro sem expor a mensagem arbitrária; será necessária investigação adicional da resposta real.

Não se presume que alguma dessas causas seja a falha do seu PreMatch até repetir o teste autenticado. Não foram alterados limites, filtros do snapshot nem credenciais com base apenas nessa captura. InPlay `events: 0` continua sendo uma resposta vazia válida — não prova disponibilidade de eventos nem permite inserir dados fictícios.
