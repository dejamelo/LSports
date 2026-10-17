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
