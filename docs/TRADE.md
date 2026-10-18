> **Atualização contratual em 18/10/2026:** as restrições históricas abaixo sobre ausência de fuso foram substituídas pela confirmação escrita UTC do ticket #217525. Consulte a seção “Contrato UTC confirmado” ao final. Migrações históricas permanecem offline e não devem ser repetidas.
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

## Mensagens: `feed.decode` após AMQP conectado

O decoder foi comparado com `MessageConsumer`, `WrappedMessage`, `MessageHeader`, `TransportMessageHeaders`, `BodyHandler` e as entidades do SDK oficial. O portal de documentação permanece bloqueado pelo proxy deste ambiente; o código oficial consultado não mudou de commit durante esta revisão. O SDK Node converte os bytes diretamente para texto JSON; não há tratamento de `contentType`, `contentEncoding` ou compressão nessa implementação upstream. O adaptador local acrescenta interpretação explícita das propriedades de transporte e diagnóstico por etapa, sem afirmar que seu pacote esteja usando compressão.

### Formatos e metadados

- Envelope oficial: objeto JSON `Header`/`Body`, com `Header.Type`, `Header.MsgGuid`, `Header.CreationDate` e `Header.ServerTimestamp`; atualizações usam `Body.Events`. O parser de IDs grandes e as conversões de entidades continuam sendo os do SDK.
- Mensagens de evento: fixture 1, livescore 2, mercados 3 e liquidação 35. Mensagens de controle: keepalive 31 e heartbeat 32. Os nomes dos tipos são obtidos do registro oficial `knownEntityKeys`.
- UTF-8 estrito, com suporte a BOM. MIME JSON e `+json` são reconhecidos; MIME ausente ou desconhecido não invalida JSON por si só, como no SDK, mas MIME desconhecido gera aviso sanitizado. Não se tenta interpretar XML/Protobuf como JSON válido.
- `contentEncoding`: UTF-8/identity, gzip/x-gzip, deflate com wrapper zlib e Brotli (`br`). Gzip e zlib também podem ser detectados por assinatura binária quando a declaração não informa compressão; isso é registrado como aviso. Não há tentativa cega de vários codecs nem base64 automático.
- Os limites locais são 50 MiB para mensagem recebida e 50 MiB depois de descomprimir. Compressão inválida, expansão acima do limite, UTF-8 inválido e JSON malformado geram causas distintas. Um charset declarado diferente de UTF-8 não é reinterpretado silenciosamente.
- GUID: usa `Header.MsgGuid`, ou o campo oficial de transporte `MessageGuid` quando necessário. Eventos sem identificador estável são rejeitados com diagnóstico explícito.
- Timestamp de eventos: usa `timestamp_in_ms`; na ausência/invalidez, tenta `properties.timestamp` AMQP (segundos), `Header.ServerTimestamp` (Date/epoch em milissegundos conforme o SDK) e `Header.CreationDate`. Não usa relógio local para inventar tempo de odds. Headers de transporte ausentes deixam de causar erro genérico quando o envelope contém metadados válidos.
- Heartbeat/keepalive podem não ter `Body`, GUID ou timestamp. Só para esses controles, um fingerprint local interno serve para deduplicação e o horário local marca recebimento; ambos têm origem explicitamente identificada. Não criam eventos ou odds. `FeedInterrupted` causa bloqueio e recuperação; como é um controle processado, recebe ACK após registrar o estado e não é recolocado infinitamente na fila.

### Diagnóstico seguro

Falhas incluem `decodeStage` (`properties`, `decompress`, `text`, `json`, `envelope`, `transport_headers` ou `entity`) e `reason`, como `invalid_json`, `missing_timestamp`, `entity_conversion` ou `unsupported_message_type`. `messageMetadata` contém somente:

- tamanhos recebidos/decodificados;
- classificação allowlisted de MIME/encoding e codec escolhido;
- classificação da assinatura binária, sem bytes brutos;
- presença dos nomes de headers oficiais, sem seus valores;
- tipo numérico/nome oficial, quantidade de eventos e flag de redelivery;
- origem do GUID/timestamp e avisos controlados.

GUIDs, IDs de bets/fixtures, participantes, payload, bytes iniciais, headers arbitrários, credenciais e stacks não são registrados. MIME/encoding desconhecidos aparecem como `other`; seu valor arbitrário não é copiado. A primeira mensagem processada de cada combinação de tipo/codec/metadados gera um registro `feed.decode` com `status: "ok"`; logs equivalentes são limitados por sessão. O diagnóstico da falha também fica disponível em `/api/health` e na projeção local lida pela interface.

### ACK/NACK e preservação

Foi corrigido o NACK anterior com `requeue=false`. Mensagem com erro de decode/aplicação/persistência não recebe ACK: o worker solicita `nack(msg, false, true)`, registra `deliveryDisposition: "requeue_requested"`, bloqueia cuotas e fecha a conexão. Falhas de decode/aplicação pausam somente esse feed com `status: "blocked_message"` e `retryPolicy: "restart_required"` até reiniciar o worker após a correção, evitando redelivery ilimitado da mesma mensagem. Falhas transitórias de rede continuam usando backoff e snapshot. Se não conseguir enviar NACK, registra `unacknowledged_until_close` e deixa a conexão fechar com a entrega não confirmada. Não cria filas nem configura dead-letter queues no fornecedor.

ACK de eventos só ocorre depois da aplicação e publicação local. Tipos desconhecidos ou conhecidos sem handler (incluindo outrights ainda não implementados) **não são reconhecidos e descartados**: ficam sujeitos a requeue com um erro explícito. Uma mensagem incompatível pode bloquear esse feed até ser suportada ou corrigida pelo fornecedor; não se afirma que reconexão por si só resolva um payload inválido. A retenção final também depende das políticas de TTL/delivery-limit do broker, que este código não modifica.

### Atualizar no Mac e observar processamento

Pare os processos antigos. Não substitua seu `.env`; nenhuma variável nova é exigida nesta correção.

```sh
git switch feat/sportsbook-demo
git pull --ff-only origin feat/sportsbook-demo
npm ci
npm run build
npm test
npm run dev
```

Para observar apenas o worker com menos ruído, mantenha API e frontend em seus terminais e rode `npm run dev:worker` em outro, evitando executar um segundo worker ao mesmo tempo. `npm run diagnose:trade` continua sendo uma prova passiva de HTTP/AMQP/filas: **não consome mensagens**, portanto não testa decode. A validação do processamento exige `npm run dev` ou `npm run dev:worker` com o pacote real. Veja `reason`, `decodeStage` e `messageMetadata` no log; não publique payloads ou `.env`.

Os testes locais cobrem entidades SDK, tipos de controle, BOM, compressão/limites, fallback de metadados do envelope, códigos desconhecidos e requeue sem ACK em falhas. Não se declara decodificação do seu feed real validada sem esse teste autenticado no Mac.

## Canal saudável com zero eventos: prova de cobertura

`Feed conectado` significa conexão/consumer abertos e snapshot validado, **não** existência de fixtures. Um snapshot vazio agora é identificado como `snapshot vacío (0 fixtures)`. Heartbeat 32 e keepalive 31 mantêm o canal ativo, mas não geram eventos ou odds. `KeepAlive.ActiveEvents`, quando presente, é contado separadamente; trata-se da última lista recebida, possivelmente limitada ao provedor daquela mensagem, não de uma contagem global garantida do pacote.

### Onde verificar as contagens

O worker publica `coverage` por pacote no arquivo local, em `/api/events`, em `/api/health` e a cada minuto no log `feed.coverage`. A interface mostra o total da API e o total visível após esporte, aba e busca. Contadores iniciam quando o worker inicia; snapshots referem-se à última recuperação bem-sucedida.

- `snapshot.providerRows`, `bodyShape`: quantidade/estrutura observada em `Body` da resposta HTTP, antes da conversão do SDK. Não contém payload ou IDs.
- `snapshot.sdkRows`, `acceptedRows`: quantidade convertida pelo SDK e validada pelo adaptador. `filters: "none"` confirma que não enviamos filtros opcionais de esporte, liga, localização, fixture ou datas no `GetEvents`.
- `messagesByType`, `eventUpdatesReceived`: mensagens decodificadas com sucesso e quantidade de eventos nos updates. Controles não incrementam o segundo contador. Mensagens inválidas continuam gerando erro explícito e não são contadas como fixtures ausentes.
- `rowsStored`, `rowsWithoutFixture`: estado retido e registros aguardando metadados `Fixture`. Mercados/livescores que chegam primeiro são retidos, mas não viram uma fixture fictícia.
- `rowsPublished`, `rowsHiddenAsDuplicate`: eventos publicados e duplicatas PreMatch suprimidas quando a mesma fixture está em progresso no InPlay. Não há exclusão por falta de mercados, status encerrado ou esporte desconhecido; estes últimos aparecem em “Otros deportes”.
- `eventsWithMarkets`, `eventsWithSelections`, `eventsWithSelectableOdds`: distinguem fixture, mercado, seleção e cuota atualmente selecionável. Falta de odds não remove o evento da API.
- `duplicateMessages`, `staleUpdatesIgnored`, `marketsWithoutId`: mostram deduplicação de mensagens, atualizações antigas não aplicadas e mercados sem ID ignorados pelo modelo. Não equivalem automaticamente a fixtures perdidas.
- `/api/health.apiEventCount`: total efetivamente retornado pela API. Arquivo ausente/desatualizado retorna estado indisponível, não uma confirmação de ausência do fornecedor.

O SDK oficial define o snapshot como `Header`/`Body`, com `Body` array de elementos `GetEventsResultElement` (`FixtureId`, `Fixture`, `Livescore`, `Markets`) ou um elemento único. O teste de integração percorre resposta HTTP não vazia → SDK → estado → arquivo atômico → API, incluindo um evento sem mercados e um esporte não mapeado, sem perder essas fixtures. Formato incompatível não é reinterpretado como lista vazia.

### Consultas de assinaturas e quota, somente leitura

Pare o worker e rode `npm run diagnose:trade`. Além das sondagens anteriores, agora usa os métodos oficiais `CustomersApiFactory.createSubscriptionHttpClient`:

| Operação do diagnóstico                   | Método e rota oficiais                                                                       | O que retorna no log                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `subscriptions.list`                      | `getSubscriptions(new GetSubscriptionsRequestDto({}))`, POST `/Fixtures/Get`                 | `subscribedFixtures`, sem IDs e sem filtros opcionais    |
| `subscriptions.quota`                     | `getPackageQuota()`, POST `/package/GetPackageQuota`                                         | `creditLimit`, `creditRemaining`, `usedCredit`           |
| `subscriptions.schedule` (somente InPlay) | `getFixturesSchedule(new GetFixtureScheduleRequestDto({}))`, POST `/Fixtures/InPlaySchedule` | `scheduledFixtures`, agenda InPlay sem filtros opcionais |

As rotas e os nomes/casing vêm do SDK oficial, não de navegação presumida no painel. Se a operação retornar erro ou uma estrutura não reconhecida, o diagnóstico informa falha e **não** transforma isso em zero assinaturas. Respostas sem `Fixtures` não são aceitas apenas porque o DTO tem array vazio default.

O comando não executa `/Fixtures/Subscribe`, `/Leagues/Subscribe`, unsubscribe ou mudanças em mercados. O worker também não assina automaticamente fixtures/ligas. `DistributionOn=true` habilita distribuição, mas não comprova assinatura de fixtures ou cobertura comercial. Os 68 esportes do catálogo, por exemplo, não comprovam habilitação desses esportes no pacote. Quota zero deve ser interpretada conforme a política do contrato/Test; o código não compra créditos nem presume uma cobrança específica.

### Como interpretar sem culpar o fornecedor ou a interface indevidamente

| Evidência observada                                                                     | Interpretação e próximo passo                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `providerRows=0`, `sdkRows=0`, `eventUpdatesReceived=0`, só tipos 31/32, `rowsStored=0` | Nas respostas e mensagens processadas não vieram fixtures. Não é filtro da interface; investigar assinaturas/cobertura Test e período com eventos. Não prova que o fornecedor não tenha eventos globalmente. |
| `providerRows>0` e `sdkRows/acceptedRows` divergentes                                   | Erro de conversão/validação, não ausência legítima. O worker deve reportar falha, sem fallback.                                                                                                              |
| `rowsWithoutFixture>0`                                                                  | Houve updates sem metadados da fixture. Confirmar entrega de tipo 1 e inclusão da fixture no snapshot; os registros permanecem retidos localmente.                                                           |
| `rowsPublished>0`, mas API vazia/indisponível                                           | Verificar API e worker na mesma cópia e com o mesmo `LSPORTS_STATE_FILE`, além da freshness.                                                                                                                 |
| `apiEventCount>0`, mas zero visível                                                     | Filtro de esporte/aba/busca. Conferir “Otros deportes”, En vivo/Prepartido e limpar busca.                                                                                                                   |
| Fixtures publicadas, mas `eventsWithSelectableOdds=0`                                   | Questão de mercados/preços/status, não de ausência de eventos. Conferir `Bets` agregados versus `ProviderMarkets`, suspensões e cobertura do pacote.                                                         |
| Assinaturas zero e agenda InPlay não vazia                                              | Há candidatos na agenda, mas a consulta não encontrou assinaturas de fixtures. Confirmar estratégia de assinatura e elegibilidade com LSports; agenda não garante entitlement.                               |

### O que verificar no painel ou solicitar ao suporte LSports

Não inventamos nomes de menus do painel, cuja interface não está disponível aqui. Peça confirmação objetiva destes pontos para **PreMatch Test 4511** e **InPlay Test 4510**, separadamente:

