# Homologação ADL · preparação, sem deploy executado

Objetivo: publicar o build do iframe e o painel/API na mesma origem HTTPS,
usando LSports **Test** e carteira exclusivamente em **simulação**. O Compose
é para **um único host**, uma API e um worker. Não escale réplicas: o modelo atual
usa SQLite, arquivos de projeção, locks e coordenação de snapshots no mesmo volume.
Os helpers de demonstração local/sintética não são publicados.

## O que ainda precisa ser definido/provisionado

- Host Linux com Docker/Compose, disco persistente, backup/restauração e domínio
  DNS apontando para ele; portas 80/443 para HTTPS; acesso administrativo por VPN
  ou CIDRs conhecidos. O exemplo bloqueia o painel fora de loopback até configurar
  `ADMIN_ALLOWED_CIDRS`.
- Origem pública HTTPS exata em `PLATFORM_PUBLIC_ORIGIN`, domínio do Caddy e
  origens HTTPS autorizadas do cassino de homologação. Não use localhost como
  origem do cassino remoto.
- Credenciais LSports no servidor e autorização/allowlist de egress do host para
  os endpoints HTTP/AMQP Test existentes. AMQPS somente se listener/porta forem
  confirmados pelo fornecedor; o exemplo preserva o listener Test já utilizado.
- **Um só consumidor ativo dos pacotes/filas.** Não rode este worker ao mesmo
  tempo que o Mac nas mesmas filas: consumidores concorrentes dividem mensagens.
  Combine a transferência ou peça um ambiente/filas de teste separados, sem
  criar assinaturas pagas. Este é um bloqueio operacional antes de homologar o feed.
- Conta administrativa de homologação, cliente/operação de teste separados,
  domínios autorizados e chave permanente entregue somente ao backend do cassino.
  O backend solicita `/api/integration/v1/embed-sessions`; o browser recebe apenas
  a URL temporária. `/demo/argentina`, `/demo/synthetic` e o Vite não são publicados.
- Eventos Test abertos com odds recomendadas atualizadas e testes remotos de
  iframe, CSP, sessão temporária, limites, risco, resultados e correções. TLS/IP,
  DNS e conectividade real do fornecedor ainda precisam ser validados no host.
- Alertas e monitoramento para worker parado, erro de feed, snapshots parciais,
  Retry-After, disco e liquidações pendentes; retenção/rotação de logs sem segredos.
  O healthcheck da API verifica somente que o painel é servido, não a conexão LSports.

Não copie `.env`, `.runtime`, bilhetes, backups ou banco do Mac para estes volumes
por conta própria. Nada aqui migra dados existentes. Uma transferência futura exige
plano separado, backup consistente e validação das permissões e escopos.

## Arquivos

- `Dockerfile.homologation`: Node 24, dependências pelo lockfile, build, usuário
  sem privilégios. O runtime usa TypeScript/tsx, por isso mantém as dependências
  necessárias em vez de removê-las com `omit=dev`.
- `.dockerignore`: exclui segredos, chaves, bancos, backups e dados locais do contexto.
  O Dockerfile copia explicitamente somente manifests e diretórios de código.
- `compose.yaml`: API, worker e Caddy; API/worker com raiz somente leitura,
  volumes persistentes, tmpfs, SIGTERM e prazo de encerramento de 60 segundos.
- O worker escreve o volume do feed e liquida bilhetes no volume da plataforma;
  a API lê o feed em montagem somente leitura e administra o banco da plataforma.
  Só o worker recebe credenciais do fornecedor. O Caddy recebe apenas configurações
  públicas de origem/CIDRs, nunca credenciais LSports ou de bootstrap.
- `Caddyfile`: HTTPS, painel restrito por IP, bloqueio dos helpers locais e proxy.
  O CSP `frame-ancestors` continua sendo definido pela aplicação por cliente.
- `api.env.example`, `worker.env.example`, `bootstrap.env.example`: modelos sem
  segredos. Cópias `*.env` e `secrets/` são ignoradas pelo Git e pelo build.

## Preparação para revisão (sem iniciar serviços)

Copie os modelos para `api.env`, `worker.env` e, quando necessário, `bootstrap.env`
no próprio host e proteja-os com permissões 600. Preencha os valores no servidor,
nunca em argumentos de linha de comando, chats ou arquivos versionados.

Validação estrutural usando somente modelos:

```sh
API_ENV_FILE=./api.env.example WORKER_ENV_FILE=./worker.env.example \
  docker compose -f deploy/homologation/compose.yaml config --quiet
npm run build
npm test
```

Evite imprimir `docker compose config` completo com arquivos reais: ele pode
resolver variáveis secretas. Para construir uma imagem de revisão, sem publicar:

```sh
docker build -f Dockerfile.homologation -t adl-homologation:review .
```

Se a rede de build usa uma CA corporativa, mantenha a verificação TLS habilitada
e passe **um certificado público confiável**, sem copiá-lo para o repositório:

```sh
docker build --secret id=build_ca,src=/caminho/ca-publica.pem \
  -f Dockerfile.homologation -t adl-homologation:review .
```

O mount de build é temporário e não é gravado na imagem. Não use `strict-ssl=false`
ou `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Sequência futura de publicação — não executada nesta entrega

Depois de definir os itens acima, revisar os arquivos reais no host e autorizar
publicação, construir uma imagem identificada pelo commit e iniciar o Compose.
Não iniciar um segundo worker nas filas utilizadas no Mac. Em seguida, executar
bootstrap uma única vez a partir do arquivo protegido, por exemplo:

```sh
docker compose -f deploy/homologation/compose.yaml run --rm --no-deps \
  --env-from-file ./deploy/homologation/bootstrap.env \
  api node --import tsx scripts/bootstrap-platform.ts
```

Eliminar `bootstrap.env` após confirmação; não incluir sua senha em `api.env`.
Acessar `https://DOMINIO/control` somente da rede administrativa autorizada,
cadastrar o cassino/operação de homologação e sua origem de incorporação, gerar
credencial do backend e testar a sessão no domínio real. Cookies administrativos
usam Secure; sessões do iframe usam Bearer temporário em memória, sem depender de
cookies de terceiros. O processo de startup da API recusa produção sem plataforma
autenticada, modo conectado e origem HTTPS exata.

Validar feed e liquidação com evidências novas; não confundir a tela de login 200
com aprovação da integração. Aguardar o agendamento normal dos snapshots, respeitar
`retryAt`, manter mercados liquidados fechados e conferir backups/restauração e
encerramento antes de ampliar uso. Nunca remover locks automaticamente. Após uma
queda forçada, examinar o proprietário do lock dentro do contexto correto do
container/volume e preparar recuperação offline auditada; PIDs de namespaces
Docker não equivalem aos do host.

Para produção comercial ainda faltam, além da homologação remota, o contrato e a
integração de carteira real (saldo/débito/crédito/estorno/conciliação), requisitos
operacionais/comerciais e validação dos canais/terminais reais. Esta configuração
não habilita dinheiro real.

## Validação desta entrega

Build da aplicação e 134 testes aprovados; regressão do painel/iframe no navegador
com dados isolados aprovada. Compose validado usando somente os arquivos de exemplo.
Caddy validado em execução efêmera de `caddy validate`, sem rede e sem portas publicadas.
Imagem de revisão construída com sucesso; neste ambiente foi necessário fornecer
a CA pública da rede como secret temporário de build, mantendo TLS verificado.
Nenhum `compose up`, publicação de imagem, deploy, bootstrap de homologação ou teste
real das credenciais/DNS/certificado/egress LSports foi executado.
