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