1. Pacotes ativos e associados às credenciais/ambiente Test corretos; distribuição ligada e cobertura de esportes, ligas, fixtures e mercados habilitada contratualmente. Confirmar Hípica explicitamente, pois catálogo não é prova de cobertura.
2. Estratégia de assinatura: distribuição automática de todo o conteúdo contratado ou necessidade de assinar fixtures/ligas; quais assinaturas estão ativas, pendentes, expiradas ou removidas. O SDK diferencia `Subscribed=1`, `Pending=2`, `Unsubscribed=3`, `Deleted=4` nos metadados de assinatura; a consulta `/Fixtures/Get` fornece a lista atual, não uma auditoria de todos os estados.
3. Quota/crédito e período do pacote Test: saldo/limite e se alguma restrição está impedindo ativação de fixtures. Confirmar a interpretação dos números no contrato antes de mudar assinaturas.
4. Um `FixtureId` autorizado de PreMatch com início futuro e um InPlay realmente em progresso no horário do teste. Informar o horário com fuso e pedir a resposta esperada de `/Prematch/GetEvents` e `/Inplay/GetEvents`, inclusive se snapshots são limitados às fixtures assinadas ou a uma janela padrão do serviço.
5. Se afirmarem que há conteúdo ativo, pedir confirmação de envio dos tipos 1/2/3 (fixtures, livescore e mercados) para `_4511_` em `StmPreMatch` e `_4510_` em `StmInPlay`, e se existe outro consumidor dividindo as mensagens dessas filas. Heartbeat/keepalive sozinhos não comprovam entrega dos tipos de evento.
6. Confirmar se há filtros no lado do fornecedor (esportes/ligas/fixtures/mercados, exclusões, distribuição Test por replay/agenda específica) e se o produto fornece odds agregadas em `Bets` ou apenas `ProviderMarkets`. Não usamos filtros opcionais locais no snapshot nem criamos assinaturas automaticamente.

Envie ao suporte somente os IDs dos pacotes, horário/fuso, contagens/estados sanitizados e os FixtureIds que eles autorizarem. Nunca envie `.env`, senha ou tokens. Após a confirmação, repita o diagnóstico e mantenha o worker ativo por um intervalo informado pelo fornecedor; compare os contadores, não apenas a mensagem “conectado”. Não houve validação com suas credenciais neste ambiente.

### Tipo 37: participantes de carreras y otros eventos outright

Se procesa `OutrightFixtureUpdate` con el SDK oficial: `Body.Competition`
contiene `Id`, `Name`, `Type` y `Events[].OutrightFixture`. No se interpreta
como `Body.Events`. Cada evento conserva la lista completa de participantes
(incluidos los inactivos y sus metadatos), sin reducirla a dos competidores.
La API publica `kind: outright`, `competition` y `participants`; la interfaz
permite desplegar la lista. El deporte se determina por el proveedor: el tipo
37 por sí solo no implica Hípica. Este mensaje no proporciona cuotas y no se
inventan mercados. Los demás tipos outright aún no implementados mantienen
su diagnóstico explícito y no se confirman como procesados.

Los IDs outright incluyen competición y un espacio separado de los fixtures
regulares. Las recuperaciones del snapshot regular no borran estos eventos.
Actualizaciones parciales que omiten participantes conservan la lista anterior;
las actualizaciones anteriores en el tiempo no la reemplazan. Una lista vacía
explícita y más reciente sí se respeta.

El consumidor usa confirmación manual. Solo emite ACK después de procesar y
publicar la proyección local. Un error de conversión, aplicación o escritura
solicita NACK con requeue y cierra la sesión; si falla el NACK, el mensaje queda
sin confirmar hasta cerrar la conexión. No crea ni purga colas del proveedor.
El diagnóstico del tipo 37 incluye tipo, cantidad de eventos y propiedades del
transporte, sin publicar participantes ni payloads completos en los logs.
No requiere cambios en `.env`. No equivale a una validación con el proveedor:
los tests automatizados utilizan mensajes sintéticos identificados como fixtures
de prueba y un transporte simulado.

### Mercados de Hípica por fixture (tipos 41 y 42)

El SDK oficial distingue `OutrightFixtureMarketUpdate` (41) de
`OutrightLeagueMarketUpdate` (40). El 41 contiene
`Body.Competition.{Id,Name,Type,Events}` y cada evento contiene `FixtureId` y
`Markets`. Usa las mismas entidades `Market` y `Bet` del SDK, con `Bets`,
`ParticipantId`, `Price`, `Status`, `BetStatusId` y `Settlement`.
`OutrightSettlementsUpdate` (42) tiene la misma estructura y actualiza las
liquidaciones; esas selecciones quedan bloqueadas para el billete simulado.
Fuentes oficiales:
- https://github.com/lsportsltd/trade360-nodejs-sdk/blob/ece873dfc9040e431662bc27e7c2bf8cbd519811/src/entities/message-types/outright-fixture-market-update.ts
- https://github.com/lsportsltd/trade360-nodejs-sdk/blob/ece873dfc9040e431662bc27e7c2bf8cbd519811/src/entities/message-types/outright-settlements-update.ts

Los tipos 41 y 42 se relacionan con el 37 por feed, competición y fixture.
Se admiten mercados antes de los participantes, sin fabricar metadatos ni
confundirlos con fútbol. Una actualización 37 o un snapshot regular conserva
los mercados outright. Los IDs grandes de selecciones siguen siendo strings.
Las actualizaciones atrasadas no reemplazan precios ni estados más recientes.
Los tipos 40/43 usan una jerarquía de liga diferente: aún no están implementados,
no se interpretan como carreras individuales, y conservan el error explícito y
NACK con requeue. Otros tipos desconocidos tampoco se descartan.

Con la aplicación activa, desde otro terminal del Mac (puerto API por defecto):

```bash
curl -sS http://localhost:3001/api/diagnostics/outright/20540377
```

Este endpoint y `/api/health` exponen diagnósticos sanitizados. Los contadores
corresponden al proceso actual del worker, no al historial completo del proveedor:

- `messagesByType["41"]`: mensajes de mercados decodificados y aplicados para esa
  competición/fixture. Las entregas duplicadas con mismo GUID no se reaplican.
- `marketUpdates` / `betUpdates`: entradas acumuladas recibidas por 41/42.
  `storedMarkets` / `storedSelections`: cantidades actuales de la proyección.
- `hasFixture: false`: llegaron mercados antes de los metadatos 37; están
  almacenados, pero no se publica un evento ficticio para mostrarlos.
- `lastMarketMessageAt` ausente: no se aplicaron mensajes 41/42 a esa carrera
  durante este proceso. Consulte también `connections.*.diagnostic`: un error de
  decode puede haber impedido procesar una entrega. No prueba falta de permisos.
- `market160`: estado, selecciones, selecciones con precio válido y habilitadas
  de Race Winner, si el mercado fue recibido. El precio debe ser finito y mayor
  que 1; mercado y selección deben estar abiertos, evento activo, feed conectado
  y selección sin liquidar. La interfaz distingue selecciones recibidas de cuotas
  habilitadas. No se generan precios para llenar huecos.
- `providerMarketUpdates > 0` con `betUpdates: 0`: llegaron `ProviderMarkets`
  específicos de bookmakers sin `Bets` agregadas. `providerBetUpdates` cuenta sus
  selecciones separadas de la cotización agregada. No se elige arbitrariamente
  un bookmaker para reemplazar la cotización agregada de TRADE.
- `staleBetUpdates`: actualizaciones ignoradas por ser anteriores al estado
  almacenado. `observation: not_observed_in_current_projection` indica que no hay
  una fila outright de ese ID en la proyección actual, no que la carrera no exista.

Si no se reciben mercados del fixture, confirme con LSports para Test y el paquete
correspondiente (4511 o 4510): distribución de mensajes 41 para fixture 20540377,
competición asociada, habilitación efectiva y cobertura del mercado 160 para ese
fixture y horario, y publicación de `Markets[].Bets` agregadas bajo la configuración
Recommended List/Offered. Solicite comprobar entrega en su cola provisionada y un
reenvío o recuperación oficial del estado de mercados. Activar Offered en el panel
no demuestra que esta cola haya recibido una actualización. Adjunte hora UTC,
paquete, fixture, contadores y diagnóstico sanitizado, nunca credenciales ni
payloads completos. No se modifica `.env` ni se crean colas o suscripciones nuevas.

### Recuperación Outright tras reiniciar el worker

Se corrigió un defecto de arranque: el worker creaba `TradeState` vacío y publicaba
antes de leer el estado existente. Esa primera escritura eliminaba los Outright
persistidos; el snapshot regular no los reconstruye. El reemplazo del snapshot
ya preservaba las filas Outright presentes en memoria. La búsqueda diagnóstica
usa el fixture ID numérico del proveedor, no el ID compuesto de la interfaz,
y devuelve coincidencias de ambas competiciones/feeds cuando corresponda.

Ahora el worker toma el lock y restaura antes de habilitar cualquier escritura,
heartbeat o recuperación HTTP. El mismo archivo configurado por `LSPORTS_STATE_FILE`
(por defecto `.runtime/trade-feed.json`) contiene una proyección pública y un
`workerCheckpoint` privado con versión. El checkpoint conserva todas las filas
Outright, incluso mercados aún sin metadatos, participantes completos, mercados,
selecciones, datos de proveedores y timestamps de ordenación. No contiene credenciales.
La API elimina el checkpoint privado de sus respuestas. El snapshot de fútbol
sigue siendo autoritativo para los fixtures regulares; no borra las filas Outright.

Un archivo de la versión anterior, sin checkpoint, se migra desde su proyección:
se recuperan participantes y mercados expuestos y se guarda el original como
`<archivo>.pre-checkpoint.bak`, sin sobrescribir un backup existente. Los campos
que no estaban en la proyección anterior (por ejemplo, mercados huérfanos o
metadatos exclusivos del proveedor) no pueden reconstruirse desde ese formato.
Un archivo inválido o de versión desconocida detiene el arranque sin sobrescribirlo.
La caducidad de 20 segundos aplicada por la API no impide restaurar después de una
parada larga. No se reutiliza el estado `connected` del archivo: debe reconectarse.

El log `file.restore` informa `source` (`missing`, `legacy_projection` o `checkpoint`)
y `rows`, sin payloads. El diagnóstico por fixture agrega `restored` y
`participantCount`. Los contadores por carrera conservados en el checkpoint son
acumulados y pueden abarcar reinicios; los contadores globales de cobertura siguen
siendo del proceso actual. Las odds restauradas se conservan como datos históricos
y quedan bloqueadas hasta una actualización de selección posterior a su timestamp
persistido. No se necesita una actualización para recuperar el evento y sus datos.

Para validar en el Mac:

1. No borre `.runtime` ni el archivo configurado. Con la aplicación activa, consulte
   `curl -sS http://localhost:3001/api/diagnostics/outright/20540377` y
   `curl -sS http://localhost:3001/api/events`.
2. Detenga con Ctrl+C y vuelva a ejecutar `npm run dev` sin eliminar archivos.
3. Compruebe `file.restore` con `source: checkpoint`, `rows` mayor que cero y la
   misma carrera/participantes/mercados en la API, aunque no lleguen mensajes 37/41.
   Las filas restauradas indican `restored: true`; las odds guardadas esperan
   actualización. La prueba automatizada hace este ciclo con snapshot regular
   vacío y sin recibir ninguna actualización del proveedor.

Si un reinicio con la versión defectuosa ya sobrescribió el archivo y el fixture
no figura en él, esta corrección no puede inventar los datos eliminados. Para
recuperarlos sin esperar al proveedor se necesita una copia anterior de ese archivo
(por ejemplo, de Time Machine). Con los procesos detenidos, conserve el archivo
actual aparte y restaure la copia en la ruta configurada antes de arrancar.
`.env` no requiere cambios y no debe reemplazarse.

### Snapshot inicial Outright por API (sin modificar suscripciones)

La restauración local no recupera una carrera si el archivo anterior ya fue
sobrescrito (`legacy_projection`, `rows: 0`). Para recuperar datos actuales del
proveedor, el worker consulta además los endpoints **oficiales PreMatch**:

| Operación diagnóstica | Método del SDK | Ruta POST en el host snapshot |
|---|---|---|
| `snapshot.outright.fixtures` | `getOutrightFixtures(new GetOutrightFixtureRequestDto({}))` | `/Prematch/GetOutrightFixture` (singular) |
| `snapshot.outright.markets` | `getOutrightFixtureMarkets(new GetOutrightMarketRequestDto({ fixtures }))` | `/Prematch/GetOutrightFixtureMarkets` |

El SDK también define `getOutrightEvents` → `/Prematch/GetOutrightEvents` como
respuesta combinada. Se usan las dos consultas separadas para identificar permisos,
respuestas vacías y fallas de fixtures/mercados independientemente. No se inventan
rutas, fechas, filtros ni parámetros. Los DTO admiten filtros opcionales (incluido
`fixtures`); la recuperación de mercados usa IDs de fixtures conocidos cuando están disponibles. La autenticación sigue en
el cuerpo generado por el SDK (`packageId`, `username`, `password`), exclusivamente
servidor. No se llama Subscribe/UnSubscribe ni se cambia la configuración del TRADE.

Fuentes oficiales consultadas:
- https://github.com/lsportsltd/trade360-nodejs-sdk/blob/ece873dfc9040e431662bc27e7c2bf8cbd519811/src/api/snapshot-api/services/prematch-snapshot.service.ts
- https://github.com/lsportsltd/trade360-nodejs-sdk/blob/ece873dfc9040e431662bc27e7c2bf8cbd519811/src/api/snapshot-api/enums/prematch-snapshot-routes-prefix-url.ts
- https://github.com/lsportsltd/trade360-nodejs-sdk/blob/ece873dfc9040e431662bc27e7c2bf8cbd519811/src/api/snapshot-api/interfaces/snapshotapiinplay-http-client.interface.ts

El `Body` de cada respuesta es una competición `{Id, Name, Type, Events}` o un
array de esas competiciones. Se valida la estructura y el conteo contra la
conversión del SDK. Se usan las entidades oficiales de mensajes para preservar
campos del cuerpo que los DTO de snapshot omiten (por ejemplo, estado del mercado
y metadatos ricos de participantes). Nunca se asume `Status: 1` si no fue recibido.
Los mercados usan el mismo espacio feed/competición/fixture de los tipos 37/41.
La consulta ocurre durante la recuperación inicial y periódica, con AMQP ya
consumiendo en buffer; sus deltas se aplican después. Los resultados se mezclan
con el checkpoint restaurado. Una respuesta vacía o un error no borra las carreras
persistidas. La API regular de fútbol conserva su flujo independiente.

`connections.prematch.outrightRecovery` expone `status`, `fixtures`, `marketEvents`,
`checkedAt` y diagnósticos sanitizados por operación. Una falla parcial degrada
la salud general aunque el socket esté conectado; no oculta el error bajo
`connected`. Los logs informan conteos, no payloads. `lastMarketSnapshotAt` y
`snapshotMarketUpdates` por carrera distinguen la recuperación HTTP de mensajes
AMQP; no se incrementan ficticiamente los contadores 37/41. Los resultados se
persisten en el checkpoint y sobreviven al siguiente reinicio.

El cliente **InPlay** de esta versión oficial solo expone Outright **de liga**:
`GetOutrightLeagues`, `GetOutrightLeagueMarkets`, `GetOutrightLeagueEvents`.
No expone el equivalente por fixture individual de las rutas anteriores. No se
supone `/Inplay/GetOutrightFixture` ni se usan credenciales 4510 contra una ruta
PreMatch. Se informa `outrightRecovery.status: unsupported` en InPlay para esta
recuperación por carrera. Los mensajes AMQP 37/41/42 de ese feed siguen soportados,
y los datos locales se restauran normalmente.

Validación en el Mac, con las credenciales existentes y sin borrar `.runtime`:

```bash
npm run diagnose:trade
npm run dev
# En otro terminal (puerto API por defecto):
curl -sS http://localhost:3001/api/diagnostics/outright/20540377
```

`diagnose:trade` consulta snapshots sin iniciar distribución, consumir mensajes ni
cambiar suscripciones. Verifique los dos resultados PreMatch: un HTTP 200 con cero
filas prueba una respuesta vacía, no entrega del fixture específico. Consulte
`connections.prematch.outrightRecovery` en la API y los contadores por carrera.
No se declaró validado el proveedor: los tests usan HTTP local y SDK real.

Si Test devuelve vacío, rechaza la consulta, o la carrera corresponde solo a InPlay,
solicite a soporte LSports exactamente:

> Para el entorno Test, recuperar el estado completo de la carrera fixture 20540377
> y su Competition.Id, manteniendo las suscripciones actuales. Confirmar si está
> disponible en `/Prematch/GetOutrightFixture` y `/Prematch/GetOutrightFixtureMarkets`
> con filtro `fixtures: [20540377]` y los permisos del paquete PreMatch 4511.
> Si no es recuperable por snapshot (o pertenece al paquete InPlay 4510), reenviar
> a la cola ya provisionada un **OutrightFixtureUpdate, tipo 37**, con todos los
> participantes y estado actual, seguido de **OutrightFixtureMarketUpdate, tipo 41**,
> con el estado completo del mercado Race Winner 160, `Bets`, `ParticipantId`, precios,
> estados y timestamps. Si el mercado está liquidado, incluir el estado de liquidación
> correspondiente (tipo 42). PreMatch: host stm-prematch.lsports.eu, vhost StmPreMatch,
> cola _4511_; InPlay: host stm-inplay.lsports.eu, vhost StmInPlay, cola _4510_ (o la
> cola personalizada confirmada por soporte). No cancelar ni recrear suscripciones.
> Confirmar retención/disponibilidad histórica si la carrera ya finalizó.

Adjunte hora UTC, paquete, HTTP/status y contadores sanitizados; no contraseñas.
No se requiere cambiar `.env`.

### HTTP 429 y coordinación de snapshots

HTTP 429 significa límite de consultas, **no** ausencia de carreras, participantes
u odds. La API local en puerto 3001 puede funcionar normalmente mientras la
recuperación HTTP del proveedor está limitada.

Worker y `diagnose:trade` ahora comparten una agenda persistente junto al archivo
`LSPORTS_STATE_FILE`: `<archivo>.snapshot-<hash-del-host>.json` y su lock temporal.
Se coordina por host de snapshot entre paquetes y procesos del mismo workspace.
No se guardan credenciales ni payloads allí. El checkpoint conserva su archivo y
su restauración; la agenda no lo reemplaza. Ejecute ambos comandos con la misma
ruta de estado y no borre la agenda para saltar una pausa del proveedor.

Política local (no representa una cuota documentada de LSports):

- Una consulta de snapshot por host a la vez, separadas al menos 5 segundos.
- Cada paquete/operación se refresca como máximo una vez cada 5 minutos si tuvo
  éxito. Un `LSPORTS_SNAPSHOT_INTERVAL_MS` mayor sigue respetándose en el worker;
  valores menores no aumentan la frecuencia por debajo de ese mínimo local.
- HTTP 429 con `Retry-After` válido respeta tanto segundos como fecha HTTP. El
  plazo se comparte con las demás operaciones/paquetes del host y sobrevive a
  reinicios. Una pausa menor al espaciado local se amplía hasta ese espaciado.
- Sin un `Retry-After` válido, los 429 de la misma operación esperan 60, 120, 240…
  segundos hasta una base máxima de 30 minutos, con jitter positivo de hasta 10%.
  Un éxito reinicia la progresión de esa operación. El contador se conserva al
  reiniciar; un aplazamiento local no lo incrementa.
- Un proceso que encuentra otra consulta activa o un plazo pendiente **no envía
  HTTP** ni queda dormido durante toda la pausa: informa el aplazamiento.

El worker agenda por separado snapshot regular, fixtures Outright y mercados
Outright. Así una operación exitosa no ocupa todos los turnos mientras otra
espera. Los 429 también se manejan en el snapshot regular: no provocan reconexión
AMQP ni vacían el estado. Se continúan procesando y confirmando mensajes AMQP,
publicando el heartbeat y guardando el checkpoint durante la espera. Los errores
Outright conservan salud degradada y diagnóstico explícito, sin datos demo.

Campos sanitizados:

- `category: rate_limited`, `httpStatus: 429`, `deferred: false`: respuesta real
  del proveedor; `retryAt`, `retryAfterMs` y `attempts` indican el nuevo plazo.
- `category: rate_limited`, `deferred: true`, sin `httpStatus`: coordinación local;
  no se realizó otra petición. `retryAt` informa cuándo vuelve a ser elegible.
- `connections.*.outrightRecovery.status: rate_limited`: recuperación pendiente,
  sin reemplazar conteos anteriores por cero. El diagnóstico regular aparece en
  `connections.*.diagnostic`. Una consulta aplazada no genera un snapshot vacío.

`diagnose:trade` utiliza la misma agenda y no fuerza consultas. Puede terminar
con código 1 y operaciones `status: deferred` cuando la comprobación está pendiente;
no equivale a credenciales rechazadas. No lo ejecute en loop para forzar snapshots.
Mantenga `npm run dev` activo y consulte `/api/diagnostics/outright/20540377` o
`/api/health`, que leen la proyección local y no consultan al proveedor.
No es necesario modificar `.env`.

### HTTP 200 sin recuperación válida: inspección sanitizada

HTTP 200 por sí solo no valida un snapshot. El SDK oficial, en
`BaseHttpClient.validateResponsePayloadStructure`, exige `Header` y `Body` no nulos.
Después, nuestro parser exige competiciones con `Id` y `Events`, eventos con
`FixtureId` y `Markets`, y selecciones con IDs válidos. La ausencia de esos campos
no debe convertirse en una lista vacía ni en éxito.

El diagnóstico ahora adjunta `responseInspection` en errores de snapshot. Contiene
solo tipos, nombres **fijos y permitidos** de campos y cantidades: `root`, `header`,
`body`, `knownRootFields`, `knownBodyFields`, `contentType`,
`applicationErrorFields/Items`, `competitionRows`, `eventRows`, `marketRows`,
`selectionRows`, `bodyEmptyArray` y `bodyEmptyObject`. No incluye valores de
credenciales, nombres de participantes, IDs, URLs, textos de error, fragmentos
HTML, claves arbitrarias ni payloads completos. Un objeto desconocido puede
contabilizarse, pero sus claves no se imprimen.

Los motivos distinguen:

| `reason` | Evidencia | Interpretación |
|---|---|---|
| `missing_response_header` | Header ausente o null | Envelope incompatible con el SDK. Revisar campos permitidos observados. |
| `missing_response_body` | Body ausente | Respuesta incompleta; no equivale a cero mercados. |
| `null_response_body` | Body explícitamente null | El SDK lo rechaza; no se transforma en `[]` sin confirmación del proveedor. |
| `empty_http_body` | Transporte sin contenido | No hay recuperación demostrada. |
| `non_json_response` | JSON inválido o HTML/texto | No se interpreta como datos TRADE. |
| `application_error` | Errors/Error explícitos no vacíos en Header, raíz o Body | Error de aplicación incluso con HTTP 200; texto omitido. |
| `invalid_snapshot` | Envelope legible, entidad/conteo inválido | Estructura incompatible con las entidades esperadas. |

`Header.HttpStatusCode` de error sigue figurando como `providerStatus`, separado
del `httpStatus` del transporte. Se detectan errores de aplicación en arrays,
objetos o strings no vacíos; el contenido no se publica. Un envelope válido con
`Body: []` pasa la validación como respuesta vacía; no demuestra que el fixture
20540377 haya sido recuperado. En éxitos estructuralmente válidos se guarda el
resumen en `connections.prematch.outrightRecovery.responseInspections.markets`.

Para obtener evidencia real en el Mac:

1. Actualice y reinicie el worker conservando `.runtime`, `.env` y la agenda.
2. Espere la siguiente consulta **ya coordinada**; no fuerce llamadas ni borre
   archivos para saltar `retryAt`. La instrumentación no agrega requests HTTP.
3. Lea el endpoint local, que no consulta al proveedor:

```bash
curl -sS http://localhost:3001/api/diagnostics/outright/20540377
```

En `connections.prematch.outrightRecovery.diagnostics`, copie únicamente
`operation`, `httpStatus`, `providerStatus`, `reason`, `responseInspection` y
`retryAt` de `snapshot.outright.markets`. No envíe `.env` ni el payload bruto.
Si la consulta sigue aplazada, espere al horario indicado y vuelva a leer el
endpoint local. El resumen aparece cuando se realiza la siguiente petición real.

Este entorno de desarrollo no dispone de las credenciales del Mac ni de la
respuesta real reportada. Los tests verifican los formatos anteriores con HTTP
local y SDK oficial, incluida recuperación de mercado/selección válida y ausencia
de filtraciones. No se atribuye un formato específico al proveedor sin observarlo;
una adaptación a otro envelope requiere esa evidencia y su confirmación oficial.
El checkpoint y los límites de consulta conservan su funcionamiento.

### Verificación de competitionId 11144 frente a fixtureId 20540377

Se reconfirmó el SDK oficial: `PrematchSnapshotApiClientPrefixUrl` define
`POST /Prematch/GetOutrightFixtureMarkets`. `GetOutrightMarketRequestDto` y su
request mapeado admiten `fixtures`, `markets`, `sports`, `locations`, `tournaments`,
`timestamp`, `fromDate`, `toDate`. **No definen `competitionId` ni `competitions`.**
La respuesta sí usa el `Id` de la competición como agrupación de `Events`.
El ejemplo oficial usa un DTO vacío: la consulta general anterior era compatible
con ese ejemplo; por sí sola no demostraba disponibilidad del mercado específico.

Ahora el worker envía en la siguiente consulta coordinada los **fixture IDs**
conocidos en el estado (incluidos los restaurados). Para el caso informado:

```json
{"fixtures":[20540377]}
```

Es el filtro del cuerpo JSON, además de la autenticación creada por el SDK.
`11144` no sustituye a `20540377`. No se agrega un parámetro de competición sin
respaldo del contrato oficial. El cliente recuerda los fixtures de la última
respuesta válida para el diagnóstico de lectura; sin IDs conocidos, conserva la
consulta general admitida por el ejemplo, sin consultas adicionales por fixture.
No aplica filtros de mercado ni fechas inventados, ni cancela suscripciones.
Los tests HTTP comprueban la ruta exacta, el filtro `fixtures: [20540377]` y la
ausencia de `competitionId`, con la competición de prueba 11144.

Fuentes:
- https://github.com/lsportsltd/trade360-nodejs-sdk/blob/ece873dfc9040e431662bc27e7c2bf8cbd519811/src/api/common/snapshot/dtos/outright-market-request.dto.ts
- https://github.com/lsportsltd/trade360-nodejs-sdk/blob/ece873dfc9040e431662bc27e7c2bf8cbd519811/src/api/common/snapshot/requests/outright-market-request.ts
- https://github.com/lsportsltd/trade360-nodejs-sdk/blob/ece873dfc9040e431662bc27e7c2bf8cbd519811/sample/snapshot-api-sample/src/index.ts

El portal `docs.lsports.eu` volvió a ser bloqueado con HTTP 403 por el proxy de
este entorno; no se atribuye esa respuesta a los paquetes del proveedor. Las
conclusiones de parámetros anteriores se basan en el SDK oficial y su serialización
verificada, no en una supuesta lectura exitosa del portal.

El diagnóstico agrega `requestInspection` al error y `marketRequest` al resumen
Outright: método, ruta, filtro elegido, cantidad de fixtures y
`competitionIdSent: false`. No expone el cuerpo de autenticación. Una consulta
aplazada muestra los parámetros preparados, con `deferred: true`; no representa
una petición nueva ya enviada.

Para el `Header`, `responseInspection` ahora incluye:

- `headerFields`: solo nombres permitidos y sus tipos, sin valores de texto.
- `headerCodes`: códigos numéricos acotados de HttpStatusCode, StatusCode, Status,
  Code y ErrorCode, si existen; no copia strings arbitrarios.
- `headerFlags`: Success, IsSuccess y Cached únicamente si son booleanos.
- `headerMessageSignals`: etiquetas fijas detectadas en los campos de mensaje
  permitidos (autenticación, permisos, parámetro inválido, no encontrado, límite
  o sin datos). No incluye mensajes, URLs, credenciales ni IDs de solicitud.
- `headerOtherFieldCount`: cantidad de campos no permitidos, sin imprimir sus
  nombres ni valores.

Esas señales ayudan a investigar; no reinterpretan un Header desconocido como
éxito ni sustituyen la semántica que debe confirmar LSports. `Body: null` permanece
como `null_response_body`, sin vaciar el checkpoint y sin fabricar odds. La
instrumentación usa la siguiente consulta elegible y respeta la agenda/retryAt.

Si el filtro explícito sigue devolviendo null, solicite al soporte:

> En Test, paquete PreMatch 4511, `POST https://stm-snapshot.lsports.eu/Prematch/GetOutrightFixtureMarkets`,
> con autenticación del SDK oficial y `fixtures: [20540377]` sin otros filtros,
> responde HTTP 200 con Body:null y sin Header.HttpStatusCode. GetOutrightFixture
> sí devuelve competitionId 11144 / fixtureId 20540377 y 9 participantes.
> Confirmen que esta ruta y el filtro por fixture son válidos en nuestro contrato
> y versión Test; si su backend exige competitionId, envíen el esquema exacto y
> expliquen la diferencia con GetOutrightMarketRequestDto del SDK oficial.
> Expliquen los campos y códigos del Header sanitizado adjunto y la causa exacta
> del null (parámetros, autorización de snapshot, falta de publicación/cobertura,
> estado finalizado o retención). Confirmen habilitación y publicación efectiva
> de Race Winner 160 con Bets agregadas para esta competición/fixture y acceso
> del paquete a esos datos, además de Recommended List/Offered en el panel.
> Si snapshot no puede recuperarlo, reenvíen el estado completo tipo 41 para
> competition 11144 / fixture 20540377 en la cola _4511_ del vhost StmPreMatch,
> incluyendo estados, precios, ParticipantId y timestamps; tipo 42 si liquidado.
> Mantengan las suscripciones existentes.

Adjunte hora UTC, versión del SDK (3.10.10), `requestInspection`,
`responseInspection`, HTTP/status y `reason`, sin credenciales ni payloads completos.
No se afirma que el filtro haya corregido la respuesta real hasta verificarlo en
el Mac. La persistencia y el flujo de fútbol permanecen independientes.

### Validación local durante el ticket LSports 217525

El soporte confirmó para mercados: `userName`, `password`, `packageId: 4511`
y `fixtures` como array. Se encontró una divergencia verificable: el SDK 3.10.10
usa `username` en `HttpRequestDto` y lo serializa con esa misma grafía. El cliente
ahora adapta el JSON **solo** en el transporte de
`/Prematch/GetOutrightFixtureMarkets`: envía `userName` y elimina `username`.
Las opciones y validaciones internas del SDK, variables `.env`, credenciales
RabbitMQ y endpoints regulares de fútbol conservan su contrato anterior.
No se envían simultáneamente ambas variantes del campo de usuario.

`fixtures` se envía siempre como array; los IDs conocidos siguen siendo fixtures,
no competiciones. Si no hay IDs, se envía `[]`: no se presume que eso signifique
"todos" ni que garantice datos. `Body:null` continúa siendo error. El resumen
sanitizado `requestInspection.credentialField` muestra `userName`, sin su valor.
Los tests con el SDK real y un HTTP local comprueban claves, paquete, array y
ruta exactos, además de conservar `username` en las consultas regulares.

**Alcance de los datos inspeccionados:** el workspace de esta validación no tenía
`.env`, credenciales inyectadas, proyección `trade-feed.json`, checkpoint ni captura
AMQP real. Su `.runtime` contenía solo scripts e imágenes de validaciones previas.
Esto no permite concluir que no existan odds en el Mac o en LSports. No se consultó
al proveedor para buscar otros eventos ni se consumió/purgó la cola.

**Auditoría del recorrido:** tipos regulares 1/2/3/35 y outright 37/41/42 tienen
handlers explícitos. Los tipos sin soporte, incluidos 40/43 de otra jerarquía,
generan error y requeue; no se confirman como procesados. Los mercados que llegan
antes del fixture se almacenan y se contabilizan como filas sin metadata, sin
fabricar eventos. Updates anteriores se contabilizan como `staleUpdatesIgnored`;
no reemplazan odds más recientes. `marketsWithoutId` registra entradas sin ID en
la ruta regular del estado; no había mensajes reales para determinar si ese
contador aumentó en el Mac. No se modificaron handlers o filtros basándose en
suposiciones sobre mensajes no observados. Las restricciones de estado, precio,
liquidación y conexión bloquean selecciones; no deben interpretarse como ausencia
de una selección recibida.

**Validación de extremo a extremo ejecutada con muestras aisladas:** se construyeron
mensajes gzip sintéticos de tipos 37/41 (9 participantes, Race Winner 160) y 1/3
(fútbol). Pasaron por el decoder SDK, TradeState, archivo/checkpoint atómico en un
directorio temporal, API Express real y React/Vite real en Chromium. Se verificó
selección en el billete, simulación, preservación tras restaurar el checkpoint y
ancho mobile. No hubo requests de pago ni consultas al proveedor. El aviso y los
nombres dicen PRUEBA AISLADA; ninguna muestra se escribió en `.runtime` ni se
presentó como dato real de LSports.

El script reproducible es `scripts/validate-local-sportsbook.mts` y se ejecuta con
`npm run validate:local-ui`. Requiere la herramienta opcional Playwright y Chromium
instalados en el entorno de tests; no se agregaron dependencias a la aplicación.
`PLAYWRIGHT_MODULE` permite indicar la ruta al módulo instalado fuera del repo y
`CHROMIUM_EXECUTABLE` el binario local. Usa puertos locales efímeros y directorio
temporal, y cierra los procesos/archivos de prueba al terminar.

En el Mac, actualice el código y mantenga el worker activo respetando `retryAt`.
La siguiente consulta elegible usará el formato confirmado. Para revisar el avance
sin producir requests al proveedor, lea `/api/health` y
`/api/diagnostics/outright/20540377`. El ticket 217525 aún debe confirmar si el
formato corregido produce mercados reales, el significado del Header/Body:null
si persiste, cobertura y publicación de odds, y un reenvío si corresponde. No se
crean ni cancelan suscripciones, incluidas suscripciones pagas.

### Mercado 160 con status 3 y nueve cuotas almacenadas

El enum oficial `MarketStatus` define `Open=1`, `Suspended=2`, `Settled=3`,
`Closed=4`. Por tanto, `market160.status: 3` significa **mercado liquidado**.
Nueve selecciones con precio válido y cero habilitadas son coherentes con ese
estado: `Market.Status` debe ser 1 para permitir seleccionar. Conservar precios
históricos no autoriza volver a abrir el mercado.

Los contadores de tipos 41/42 y `pricedSelections: 9` demuestran recepción de
mensajes y precios; no indican que el mercado siga abierto. El tipo 42 representa
liquidaciones. `snapshotMarketUpdates` acumula entradas de mercado recuperadas,
no necesariamente cantidad de requests ni carreras distintas.

**No confundir dominios:**
- `MarketStatus=3`: mercado liquidado.
- `BetStatusId=3`: selección liquidada.
- `SettlementType=3`: reembolso, no un estado de apertura.
- `FixtureStatus=3`: evento finalizado.

Un mercado liquidado no prueba por sí solo que hayamos recibido Fixture.Status=3.
El diagnóstico por fixture agrega `fixtureStatus` / `fixtureStatusLabel` y, para
el mercado 160, `statusLabel`, `selectionStatusCounts`, `settlementCounts` y
`blockedReasonCounts`. `market_settled: 9` identifica el bloqueo de las nueve
selecciones por el mercado. Otros motivos distinguen selección no abierta,
liquidación, evento inactivo, precio inválido, conexión y espera de actualización
tras restaurar. Las razones son acumulables; no se deduce un ganador del precio.

La interfaz muestra `Mercado liquidado`, conserva las selecciones deshabilitadas
y bloquea un billete que ya las contenía. El tooltip indica liquidación, en lugar
de sugerir únicamente suspensión. La prueba de navegador verifica el cambio
abierto → tipo 42 → liquidado y que no pueda simularse el billete previo.
No se fuerza Status=1 ni se elimina el estado de liquidación.

Fuentes oficiales:
- https://github.com/lsportsltd/trade360-nodejs-sdk/blob/ece873dfc9040e431662bc27e7c2bf8cbd519811/src/entities/core-entities/market/market-status.ts
- https://github.com/lsportsltd/trade360-nodejs-sdk/blob/ece873dfc9040e431662bc27e7c2bf8cbd519811/src/entities/core-entities/enums/fixture-status.ts
- https://github.com/lsportsltd/trade360-nodejs-sdk/blob/ece873dfc9040e431662bc27e7c2bf8cbd519811/src/entities/core-entities/enums/settlement-type.ts

### Buscar un evento abierto con los datos ya recibidos

El endpoint siguiente lee únicamente la proyección local. No genera HTTP a LSports,
no consume la cola, no altera suscripciones y no afecta retryAt:

```bash
curl -sS 'http://localhost:3001/api/diagnostics/open-events?sport=hipica'
# Si no hay Hípica abierta, revisar otros deportes ya recibidos:
curl -sS 'http://localhost:3001/api/diagnostics/open-events?sport=all'
```

Solo devuelve candidatos del modo conectado, con fixture activo (1/2/9), evento
habilitado, mercado abierto (1) y selecciones con `available: true` y precio válido.
Excluye liquidaciones, suspensiones, fixtures finalizados, precios no confirmados
tras restaurar y datos demo. La protección de caducidad de la API sigue vigente.
`candidates_available` identifica candidatos en la proyección actual;
`no_selectable_events_in_current_projection` no afirma que no existan eventos
abiertos en el proveedor. La disponibilidad puede cambiar entre la consulta y el clic.

Para validar en el Mac, elija un candidato, abra `/sportsbook`, seleccione su
 deporte/pestaña y búsquelo por título. Seleccione una cuota y compruebe el billete
simulado. Si cambia el precio, acepte la actualización; si cambia el estado, el
billete debe bloquearse. No se requiere movimiento de dinero ni nueva suscripción.
El diagnóstico `/api/diagnostics/outright/20540377` permite confirmar por separado
si llegó el estado final del fixture ya liquidado.

Este workspace no tiene el checkpoint ni las credenciales del Mac: no se afirma
haber localizado o seleccionado aquí un evento abierto real. La validación real
pendiente debe usar un candidato de esas lecturas locales. Si no hay ninguno,
conserve el feed activo y respete el próximo retryAt; solicite en el ticket 217525
un fixture **aún activo** con mercado 160 abierto y cuotas publicadas dentro de
las suscripciones actuales, sin crear una suscripción paga ni reabrir una carrera
liquidada. Las pruebas automatizadas son sintéticas y permanecen aisladas.

### Explicar `observedEvents: 14` con `candidates: []`

La consulta local `/api/diagnostics/open-events?sport=all` conserva exactamente
el predicado de candidatos y agrega `exclusions` sin consultar a LSports:

- `exclusions.summary`: total observado tras el filtro `sport`, candidatos,
  excluidos, histogramas de estados de fixtures/mercados y `reasons`.
- Cada motivo en `summary.reasons` contiene `reason`, `eventCount` y hasta tres
  ejemplos con `eventId`, `fixtureId`, `competitionId` y feed de origen.
- `exclusions.excludedEvents`: detalle de **todos** los eventos excluidos, con IDs,
  deporte, estado del fixture, disponibilidad, si existía el campo `markets` y
  conteos de mercados, mercados abiertos, selecciones y precios válidos.
- Cada mercado detalla `marketId`, estado/etiqueta, conteos de selecciones/precios,
  flags de disponibilidad (true/false/missing), estados y liquidaciones de las
  selecciones, motivos de bloqueo ya informados y ejemplos de IDs de selección.

Principales códigos:

| Motivo | Qué demuestra en la proyección actual |
|---|---|
| `fixture_not_active` / `fixture_status_missing` | El status no es 1/2/9 o no está informado. |
| `event_not_available` / `event_availability_missing` | El evento no tiene `available: true`, requerido por el filtro existente. |
| `markets_missing` | No hay mercados en el campo leído; `marketsField` distingue campo ausente de array vacío. |
| `primary_selections_without_markets` | Hay selecciones en el campo principal, pero no un array de mercados utilizable por el predicado existente; revisar formato de proyección. |
| `no_open_markets` | Ningún mercado tiene status 1; el histograma distingue liquidado (3), suspendido (2), cerrado (4) y estado ausente. |
| `selections_missing` | Los mercados observados no contienen selecciones. |
| `no_valid_prices` | Hay selecciones, pero ningún precio finito mayor que 1. |
| `open_markets_without_selections` | Los mercados abiertos no tienen selecciones, aunque otros mercados podrían tenerlas. |
| `open_markets_without_valid_prices` | Las selecciones de mercados abiertos no tienen precios válidos. |
| `open_markets_without_selectable_selections` | Hay precio válido en mercado abierto, pero ninguna selección satisface los flags/precio del predicado existente. |
| `selection_availability_missing` | Falta el flag explícito de una o más selecciones; no se asume true. |
| `projection_inconsistency` | Flags de disponibilidad contradicen estados, liquidaciones, precio o motivos informados; revisar los IDs en `markets[].inconsistencies`. No es por sí solo una prueba del origen del error. |
| `candidate_filter_inconsistency` | Una fila excluida satisface el predicado anterior; se informa para investigación sin modificar el resultado. |

`selectionBlockingReasonCounts` conserva los motivos recibidos de la proyección
(por ejemplo, `awaiting_update`, `market_settled`, `feed_disconnected`).
`not_reported_by_projection` significa que la selección está bloqueada o sin flag,
pero no trae una razón detallada; no se inventa una causa. Los ejemplos están en
`markets[].examples.byBlockingReason`, además de los IDs de selecciones bloqueadas
y de precios inválidos/ausentes.

Los motivos se pueden acumular: **no sume los eventCount de motivos diferentes**
para obtener el total. Los histogramas del resumen se refieren a eventos excluidos.
El precio normalizado cero/inválido no permite distinguir por sí solo si el
payload original omitía el precio o lo enviaba así. Esta respuesta explica los
datos cargados; no reconstruye mensajes crudos ni fuerza estados.

Para complementar el ticket 217525, adjunte el resumen y un evento/mercado ejemplo
por motivo relevante. Ejecute solamente la lectura local:

```bash
curl -sS 'http://localhost:3001/api/diagnostics/open-events?sport=all'
```

No llama al SDK, no reinicia recuperación, no modifica la agenda/retryAt ni escribe
el checkpoint. Un test HTTP con 14 eventos sintéticos excluidos comprueba IDs,
conteos, datos ausentes, estados, precios y bloqueos. También comprueba que una
fila que el predicado anterior aceptaba sigue siendo candidata: las advertencias
diagnósticas no se usan como nuevos filtros. No se afirma haber inspeccionado los
14 eventos reales del Mac desde este workspace.

### Resultados individuales de selecciones Outright

`GET /api/diagnostics/outright/:fixtureId` agrega `matches[].markets`, generado
con los datos ya almacenados en TradeState y preservados por el checkpoint.
No consulta al proveedor ni cambia disponibilidad, suscripciones o simulación.
No requiere otra actualización de mercado para exponer una liquidación ya guardada.
Los feeds/competiciones conservan matches separados, incluso si una fila todavía
no tiene metadatos de fixture o no aparece en la lista visible del sportsbook.

Cada mercado incluye `id` (ID original del proveedor), `name`, `status`,
`statusLabel` y `selections`. Cada selección incluye:

- `id`: ID del proveedor como string, sin pérdida de precisión.
- `name`: nombre original de la selección, o el nombre del participante si existe
  un vínculo explícito por `ParticipantId`. `nameSource` indica el origen.
- `participantId` y `participantName`: permiten ubicar el caballo aunque el nombre
  de la selección sea diferente. No se vinculan participantes por posición ni odds.
- `status`: estado efectivo (`BetStatusId` si existe, si no `Status`).
  `providerStatus` conserva `Status` y `betStatusId` conserva ese campo por separado.
- `settlement`: código original; `null` si no fue informado. No se sustituye por 0.
- `resultKnown`: si el código es reconocido por `SettlementType` del SDK instalado.
- `resultDescription`: descripción del mapeamiento existente, o indicación explícita
  de código desconocido / liquidación no informada. No se infiere a partir de precio,
  nombre, orden de llegada ni status general del mercado.

Mapeo confirmado por el enum oficial del SDK y los labels existentes:

| Settlement | SDK | Descripción |
|---|---|---|
| -1 | Cancelled | Cancelada |
| 0 | NotSettled | Sin liquidar |
| 1 | Loser | Perdedora |
| 2 | Winner | Ganadora |
| 3 | Refund | Reembolso |
| 4 | HalfLost | Media pérdida |
| 5 | HalfWon | Media ganancia |

Los nombres ausentes permanecen `null` si no hay un vínculo explícito utilizable.
Los códigos desconocidos se conservan y no se interpretan. `status: 3` no sustituye
el código de settlement: status de mercado/selección y resultado tienen dominios
separados.

Para el caso del fixture 20540195, mercado 160, el histograma `{"1":9,"2":1}`
identifica nueve perdedoras y una ganadora, pero no revela sus identidades. Tras
actualizar y reiniciar conservando `.runtime`, lea solo la API local:

```bash
curl -sS http://localhost:3001/api/diagnostics/outright/20540195
```

En cada match, localice `markets[].id: 160`. La selección con `settlement: 2`
contiene el nombre/ID de la ganadora. Para Vegas Vickie, busque tanto `name` como
`participantName` y lea su `settlement` / `resultDescription`. Estos son resultados
almacenados del proveedor; no una adjudicación de dinero ni apuesta real.

La prueba HTTP usa una muestra **sintética** con nueve códigos 1 y un código 2,
checkpoint/restauración y dos feeds separados. El resultado asignado a Vegas Vickie
en esa prueba es deliberadamente sintético y **no representa el resultado real**
del fixture. Sin acceso al checkpoint del Mac, no se declara aquí el nombre de la
ganadora real ni el resultado real de Vegas Vickie. No se hicieron nuevas consultas
al proveedor para esta validación.

### Odds Outright após reinício: confirmação pelo snapshot

O checkpoint preserva os participantes, mercados e odds, mas não confirma que as odds continuam disponíveis. Cada reinício começa com as seleções restauradas bloqueadas. A recuperação atual confirma uma seleção quando o snapshot de mercados retorna **explicitamente uma odd válida** e sua versão `LastUpdate` é igual ou posterior à armazenada. O mesmo `LastUpdate` significa que o preço não mudou; não é motivo para rejeitar uma confirmação recebida no snapshot atual. Versões anteriores continuam ignoradas. Uma atualização AMQP de preço mais recente também confirma a seleção; mensagem apenas de status, heartbeat ou fixture não confirma uma odd lida do disco.

Seleções ausentes, sem preço válido ou recebidas com versão anterior permanecem bloqueadas se ainda não tiveram confirmação nesta sessão. Nenhum resultado vazio, HTTP 429, `Body:null` ou checkpoint antigo habilita odds. Conexão, fixture, mercado, status da seleção e settlement continuam sendo verificados mesmo após confirmar a cotação. Os limites, `retryAt`, assinaturas e filas permanecem os mesmos.

Para comparar os dados recebidos com a API no Mac, após atualizar/reiniciar e aguardar a recuperação permitida pelo `retryAt`, abra:

```
http://localhost:3001/api/diagnostics/outright/20540564
```

Em `matches[].markets[]` encontre o mercado `id:160`. Cada seleção inclui `odds`, `available`, `unavailableReasons` e `quoteRecovery`:

- `awaitingFreshQuote:true`: a cotação restaurada ainda não foi confirmada.
- `snapshotSeen`: essa seleção foi observada em um snapshot **nesta sessão**. Não se restaura essa evidência do checkpoint.
- `snapshot.receivedAt` e `versionAt`: recebimento da observação e versão usada para ordenação (`LastUpdate`, ou instante da consulta quando ausente). Compare também `lastMarketSnapshotAt` e o diagnóstico de recuperação da conexão; uma observação anterior não afirma que o último snapshot incluiu a seleção.
- `snapshot.receivedPrice`: preço individual recebido, sem payload completo ou credenciais.
- `snapshot.decision:"confirmed"`: preço explícito válido, versão igual ou mais recente; consulte `available` e os motivos para outros bloqueios.
- `older_than_stored`: snapshot anterior à versão já salva; não substituiu a odd.
- `missing_or_invalid_price`: o snapshot incluiu a seleção sem uma odd válida; não confirmou o preço salvo.

Se o snapshot inclui dez preços válidos de versão igual, as dez cotações devem ser confirmadas; se somente uma seleção está presente, as nove ausentes permanecem protegidas. Consulte também `/api/events`: IDs, odds e disponibilidade devem coincidir com o diagnóstico. Não apague `.runtime`, SQLite ou arquivos de cooldown e não execute `diagnose:trade` repetidamente para antecipar a recuperação.

A regressão automatizada usa apenas um servidor HTTP local e amostras explicitamente sintéticas em diretório temporário: SDK oficial → restauração de checkpoint → uma atualização AMQP → snapshot com dez preços inalterados → API HTTP com dez seleções habilitadas → segundo reinício/snapshot parcial → apenas a seleção confirmada habilitada. Também verifica snapshot vazio/anterior, mensagem sem preço, suspensão, liquidação, conexão e preservação integral de um bilhete de teste já registrado. Isso não comprova o conteúdo do snapshot real de Madrid no Mac.

### Mensagem 39: placar Outright, sem liquidação implícita

O consumidor trata `OutrightScoreUpdate` (39) pelo contrato e pelo conversor do SDK oficial instalado. Referências oficiais:

- [OutrightScoreUpdate e EntityKey(39)](https://github.com/lsportsltd/trade360-nodejs-sdk/blob/main/src/entities/message-types/outright-score-update.ts)
- [OutrightScoreEvent](https://github.com/lsportsltd/trade360-nodejs-sdk/blob/main/src/entities/core-entities/outright-sport/outright-score-event.ts)
- [OutrightScore](https://github.com/lsportsltd/trade360-nodejs-sdk/blob/main/src/entities/core-entities/outright-sport/outright-score.ts)
- [ParticipantResult](https://github.com/lsportsltd/trade360-nodejs-sdk/blob/main/src/entities/core-entities/outright-sport/participant-result.ts)
- [OutrightScoreStatus](https://github.com/lsportsltd/trade360-nodejs-sdk/blob/main/src/entities/core-entities/enums/outright-score-status.ts)

O envelope contém `Body.Competition` (`Id`, `Events`), cada evento tem `FixtureId` e `OutrightScore`. O placar contém `Status` e/ou `ParticipantResults`, com `ParticipantId`, `Name` e `Result`. Todos são preservados nos campos correspondentes, sem converter `Result` em settlement ou deduzir seu significado. `Status` usa o enum específico do placar (`Unknown=0`, `Pending=1`, `InProgress=2`, `Completed=3`), **não** o enum de mercados, fixtures ou settlements. Códigos novos de status são preservados com `statusName:"Unrecognized"`.

O placar é armazenado separadamente por competição/fixture e timestamp, sem modificar participantes do fixture, preço, estado de mercado ou resultado de bilhete. Atualizações antigas não substituem a versão mais recente. Campos omitidos preservam o valor anterior; quando `ParticipantResults` está presente, armazena-se o array recebido (inclusive vazio). Um placar recebido antes do fixture também é preservado e fica acessível no diagnóstico, aguardando os metadados, sem inventar participantes/mercados. O checkpoint existente continua compatível: o campo adicional é opcional e não exige apagar ou migrar manualmente `.runtime`.

`GET /api/diagnostics/outright/20540564` agora pode mostrar `matches[].outrightScore` com `updatedAt`, `status`, `statusName` e `participantResults`. `/api/events` expõe o mesmo placar em `events[].outrightScore` quando o fixture está publicado. Os logs apenas mostram metadados seguros, incluindo tipo 39, quantidade de eventos e `participantResultCount`, sem publicar o payload completo.

O ACK ocorre somente depois da gravação do checkpoint e da reconciliação persistente dos bilhetes. Mensagem redeliverada válida é processada; duplicatas são reconhecidas após persistência. Erros de formato ou de escrita continuam sem ACK, solicitando requeue. Não se cria fila, não se altera assinatura e não se descarta o tipo 39 para destravar o consumo.

Após atualizar, reinicie API/worker (`npm run dev`) para sair do bloqueio anterior com `retryPolicy:restart_required`. A mensagem preservada será entregue novamente. Verifique no log `feed.decode`, `messageType:39`, `status:"ok"` e a recuperação/conexão do PreMatch. Isso não implica odds habilitadas: o placar não confirma preços do checkpoint; a recuperação de mercados continua respeitando `retryAt` e a confirmação individual documentada acima. Sem credenciais/feed do Mac no ambiente cloud, o teste de retomada usa consumidor AMQP simulado, persistência real em diretório temporário e o parser oficial, sem afirmar validação da conexão real.

### Evidência de settlement por seleção (mensagem 42 e snapshot)

Um fixture finalizado, um mercado liquidado ou um vencedor conhecido **não** define o resultado das demais seleções. O bilhete continua pendente até chegar um código explícito para seu próprio ID de seleção. O campo `ParticipantResults.Result` do placar 39 não é settlement. A odd aceita do bilhete não é recalculada a partir de odds posteriores.

A inspeção usa `BaseBet.Settlement` do SDK oficial tanto para `OutrightSettlementsUpdate` (42) como para o snapshot convertido por `OutrightFixtureMarketUpdate`. Compara a resposta JSON com a entidade convertida: quantidade, IDs e valor numérico de settlement devem coincidir. Perda de código na conversão falha antes de aplicar/ACK; não se trata uma conversão incompleta como sucesso. Dados específicos de `ProviderMarkets[].Bets[]` são contados separadamente; não são promovidos arbitrariamente ao resultado recomendado da seleção.

Foi corrigida uma falha local reproduzível: um campo `Settlement:null` posterior podia apagar um código numérico da projeção. Agora campo ausente/null preserva o último código explícito; uma correção para não liquidado exige código numérico `0`. A proteção de ordenação temporal continua ativa. Isso não comprova que os sete códigos de Madrid tenham chegado: os dados anteriores à implantação não possuem essa auditoria e não podem ser reconstruídos por inferência.

Após atualizar/reiniciar normalmente, respeitando o cooldown/retryAt existente, consulte apenas dados locais:

```
GET http://localhost:3001/api/diagnostics/outright/20540564
GET http://localhost:3001/api/tickets/cd4196d2-45be-4870-acad-c0289f549ff7
```

No primeiro endpoint, em `matches[].markets[]` para mercado `160`:

- `settlementEvidence` contém a última contagem recebida por origem: `amqp.41`, `amqp.42` e `snapshot.outright.markets`. Inclui `receivedAt`, `rootBets`, `rootNumeric`, `rootNull`, `rootMissing`, `providerBets`, `providerNumeric`. As contagens são da resposta/mensagem individual, não o total acumulado da projeção.
- Cada seleção contém `settlementTrace.last42`, `last41`, `lastSnapshot` e, se já houve código numérico observado após a atualização, `lastNumeric`. Registra `receivedAt`, `versionAt`, `field` (`missing`, `null`, `integer`), `code` original e `decision` (`stored`, `ignored_missing`, `ignored_null`, `ignored_older`). Ausência de observação significa **sem evidência gravada**, não prova de que o fornecedor nunca enviou o resultado. Quando uma resposta omite uma seleção, sua observação anterior permanece com a data original; compare as datas com `settlementEvidence`.
- `integer`/`stored` e settlement armazenado igual ao código mostram recebimento, conversão e armazenamento completos. Se o bilhete correspondente continuar pendente após `GET /api/tickets/:id`, compare seu `mode`, `eventId`, `marketId` e `selectionId` com os IDs da projeção: isso exige investigar o vínculo local, não presumir ausência do fornecedor. Os IDs públicos completos usam prefixo `prematch:outright:<competitionId>:<fixtureId>:<marketId>:<betId>`; a seleção no diagnóstico mostra o `<betId>` original.
- `integer`/`ignored_older` mostra um código recebido e rejeitado pela proteção de versão. Preserve código, versões e timestamps para investigar a ordem das mensagens; não force um resultado antigo.
- `null` ou `missing` em uma observação recente mostra que aquela resposta individual não forneceu código numérico para essa seleção. `providerNumeric>0` com ausência no nível principal mostra resultados apenas no bloco específico de provider; não autoriza inferir o código recomendado.

A evidência é persistida no checkpoint, sem payloads completos ou credenciais. É adicional e opcional em checkpoints anteriores; não apague `.runtime` nem o SQLite. Não há novas consultas, assinaturas ou alteração de limites: a inspeção acompanha o processamento normal. Não reinicie repetidamente para tentar antecipar consultas.

Se a evidência recente confirmar ausência de códigos, complementar o chamado LSports 217525 com: ambiente **Test**, pacote **PreMatch 4511**, fixture **20540564**, competitionId observado, mercado **Race Winner 160**, IDs originais de Bet/Participant das sete seleções (incluindo Green Hussar), timestamps UTC e contagens por origem. Informar que Sibarita recebeu `Settlement:2`, Napoles/Darro `Settlement:1`, enquanto as sete restantes vieram sem código (distinguir campo omitido de null). Anexar somente o trecho sanitizado desses campos e das observações; não enviar `.env`, senhas, URLs autenticadas ou payload completo.

Solicitação concreta: "Confirmem a liquidação das sete seleções do mercado 160 e reenviem os códigos explícitos de Settlement pelos respectivos Bet IDs na mensagem OutrightSettlementsUpdate (42), ou disponibilizem-nos no snapshot `/Prematch/GetOutrightFixtureMarkets` com `packageId:4511` e `fixtures:[20540564]`. Confirmem se há settlement apenas em ProviderMarkets e qual resultado recomendado deveria ser publicado no nível principal. Não solicitamos novas assinaturas." Se a evidência indicar `ignored_older`, pedir também confirmação de `LastUpdate` e ordenação para esses Bet IDs. Sem observações recentes, não é possível atribuir a falta ao fornecedor só pelo `settlement:null` da projeção.

### Ordenação de LastUpdate e diferença de três horas

AMQP Outright e snapshot passam pelo mesmo `TransformerUtil`/`@Type(() => Date)` do SDK. Não existe ajuste de três horas entre esses dois caminhos na aplicação. Reproduzimos no SDK oficial com processos Node independentes:

| Valor bruto | Processo UTC | Processo America/Sao_Paulo |
| --- | --- | --- |
| `2026-10-18T14:02:17.025Z` | `14:02:17.025Z` | `14:02:17.025Z` |
| `2026-10-18T14:02:17.025-03:00` | `17:02:17.025Z` | `17:02:17.025Z` |
| `2026-10-18T14:02:17.025` (sem zona) | `14:02:17.025Z` | `17:02:17.025Z` |

Portanto, a dupla normalizada `14:02Z`/`17:02Z` não identifica sozinha a causa. Pode ser diferença real entre valores com offset explícito, string sem fuso interpretada pelo horário local do Node, ou uso de fontes de versão diferentes quando `LastUpdate` não veio. Não subtraímos três horas, não presumimos que uma data sem zona seja UTC e não mudamos o `TZ` do Mac.

Cada nova `settlementTrace.last41.timestamp`, `last42.timestamp` ou `lastSnapshot.timestamp` registra:

- `rawLastUpdate` e `rawType`: apenas data ISO reconhecida/número ou null; conteúdo arbitrário é omitido. `rawType:missing` é distinto de null.
- `timezone`: `explicit`, `absent`, `missing`, `epoch_milliseconds` ou `invalid`.
- `sdkUtc`: conversão efetivamente produzida pelo SDK.
- `normalizedUtc`: instante definido por zona explícita/epoch; fica null quando a zona está ausente. Não é uma correção por offset.
- `hostTimezone` e `hostOffsetMinutes`: ambiente do processo e offset na data convertida (inclusive DST).
- `wallClockToSdkDeltaMinutes`: diferença diagnóstica entre os números do relógio sem zona e a conversão SDK. Nunca é usada como ajuste do dado.
- `orderingSafe`, `orderingSource`: indica se a versão é inequívoca; na ausência de LastUpdate, indica fallback para timestamp do envelope ou início da consulta, conforme a origem já mostrada na observação.

Datas explícitas devem representar exatamente o mesmo instante no SDK. Strings sem fuso, valores inválidos ou conversão divergente geram diagnóstico **antes de aplicar os mercados**. No snapshot isso deixa a recuperação parcial, preserva os dados existentes e não confirma odds antigas. No AMQP a mensagem não é ACKada e permanece para reprocessamento via requeue; o feed pode pausar com `restart_required`, sem descarte. O erro traz `reason:ambiguous_timestamp`/`invalid_timestamp` e `timestampInspection` sanitizado na conexão/recuperação Outright. Timestamps textuais do envelope usados como fallback também precisam declarar zona; epoch do transporte continua aceito. Não são feitas novas consultas nem alterados limites/cooldowns.

**Limite da validação histórica:** checkpoints que já gravaram um `Date` convertido perderam a grafia original. Um `17:02Z` salvo pode ser um instante legítimo ou a interpretação local de `14:02` sem zona; não é seguro reduzir essa versão automaticamente. Nenhum checkpoint ou resultado de bilhete é reescrito por essa proteção. Se uma versão adiantada já persistida continuar fazendo uma mensagem UTC posterior parecer antiga, a auditoria mostrará `ignored_older`; precisamos comparar os valores brutos antes de corrigir o legado. Este ajuste previne novas versões ambíguas, mas não comprova nem repara por inferência o histórico do Mac.

No caso Parislongchamp 20545283 / Sangomar, depois da atualização/reinício normal, abra `/api/diagnostics/outright/20545283` e compare as observações `last41` e `lastSnapshot`, suas datas `receivedAt`, `versionAt` e o bloco `timestamp`. Se o snapshot for rejeitado, veja `connections.prematch.outrightRecovery.diagnostics[].timestampInspection` (ou o diagnóstico do feed em caso AMQP). Não altere `.env`, não apague `.runtime`, não force consultas antecipadas e não use `TZ=UTC` como correção sem confirmar a semântica do fornecedor. Anotações anteriores à atualização não possuem o valor bruto e não permitem reconstruí-lo.

Se `timezone:absent`, solicitar à LSports o fuso contratual de `Bets[].LastUpdate` no AMQP 41/42 e no endpoint `/Prematch/GetOutrightFixtureMarkets`, idealmente com emissão consistente de `Z` ou offset explícito. Informar pacote Test 4511, fixture 20545283, mercado 160, Bet ID de Sangomar e os campos sanitizados acima. Se ambos forem explícitos e representarem instantes diferentes, pedir explicação da diferença nos valores emitidos; não convertê-los artificialmente para o mesmo instante.

Os testes executam o SDK real sob UTC, America/Sao_Paulo e Europe/Berlin: igualdade entre timestamps equivalentes com offsets diferentes; snapshot antigo sem substituir uma odd recente; AMQP com versão posterior aceito; snapshot ambíguo sem alterar a odd; diagnóstico HTTP 200 não tratado como recuperação válida; e requeue para versão ambígua AMQP. São amostras isoladas, sem acesso ao feed ou aos arquivos do Mac.

### Lotes parcialmente ambíguos e preparação segura do legado

**Contrato ainda pendente:** em 18/10/2026, a leitura de `docs.lsports.eu` neste ambiente retornou HTTP 403. O código público oficial [BaseBet](https://github.com/lsportsltd/trade360-nodejs-sdk/blob/main/src/entities/core-entities/market/base-bet.ts) expõe `LastUpdate` com `@Type(() => Date)` e não declara a zona de uma string sem offset. Logo, o SDK não confirma que `2026-10-18T00:19:34.10384` HTTP seja UTC. Não foi acrescentado `Z`, subtraído um offset, alterado `TZ` ou presumida semântica contratual. Solicitar à LSports confirmação específica para `Bets[].LastUpdate` HTTP e AMQP, incluindo o formato com cinco/sete casas decimais, e emissão com offset explícito. O trecho da documentação ou resposta do suporte é necessário antes de normalizar essas strings.

A rejeição anterior abortava todo o lote HTTP no primeiro item ambíguo. Agora cada Bet ambíguo é isolado; os demais fixtures/mercados/seleções com versões inequívocas são processados. A recuperação informa `status:partial` e não considera o lote totalmente recuperado. `connections.prematch.outrightRecovery.timestampRejections[]` identifica cada item com `context.{competitionId,fixtureId,marketId,selectionId}` e a inspeção sanitizada da data. O mesmo registro aparece em `matches[].markets[].timestampRejections` no diagnóstico individual. O Bet convertido e seu timestamp bruto permanecem em quarentena **privada no checkpoint**, sem aplicação da odd ou settlement, sem perda do item. Se já havia uma seleção carregada, ela fica bloqueada com `ambiguous_snapshot_timestamp` até uma atualização válida. Mensagens AMQP ambíguas continuam preservadas na fila por requeue; não são parcialmente ACKadas.

#### Preparar apenas as versões históricas comprovadamente futuras

O comando abaixo **não normaliza HTTP sem fuso**. Ele prepara uma quarentena seletiva do índice de versões, para permitir que cotações AMQP explícitas recentes substituam versões históricas incompatíveis. Cada candidato deve satisfazer todas as condições:

- Está no fixture/mercado explicitamente solicitados e não tem settlement numérico terminal; resultados conhecidos não são reescritos.
- A versão ainda armazenada coincide exatamente com a observação histórica do snapshot, não possui confirmação de interpretação inequívoca e estava mais de cinco minutos no futuro em relação ao início daquela própria consulta HTTP.
- Existe observação individual AMQP 41 posterior à consulta, com zona explícita, conversão SDK verificada, versão anterior ao índice futuro e horário coerente com seu envelope. Deve ter sido observada nos últimos quinze minutos. Os limites de cinco/quinze minutos são políticas conservadoras locais, não regras declaradas pela LSports. A falta de settlement nessa mensagem não impede comprovar a versão da cotação.
- Não foi preparada anteriormente. IDs sem prova suficiente são listados em `excluded`, sem alteração. Não existe seleção por nome, diferença fixa de três horas, atualização global ou aceitação automática de timestamp menor.

Pare **API e worker** com Ctrl+C imediatamente antes de atualizar/aplicar, para manter as observações recentes. Use Node >=22.13 (Node 24 recomendado). No Mac:

```bash
cd ~/LSports
git switch feat/sportsbook-demo
git pull --ff-only origin feat/sportsbook-demo
npm ci
npm run build
npm run recover:timestamps -- --fixture 20545283 --market 160
```

O último comando é **dry-run**, não escreve dados. Confira `candidates` e `excluded`. Se não houver candidatos, não há reparo automático autorizado pelos dados: reinicie normalmente para obter novas observações AMQP, depois pare e repita o dry-run. Não altere arquivos, timestamps ou cooldowns para forçar elegibilidade. Se o próprio snapshot não for futuro em relação à sua consulta, precisamos da evidência adicional/contrato do fornecedor antes de fazer outro tipo de recuperação.

Para preparar exatamente os candidatos elegíveis, com API/worker ainda parados:

```bash
npm run recover:timestamps -- --fixture 20545283 --market 160 --apply
npm run dev
```

`--apply` verifica o lock do worker e se a porta local da API está ocupada; adquire seu próprio lock exclusivo e nunca remove um lock pré-existente. A função faz backup do checkpoint original e uma cópia consistente do SQLite com `VACUUM INTO`, inclusive dados do WAL, em um novo diretório `timestamp-recovery-<UUID>` ao lado do checkpoint. Verifica o fingerprint de **todos** os bilhetes antes/depois da cópia. O arquivo `audit.json` registra IDs, versão anterior, baseline AMQP comprovada, hashes antes/depois e fingerprint dos bilhetes. Em falha antes da substituição atômica, o checkpoint não é sobrescrito e o backup é mantido. O procedimento não consulta o fornecedor, não altera `.env`, assinaturas, fila, cooldowns ou arquivos de snapshot anteriores.

A versão contaminada é preservada em `timestampRecovery.previousVersion` e no backup; apenas o índice de ordenação das seleções elegíveis passa para a baseline individual AMQP. O preço salvo **continua bloqueado**, mesmo que o mercado esteja aberto. Snapshots/status-only não removem a quarentena. É necessária mensagem AMQP 41 recebida após a preparação, com odd explícita válida, versão com zona explícita verificada, maior que a baseline e não futura em relação ao envelope. Só então o estado passa de `awaiting_fresh_amqp` para `validated_amqp`. Fixture, mercado, status de seleção, conexão e settlement continuam a bloquear normalmente; uma seleção suspensa como Serie não é forçada a abrir.

Na reconciliação seguinte, um índice de resultado **0 (não liquidado)** que coincida exatamente com a versão contaminada também pode ser rebased para a baseline auditada, de forma idempotente. Isso evita que o mesmo índice futuro bloqueie uma liquidação explícita recebida depois. Nenhum resultado terminal, corpo de bilhete, odd aceita, histórico ou pagamento é modificado por esse reparo de metadados. O backup de SQLite preserva ambos os bilhetes existentes; bilhetes só mudam de resultado quando chegam settlements explícitos, usando suas odds aceitas originais.

Valide no Mac: `/api/diagnostics/outright/20545283` deve mostrar os IDs dos rejeitados e `selections[].timestampRecovery` para os candidatos. Antes da nova cotação, `awaiting_timestamp_recovery` é esperado e nenhuma odd antiga deve ficar selecionável. Após uma mensagem recente válida, o status muda para `validated_amqp`, a odd publicada corresponde à nova mensagem e a seleção fica disponível somente se todos os demais estados permitirem. `staleBetUpdates` é acumulado; não é zerado pelo reparo. Confira ambos os bilhetes pelo histórico/ID, preservando odds aceitas. Guarde o diretório de backup/auditoria; não substitua SQLite ou checkpoint com processos em execução.

Os testes isolados cobrem lote de seis fixtures com um item ambíguo (cinco seguem disponíveis), identificação completa do item, persistência da quarentena, dry-run sem mudanças, recusa de lock existente, backup consistente de dois bilhetes, repetição sem novas alterações, bloqueio de preço salvo/status-only, aceitação posterior de AMQP explícito, reinício e liquidação com a odd aceita original (2.6233, mesmo com cotação atual diferente). Não foi executada migração nos arquivos do Mac nem validada conexão real neste ambiente.

#### Reprocessar settlements 42 já recebidos (chamado 217525)

A evidência adicional de Madrid muda o diagnóstico: os sete códigos **foram recebidos**, convertidos e registrados, mas rejeitados pela versão histórica adiantada. Para Green Hussar / Bet ID `3160611920540564`, a observação informada é `last42.versionAt=2026-10-18T14:17:24.015Z`, `receivedAt=2026-10-18T14:17:24.152Z`, código `1`, contra índice histórico de snapshot `16:11:13.230Z`. Não há motivo para aguardar outro resultado do fornecedor se essas observações já estão persistidas e passam pela validação abaixo.

O mesmo comando aceita `--settlements`, **separado da recuperação de cotações**. Usa apenas `settlementAudit.last42` já salvo, com código terminal inteiro, `decision:ignored_older`, `Z`/offset explícito, conversão SDK inequívoca e IDs correspondentes ao mercado/seleção. Valida individualmente a coincidência exata da versão histórica ainda aplicada com a observação do snapshot, que essa versão era futura em relação à consulta, e que não há evidência numérica explícita mais recente contraditória/superveniente. Resultado conhecido/terminal já aplicado não é substituído. Campos ausentes, null, placar, nome do vencedor, código deduzido ou dados de outro Bet ID nunca viram settlement. Diferentemente de odds, um resultado histórico explícito não expira após quinze minutos; datas ainda precisam ser coerentes e não futuras no envelope.

Com API e worker parados e o código atualizado, primeiro examine o plano:

```bash
npm run recover:timestamps -- --fixture 20540564 --market 160 --settlements
```

Confira cada `candidate`: Bet ID, código, versão AMQP, recebimento e índice histórico. Esperam-se os sete códigos `1` se todos possuem prova válida; a ferramenta **não força uma quantidade de sete**. Veja `excluded` quando faltar evidência, houver versão divergente ou resultado mais recente. Não edite o JSON para contornar exclusões.

Para aplicar o plano validado, mantendo os processos parados:

```bash
npm run recover:timestamps -- --fixture 20540564 --market 160 --settlements --apply
```

É criado **outro backup completo e consistente** do checkpoint e do SQLite, com manifesto/hashes e os sete códigos originais no plano, antes da migração. Cada observação elegível é reconstruída como entidade mínima 42 (somente IDs, Settlement e LastUpdate explícitos preservados), passa pelo parser oficial e por `TradeState.apply`, e recebe marca `settlement_replayed`. Não inventa preço/status nem incrementa contadores de mensagens AMQP reais. A migração grava apenas o checkpoint; os corpos dos dois bilhetes continuam idênticos ao backup nesse momento.

Ao executar `npm run dev`, o primeiro save do worker restaura os resultados e chama **a rotina normal `TicketStore.reconcile`**, antes de depender de conexão ou nova mensagem do fornecedor. Também corrige apenas o índice 0/não liquidado que coincida exatamente com a versão histórica auditada; nenhum índice terminal é rebaixado. O bilhete Green Hussar deve passar a `LOST`, retorno simulado `0`, pelo código explícito `1`, mantendo ID, valor e odd aceita **2.6233**. O outro bilhete mantém seu estado salvo, salvo se seus próprios resultados explícitos também forem elegíveis e reprocessados pelo plano correspondente. Nenhum corpo de bilhete é editado manualmente pelo migrador.

Reiniciar/reconsultar não liquida em duplicidade nem aumenta revisão sem novo resultado. Repetir o plano mostra as seleções já preparadas/aplicadas como excluídas, sem nova migração. `--apply` sem candidatos aborta sem reescrever checkpoint ou tickets. O backup e o manifesto permanecem disponíveis para auditoria. Uma falha após preparar o checkpoint e antes de iniciar o worker é recuperável pelo reinício: os marcadores de versão tornam a reconciliação idempotente.

Depois confira o diagnóstico de Madrid (sete settlements `1`, `resultKnown:true`, `timestampRecovery.status:settlement_replayed`) e o bilhete `cd4196d2-45be-4870-acad-c0289f549ff7` pelo endpoint/histórico. A recuperação de Parislongchamp continua sendo o modo de cotações, sem `--settlements`, exigindo preço AMQP novo para abrir seleção; uma migração de resultado não habilita odds antigas. Os testes reproduzem sete resultados antigos rejeitados, Bet ID longo, backup dos dois bilhetes, replay sem nova mensagem, liquidação normal, odds preservadas e repetição sem efeitos adicionais.

### Investigar um `recover:timestamps --apply` abortado

A mensagem genérica anterior ocultava a etapa e a exceção. `pgrep` vazio não identifica uma falha de filesystem/SQLite e não comprova ausência de lock residual ou de outro serviço na porta. Não apague locks ou backups nem repita `--apply` antes de identificar a etapa.

Após atualizar o código, o próximo comando seguro é:

```bash
npm run recover:timestamps -- --inspect
```

Não exige fixture/mercado e **não executa migração, VACUUM, replay, alteração de bilhete ou remoção de locks**. Mostra versão do Node/SQLite, estado da porta configurada, existência e dono do lock (`running`, `not_running`, `invalid`, `unverifiable`), hashes do checkpoint, leitura/fingerprint dos tickets, os vinte backups mais recentes e temporários de recuperação. Examina arquivos existentes; não cria uma base vazia se o SQLite estiver ausente. Não imprime `.env`, corpos dos bilhetes, senha, SQL recebido ou mensagens brutas de exceção.

Para cada backup, `checkpointMatchesBackup`/`audit.checkpointMatchesBefore` indicam se o checkpoint atual corresponde ao anterior; `audit.checkpointMatchesPrepared` identifica se o arquivo preparado já foi substituído. `ticketsMatchBackup`/`ticketsMatchRecordedFingerprint` comparam os **corpos dos bilhetes**, inclusive leitura normal de WAL pelo SQLite, não apenas bytes do arquivo principal. `sqliteInspection` informa falha de abertura/esquema sem vazar conteúdo. Um backup sem `audit.json` pode ser parcial: isso sozinho não prova uma etapa exata da tentativa antiga. Compare os arquivos/hashes; a mensagem genérica antiga não permite reconstruir uma exceção que não foi registrada. `temporaryFiles` lista temporários preservados, sem apagá-los.

Novos abortos exibem JSON sanitizado com `stage`, `reason`, `cause`, `writes`, e, quando criado, `backup`/`auditId`. Códigos conhecidos de filesystem (`ENOENT`, `EACCES`, `EEXIST`, `ENOSPC` etc.) e `sqliteCode`/`sqliteReason` são expostos; a mensagem/stack da exceção nunca é publicada. Exemplos de etapas:

- `api.port_check`: porta ocupada ou estado não verificável; nenhuma aplicação iniciada. Timeout/erro inesperado não é tratado como porta livre.
- `worker.lock_check`/`worker.lock_create`: lock pré-existente ou falha ao adquirir o próprio; um lock externo permanece intacto, mesmo se seu PID não existir.
- `backup.directory`/`backup.checkpoint`: falha de cópia ou diretório. Campos `*Started`/`*Complete` distinguem tentativa de arquivo possivelmente parcial de backup concluído.
- `sqlite.open_readonly`/`sqlite.fingerprint`: base ausente, inacessível ou esquema divergente.
- `sqlite.backup`/`sqlite.backup_verify`: criação/verificação da cópia consistente; `sqliteReason:readonly`, `busy`, `locked`, `cannot_open`, `disk_full` ou `sql_error` ajuda a localizar a causa. Não se remove a proteção read-only por padrão.
- `checkpoint.replay`, `audit.write`, `checkpoint.concurrent_check`, `sqlite.concurrent_check`: replay, auditoria ou detecção de alteração concorrente; a substituição ainda não ocorreu.
- `checkpoint.temp_write`/`checkpoint.replace`: temporário possivelmente parcial ou falha na substituição atômica.
- `worker.lock_cleanup`: pode ocorrer **depois** da migração. Se `writes.checkpointReplaced:true`, não interprete exit code 1 como ausência de alteração; inspecione hashes antes de qualquer repetição.

`writes.ticketBodiesWritten` é sempre false no migrador; a liquidação continua sendo responsabilidade da reconciliação normal. `checkpointReplaced:false` informa que esta tentativa não substituiu o original; backups/temporários podem existir. A limpeza libera apenas o lock criado pela própria execução, verificando inode/dispositivo; não remove lock substituído ou pré-existente. Uma falha na limpeza não mascara a causa original e aparece em `cleanupIssue`.

Para o aborto já ocorrido no Mac, compartilhe apenas o JSON sanitizado de `--inspect`. Não é possível afirmar a causa exata com os dados atuais. O próximo passo de reparo depende desse resultado; nenhuma proteção foi contornada para tentar fazê-lo passar.

### Recuperar um lock com PID comprovadamente encerrado

Um `.lock` existente aborta `--apply` em `worker.lock_check`, antes de qualquer backup; `owner:not_running` não autorizava remoção automática pelo migrador. Portanto, o caso informado (PID 96162 ausente, porta 3001 fechada, dois bilhetes legíveis e nenhum backup) é compatível com esse bloqueio inicial. Não é necessário nem recomendado executar `rm` manualmente.

Com API e worker parados, atualize o código e execute a recuperação específica:

```bash
cd ~/LSports
git switch feat/sportsbook-demo
git pull --ff-only origin feat/sportsbook-demo
npm run build
npm run recover:timestamps -- --inspect
npm run recover:timestamps -- --recover-lock --expected-pid 96162
```

Use `96162` somente se a inspeção atual ainda mostrar esse PID no lock e `owner:not_running`. O comando confirma o conteúdo/PID, verifica o processo com `kill(pid,0)` e recusa PID ativo/reutilizado, erro de permissão, conteúdo inválido, lock alterado ou porta ocupada/não verificável. Um guard exclusivo compartilhado com a inicialização do worker impede início/reclaim concorrente durante a recuperação. Um guard já existente é preservado, sem tentativa de apagá-lo.

**Antes de alterar o lock original**, cria um diretório novo `timestamp-recovery-<UUID>` com:

- `feed.before.json`, cópia verificada do checkpoint;
- `tickets.before.sqlite`, backup consistente via SQLite `VACUUM INTO`, incluindo os dados do WAL; verifica fingerprint de todos os corpos de bilhetes e informa `ticketCount`;
- `worker.lock.before`, cópia original do lock;
- `audit.json`, com operação `archive_verified_dead_worker_lock`, PID esperado, hashes do checkpoint/lock e fingerprint dos bilhetes.

Após o backup, reconfirma PID morto, inode/dispositivo e conteúdo do lock, hash do checkpoint e fingerprint dos bilhetes. Somente então move atomicamente o lock original para `worker.lock.archived` dentro desse mesmo backup. **Não altera checkpoint nem corpos de bilhetes** e não aplica settlements nesta etapa. Retorna `status:stale_lock_archived`, `checkpointModified:false`, `ticketsModified:false`, `writes.staleLockArchived:true` e caminho do backup. Falha em qualquer backup/verificação preserva o lock original e os artefatos criados, com diagnóstico de etapa sanitizado. Não modifica `.env` ou cooldowns.

Confirme a conclusão e os backups:

```bash
npm run recover:timestamps -- --inspect
npm run recover:timestamps -- --fixture 20540564 --market 160 --settlements
```

A inspeção deve mostrar o lock original ausente, dois bilhetes preservados, o backup e sua operação de arquivamento (isso não é uma migração já aplicada). Com candidatos validados no dry-run, mantenha API/worker parados e aplique:

```bash
npm run recover:timestamps -- --fixture 20540564 --market 160 --settlements --apply
npm run dev
```

O `--apply` cria **outro backup completo**, próprio da migração, antes de modificar o checkpoint. Na inicialização, a rotina normal de liquidação reconcilia os resultados explícitos; não é preciso esperar novo envio do fornecedor. Verifique Green Hussar e o segundo bilhete conforme a seção anterior. Se a recuperação do lock falhar ou seu PID tiver mudado, pare nesse diagnóstico; não remova arquivos nem pule a proteção. A recuperação de cotações de Parislongchamp continua sendo um dry-run/aplicação separado, sem `--settlements` e sem liberação de preços salvos.

## Encerramento do worker e reinício sem migração

`npm run dev` inicia o worker diretamente com `node --import tsx`, sem a cadeia adicional `npm → tsx → worker`. O comando separado `npm run dev:worker` usa o mesmo carregador no próprio processo Node. SIGINT (`Ctrl+C`) e SIGTERM acionam um único cancelamento, inclusive se o terminal e o supervisor repetirem o sinal.

O worker interrompe entregas, aguarda o processamento/gravação em andamento, fecha a conexão AMQP uma única vez, publica os feeds como `stopped`, reconcilia os bilhetes pela rotina normal, fecha SQLite e só então libera seu lock. Mensagens não confirmadas continuam na fila existente. Um sinal recebido enquanto a conexão AMQP ainda está abrindo também fecha a conexão assim que ela retorna; não inicia consumo nem recuperação HTTP depois disso.

A liberação confere PID, inode e dispositivo do arquivo, sob o mesmo guard usado pela recuperação offline. Se outro arquivo/owner ocupou o caminho, ele é preservado. A inicialização recusa qualquer lock existente: não apaga automaticamente locks antigos nem os de um segundo worker.

Atualização normal no Mac, sem executar novamente a migração de timestamps:

```sh
# No terminal que executa a aplicação: Ctrl+C e aguarde o encerramento.
cd ~/LSports
git switch feat/sportsbook-demo
git pull --ff-only origin feat/sportsbook-demo
npm ci
npm run build
npm test
npm run dev
```

Para validar: confira o histórico e as odds aceitas dos dois bilhetes; pressione `Ctrl+C`; aguarde `{"operation":"worker.shutdown","status":"ok","lock":"released"}`; execute `npm run dev` novamente e confira os mesmos bilhetes. Não execute dois workers para testar sobre dados reais. A suíte usa diretórios temporários, dois bilhetes sintéticos já liquidados e processos reais com SIGINT/SIGTERM, tanto diretamente como sob npm/concurrently. Não consulta a LSports.

Se a versão **anterior** deixar um lock na primeira parada, mantenha API/worker parados e use apenas `npm run recover:timestamps -- --inspect`. Somente se o relatório confirmar API fechada e `lock.owner:"not_running"`, use `npm run recover:timestamps -- --recover-lock --expected-pid PID_DO_INSPECT`. Esse comando verifica novamente o owner, cria backups e arquiva o lock; **não aplica a migração de timestamps**. Não reutilize um PID antigo nem apague arquivos `.lock`/`.reclaim` manualmente. Backups, checkpoint e bilhetes existentes são preservados.

SIGKILL, queda de energia ou encerramento forçado do terminal não permitem executar handlers; um lock residual nesses casos requer a recuperação offline verificada. A rejeição dos timestamps HTTP sem timezone continua vigente; nenhuma conversão UTC ou deslocamento fixo foi introduzido.

## Contrato UTC confirmado — ticket #217525

**Fonte:** confirmação escrita da LSports, por **Szymon Luka**, comunicada pelo
operador em **18/10/2026**: todos os timestamps HTTP e AMQP são UTC, com ou sem
sufixo Z. Esta é a evidência contratual que faltava; não é inferência a partir
do SDK nem um teste novo com a conta do fornecedor.

O adaptador passa a acrescentar Z **somente a datas válidas sem fuso**, antes de
qualquer conversão Date do SDK. Offsets explícitos são preservados e continuam
representando seu instante original. Datas inválidas, inclusive calendários
impossíveis, continuam rejeitadas. Campos ausentes mantêm a política existente de
fallback para envelope/início de snapshot; ausência de valor não é convertida
em “agora” arbitrariamente. As requisições HTTP, assinaturas e Retry-After não mudam.

`2026-10-18T14:39:04.0173136` e `2026-10-18T14:39:04.0173136Z` passam a ter a mesma
versão UTC e a mesma chave inteira de ordenação, independentemente de TZ.
A conversão JS/SDK mantém milissegundos para exibição, mas o adaptador conserva
até nove casas decimais em uma chave de nanossegundos inteira, persistida junto
ao índice de versões de seleções. Isso permite rejeitar atualizações antigas
mesmo quando diferem em 100 nanossegundos dentro do mesmo milissegundo. A precisão
que já foi perdida em checkpoints históricos não é inventada nem recuperada
por subtração de três horas.

A quarentena **somente por ausência de fuso** deixa de ser aplicada a novas
respostas/mensagens válidas. Inspeções novas trazem
`contract:"lsports-217525-utc"`, `orderingKey`, valor bruto e IDs de contexto.
Quarentenas e versões históricas já gravadas **não são reprocessadas nem
reescritas automaticamente**. Uma nova confirmação válida do fornecedor segue
as regras normais de versão/freshness; uma odd salva em disco não se torna atual
pela mudança do parser. Mercados/resultados liquidados continuam bloqueando novas
apostas; códigos numéricos de liquidação permanecem a única base de resultado.

Antes de qualquer recuperação adicional dos dados persistidos, execute somente:

```sh
npm run diagnose:timestamps:utc
```

Esse comando lê o checkpoint configurado em `LSPORTS_STATE_FILE` (padrão
`.runtime/trade-feed.json`), sem abrir bilhetes, adquirir/remover locks, consultar o
fornecedor ou gravar arquivos. Informa fixture/mercado/seleção, origem,
`historicalConversionMatches`, `storedMatchesContract` e quarentenas com evidência
bruta disponível. Diferença indica necessidade de análise — não autorização para
reaplicar preço/settlement. Checkpoints sem valor bruto não permitem comprovar a
conversão histórica; ausência de candidatos não prova que todo histórico está
correto. Não execute novamente a migração anterior nem remova `.runtime`.

Testes usam o parser e o SDK instalados, snapshots HTTP locais e processos com
TZ `UTC`, `America/Sao_Paulo` e `Europe/Berlin`: equivalência do exemplo, offsets,
precisão submilissegundo, proteção contra versões antigas, persistência/reinício,
rejeição de datas inválidas e manutenção do bloqueio de seleção liquidada.
Nenhum teste desta entrega consulta a LSports ou modifica os bilhetes do Mac.

## Evidências locais de feed, snapshots e eventos abertos

`npm run diagnose:feed:local` lê somente a projeção configurada em
`LSPORTS_STATE_FILE`. Não consulta LSports, não acessa bilhetes, não altera locks,
checkpoint, assinaturas, datas ou odds, nem executa migrações.

O relatório distingue:

- `lanes[].phase`, diagnósticos por operação/código e falhas de recuperação
  Outright. `degradedReasons` explica que “parcial” pode ser HTTP/Outright mesmo
  com ambos os canais AMQP conectados; isso não prova que futebol esteja bloqueado.
- `transport.lastMessageAt`: qualquer mensagem AMQP, inclusive controles.
  `activity.lastControlDecodedAt`, `lastEventDecodedAt`, `lastMarketDecodedAt` e
  `lastSettlementDecodedAt` separam keepalive/heartbeat, fixtures/placar, odds e
  liquidações. Duplicatas têm horário separado e não renovam o marcador de dados.
  “Decoded” é interpretação bem-sucedida do envelope, não aceitação de cada campo;
  versões antigas podem ser rejeitadas normalmente pelo estado.
- Snapshot regular: tentativa, último sucesso/erro, contagem e auditoria de
  fixtures/mercados/preços **brutos versus SDK** (`snapshot.audit.content`), com
  status e exemplos de IDs. Sem esses campos em uma captura antiga, a origem da
  diferença continua desconhecida. Aguardar a próxima consulta agendada normal,
  sem reiniciar repetidamente ou executar diagnose HTTP para forçar snapshots.
- `restoration`: origem/quantidade restaurada ao iniciar o worker.
  `events[].restoredLineage` registra histórico restaurado, mas pode coexistir com
  confirmação nova. `observation` informa recepção no processo atual por snapshot
  ou AMQP; não é restaurado como prova de frescor no reinício. Ausência de marcação
  em versões antigas é “unknown”, não prova de que o fornecedor não enviou dados.
- `ui`: divisão por esporte/aba. O frontend não filtra pela data; por isso eventos
  finalizados continuam visíveis, bloqueados. 19 eventos na API e 12 na aba de
  futebol podem ser apenas a divisão por esporte/live/busca. A projeção também
  omite linhas sem fixture e prefere a cópia InPlay de um fixture ao vivo existente
  nos dois feeds; essas contagens aparecem em `lanes[].projection`.
- `events` e `exclusions`: IDs, status de fixture/mercado, datas absolutas quando
  disponíveis, seleções habilitadas e motivos de bloqueio. `projectionPublishedAt`
  indica escrita do worker, não recebimento de novo evento/odd. `LastUpdate`
  continua sendo versão do preço; uma versão antiga pode estar inalterada em um
  snapshot atual, e isso é diferente de reativar uma odd salva sem confirmação.

O endpoint administrativo somente leitura é
`GET /api/control/clients/:clientId/operations/:operationId/feed-evidence`.
Exige autenticação administrativa e autorização da operação. Não reconcilia ou
liquida bilhetes durante a coleta. A disponibilidade do feed é compartilhada pela
integração da plataforma; nenhum dado de jogadores ou bilhetes de outro cliente
é incluído.

Para gerar uma mensagem de suporte pronta com as evidências atuais:

```sh
npm run diagnose:feed:local -- --support
```

Enviar somente a mensagem/captura sanitizada, não `.env`, bancos ou payloads
completos. Ela referencia o ticket #217525 e pede exemplos **ainda abertos** de
PreMatch 4511 / InPlay 4510 no ambiente Test, quotas recomendadas atualizadas e
confirmação dos filtros/distribuição/assinaturas existentes, sem criar assinaturas
pagas. Campo ausente deve permanecer desconhecido; conexão e keepalive não provam
que haja conteúdo aberto.

A observação do operador de eventos de 17/10, “1X2 · Liquidado”, 19 eventos e 12
visíveis no futebol foi o ponto de partida, não uma captura nova deste ambiente.
A causa específica no Mac exige o relatório acima. Os testes locais reproduzem
esse cenário e demonstram que snapshot e projeção mantêm mercados liquidados
fechados; um fixture aberto recebido do fornecedor simulado segue publicado.

`outrightRecovery.operations` separa tentativa/sucesso/erro de fixtures e mercados; `checkedAt` é apenas a avaliação local da recuperação, não prova de uma chamada HTTP nova. `deferred:true` indica coordenação local sem nova requisição; HTTP 429 indica resposta do fornecedor. `projectionUsableByApi` aplica apenas a janela de publicação existente de 20 segundos, não habilita odds.

## PreMatch preso em recovering com mercados novos — captura 18/10/2026 20:13:24.587Z

A captura fornecida pelo operador contém 138 eventos, 234 mercados abertos em
18 eventos e nenhum candidato selecionável. No fixture **20572565**, status 1,
há 21 mercados abertos e 80 preços válidos; as três seleções abertas do 1X2 têm
apenas `feed_disconnected` como bloqueio. Em 16 dos 18 eventos com mercados
abertos esse é o único motivo registrado; nos demais há também seleções sem
preço válido/estado aberto, que devem continuar bloqueadas individualmente.

PreMatch está em `recovering`, mas dados e mercados foram decodificados às
20:13:24.478Z. A tentativa regular permaneceu em 20:08:23.592Z, com
`retryAt=20:09:44.560Z`. O diagnóstico é `rate_limited,deferred:true`, sem status
HTTP: representa adiamento do coordenador local, não comprova um HTTP 429 novo.
O snapshot bem-sucedido anterior, às 20:04:45.191Z, continha dois fixtures
liquidados. Dados novos chegaram depois por AMQP, portanto a ausência de
candidatos nesta captura não é explicada por ausência de eventos abertos.

**Causa reproduzida:** a recuperação aguardava `buffered.length === 0`, mas
novas entregas eram inseridas no mesmo buffer enquanto ele era drenado. Sob
tráfego contínuo, esse laço podia nunca acabar. O worker persistia/aplicava
mensagens, porém não executava a transição para `connected` nem retornava ao
laço do agendador. O `lastAttemptAt` congelado é consistente com a tentativa não
executada; não era somente um horário esquecido na instrumentação.

**Correção:** capturar um prefixo finito do buffer, instalá-lo na mesma cadeia
serial e transferir as entregas novas para depois desse prefixo, sem `await`
entre a instalação e a troca. A recuperação aguarda apenas essa barreira finita.
Assim preserva ordem, persistência antes do ACK e mensagens sem ACK em caso de
falha, sem exigir que a fila inteira fique vazia. O agendador volta a executar,
respeitando `retryAt`, cooldown e as regras existentes do fornecedor.

A sessão precisa completar seu próprio snapshot regular inicial antes de
publicar `phase=connected`; o horário de snapshot de uma conexão anterior não
conta como confirmação. Enquanto isso, `phase=recovering` mantém as quotas
bloqueadas, mas a cadeia serial continua processando entregas e o agendador
continua tentando nos horários autorizados. Depois de uma base válida, uma
recuperação Outright parcial continua identificada separadamente. Nenhuma
seleção recebe `available=true` diretamente; status, preço, versão, settlement e
confirmação de cotações restauradas seguem os critérios anteriores.

`lanes[].recoveryProgress` no diagnóstico local informa `stage` (`snapshot`,
`handoff`, `waiting_retry`, `idle`), início/conclusão, `queuedAtHandoff`,
`regularSnapshotReady` e `nextRegularAttemptAt`. Um snapshot adiado agora é
registrado como `snapshot_deferred`, sem declarar recuperação concluída.

Validação isolada:

```sh
node --import tsx --test apps/worker/src/recovery-handoff.test.ts
```

O teste de fluxo contínuo falha com o código anterior por não executar o retry;
com a correção, confirma nova tentativa depois do prazo e três seleções válidas
sem forçar disponibilidade. Também valida keepalive sem confirmação inicial,
mercado liquidado bloqueado, preço restaurado ainda aguardando atualização,
recuperação Outright incompleta preservada, persistência antes de ACK e shutdown.
As amostras são locais, sem conexão, consumo de filas ou assinatura do fornecedor.

No Mac: atualizar/build, reiniciar o worker **uma só vez** pelo comando habitual,
aguardar o snapshot/retry autorizado e executar `npm run --silent diagnose:feed:local`.
Conferir avanço de `lastAttemptAt`/`lastSuccessAt`, `recoveryProgress` e candidatos
do fixture 20572565 **se ele ainda estiver aberto no fornecedor**. Não apagar
arquivos de agendamento, locks ou checkpoint, não repetir migrações nem limpar
bilhetes. Nenhum deploy é necessário para esta correção local.
