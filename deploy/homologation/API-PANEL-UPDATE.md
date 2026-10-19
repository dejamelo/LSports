# Atualização isolada do painel/API ADL

Domínio: https://sportbook.apuestadeportiva.lat/control

No Mac, usando a chave já existente `~/Downloads/*Lottery*Key.pem`:

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/update-adl-api.mjs
```

Não executar a preparação inicial nem o cutover novamente. O comando usa apenas
fonte commitada de API/web/pacotes e dois utilitários de acesso. Não envia `.env`,
runtime, bilhetes, bancos, chaves, backups, testes ou scripts de demonstração.
Não importa clientes, operações nem acessos do demo do Mac.

## Etapas e limites

1. Trava exclusiva do atualizador; lê deployment e todos os composeOverrides.
2. Exige uma API conectada à plataforma, volume existente, 1,5 GiB disponíveis e
   3 GiB livres. Confere lockfile contra a imagem instalada; divergência bloqueia
   para revisão de dependências, sem reinstalar silenciosamente.
3. Deriva imagem exclusiva da API a partir da instalada, sem rede durante o build,
   com limite de 1 GiB e um núcleo. Atualiza fontes e frontend; não troca o worker.
4. Faz backups online pela API SQLite (inclui WAL) de cada `.sqlite` do volume da
   plataforma, com integridade e manifesto SHA-256. Arquivos privados sob
   `/var/backups/adl-api-update-*`, diretório 0700, arquivos 0600. Esses backups
   são consistentes por banco, não uma fotografia atômica entre bancos; o worker
   continua liquidando. Não copia nem modifica volume do feed.
5. Testa os construtores atuais sobre outra cópia dos bancos, sem rede ou feed.
   A única adição aprovada é `operation_terminals`, com definição exata e sem alteração nas tabelas existentes. Outras mudanças de esquema/conjunto de bancos bloqueiam ANTES de trocar a API. Isso
   mantém compatibilidade com o worker antigo e rollback sem restaurar dados.
6. Compara o Compose completo: única diferença permitida é `services.api.image`.
   Conserva todas as definições, volumes, redes, aliases, credenciais e overrides.
7. Recria somente `api`, com `--no-deps --no-build --pull never`; verifica status
   financeiro simulation, página local e igualdade do JS publicado via HTTPS.
   A checagem HTTPS remota usa asset público, pois /control tem CIDR administrativo.
8. Confere identidades/partidas/imagens dos demais containers e os administradores;
   grava somente um override adicional para a imagem da API e metadados associados.
9. Do Mac, testa /control e /api/control/status pelo domínio. Um 403 aqui indica
   restrição de rede administrativa existente; não abre o Caddy automaticamente.

Interrupção esperada da API: troca e healthcheck, normalmente segundos, teto de
validação 45 s mais tempo do Compose. Worker e POSNET não são reiniciados.
Não há nova cobrança de recursos AWS pelo executor; imagem/backup consomem disco
já contratado. Backups não são apagados automaticamente.

A imagem anterior foi comparada localmente: não possuía `operation_terminals`.
Essa tabela aditiva é ignorada pela versão antiga e pode permanecer em rollback;
não se apagam terminais nem se restaura o banco.

## Acesso

Se `administratorPreserved:true`, usar email e senha já cadastrados na AWS.
Nenhuma senha é redefinida; login/sessões existentes continuam no mesmo banco.

Se não existir administrador, após aplicação e acesso HTTPS confirmados o
executor interativo pede SOMENTE o email e gera uma senha aleatória forte. Cria
administrador pela rotina existente `PlatformStore.bootstrap`, que recusa se já
houver administrador. Salva o acesso em arquivo 0600 fora do repositório:
`~/Library/Application Support/ADL/Access/aws-admin-<data>.json`.
O caminho é mostrado; senha não aparece no terminal nem nos logs. Consultar esse
arquivo localmente, entrar pelo painel e trocar a senha em a opção de alteração de senha no painel. Não
colar o arquivo no chat. Enter sem email deixa inicialização pendente. Uma
execução não interativa não cria administrador. Não há senha padrão ou do demo.

## Rollback

Em falha após troca, o executor reaplica a composição ANTERIOR, somente API,
verifica saúde e restaura os metadados anteriores. Registra
`rollback:previous_api_healthy` ou falha concreta; logs privados ficam no backup.
Não restaura bancos automaticamente: eles continuam recebendo liquidações e
restaurar o backup perderia gravações posteriores. Se processo/SSH for interrompido,
antes de repetir comparar deployment/model privado e estado atual; preservar tudo.
Para retorno manual usar o `rollback.compose.private.json` com todas as definições
resolvidas (tratar como segredo):

```bash
sudo docker compose -p adl-homologation \
  -f /var/backups/adl-api-update-<ID>/rollback.compose.private.json \
  up -d --no-deps --no-build --pull never api
```

Após saúde confirmada, restaurar apenas `deployment.before.private.json` para
`/etc/adl-homologation/deployment.json` com modo 0600 e rename atômico. Nunca
aplicar `down`, `-v`, iniciar worker Mac ou restaurar bancos como rollback de UI.

## Evidência local desta entrega

Build Docker offline real sobre imagem ADL anterior, limitado a 1 GiB, concluído.
Probe isolado da imagem verifica administrador preservado e frontend compilado.
Teste Docker antigo → novo → antigo também passou, conservando exatamente o
registro do administrador e sem restaurar dados.
Testes Python de backup WAL/integridade/esquema/Compose e teste de seleção de
fonte, além dos testes locais de plataforma/feed, sem chamadas LSports.
A aplicação real na AWS e login autenticado pelo proprietário continuam sendo
validações da execução no Mac, não são declarados concluídos pelo teste local.
Apostas sem feed válido permanecem recusadas pelo servidor.

## Checkout do Mac com alterações rastreadas

`TRACKED_CHANGES_PRESERVED` em 7bafc84 era emitido no Mac, antes de selecionar a
chave ou abrir SSH. Não veio do servidor; nesse bloqueio nenhuma API/worker foi
alterada. O executor antigo não mostrava os caminhos. Sem acesso ao checkout do
Mac, não é possível atribuir nomes reais às mudanças com base só nesse código.

Para retomar SEM alterar, stashear ou descartar o trabalho local, usar a versão
commitada do executor em diretório temporário, explicitando o commit publicado:

```bash
bash <<'MAC'
set -euo pipefail
cd "$HOME/LSports"
git fetch origin feat/sportsbook-demo
ADL_TARGET="$(git rev-parse --verify 'FETCH_HEAD^{commit}')"
ADL_RUN="$(mktemp -d "${TMPDIR:-/tmp}/adl-api-update.XXXXXX")"
git archive "$ADL_TARGET" deploy/homologation | tar -x -C "$ADL_RUN"
node "$ADL_RUN/deploy/homologation/update-adl-api.mjs" \
  --repo "$PWD" --commit "$ADL_TARGET" --preserve-local-changes
MAC
```

Não usa `git pull`, merge, reset, clean ou stash; HEAD, índice, arquivos e
exclusões locais permanecem. `local_source_comparison` identifica ambiente,
commit pretendido, HEAD local, caminhos/status, renomes, modos Git, diferenças
de conteúdo do working tree e índice em relação ao commit pretendido. Conteúdo,
patches e segredos não aparecem no terminal.

Antes de SSH, o executor cria backup 0700/0600 em:
`~/Library/Application Support/ADL/Backups/LocalSource/panel-api-local-*`.
Preserva patches binários separados staged/unstaged, índice, bytes locais,
versão do índice, versão pretendida, exclusões/renomes/symlinks/modos e manifesto
SHA-256 verificado. Detecta mudanças durante a cópia e bloqueia nesse caso.
A cópia local é preservada; não se publica no servidor.

`--preserve-local-changes` significa **publicar exclusivamente o commit
explicitamente indicado**, deixando as edições locais de fora. Não significa
mesclar ou aprovar automaticamente essas edições. Inclusive o Python remoto é
lido do objeto Git desse commit, não do arquivo possivelmente alterado no Mac.
A etapa AWS mantém backup, compatibilidade e rollback descritos acima.

Para incorporar uma edição local à publicação, revisá-la e criar um commit
separado posteriormente; não reaplicar patches automaticamente. Para consulta
sem SSH, acrescentar `--inspect-local` ao mesmo executor (faz a cópia protegida
quando necessário). Não compartilhar os arquivos `.private` no chat.


## Saída silenciosa do executor temporário (b1c3ac6)

Reprodução local comprovada: invocar o arquivo por um diretório symlink fazia
`process.argv[1] !== fileURLToPath(import.meta.url)`; o guard não chamava main e
encerrava com código zero e nenhum byte de saída. No macOS, `/var` versus
`/private/var` é um caso típico. Não há evidência de uma implantação naquele
silêncio; conferir somente a versão real na execução corrigida.

O guard agora compara `realpath` dos dois caminhos. Há teste de invocação real
por symlink, com opção inválida exigindo saída 2 e erro sanitizado; importações
para testes continuam sem executar o deploy. O executor registra `executor_start`,
comparação/backup, SSH, etapas remotas, heartbeat a cada 20 s e `executor_exit`.

Também foi corrigida a aceitação dos diretórios normais presentes no `git archive`:
continuam proibidos symlinks, arquivos privados e traversal. Antes de confirmar a
API instalada, o servidor verifica ID da imagem executada contra o build, label
`org.opencontainers.image.revision` e hashes de TODOS os arquivos-fonte enviados
contra os arquivos dentro do container. Não importa módulos da aplicação para
essa prova; usa apenas fs/crypto. Divergência exige rollback da API.
O resultado `complete` inclui `installedCommit`, `installedImageId` e
`installedSourceVerified:true`, além de saúde e HTTPS. Esses valores e o backup
formam o recibo real; um container running sozinho não confirma a versão.

### Inicializar somente o administrador após deploy confirmado

`initialize-adl-admin.mjs --repo <checkout>` usa exclusivamente a rotina
`--bootstrap` de d6d3d3a, sem build, upload de fontes, Compose, migração ou ações
nos workers. Requer TTY; em bloco heredoc redirecionar a entrada do Node de
`/dev/tty`. Pede email, gera senha aleatória e guarda arquivo privado no Mac antes
do envio cifrado por SSH. O backend verifica que não há administrador e a criação
é transacional; nunca redefine o administrador existente. Só confirma após
`initialized:true`. Se a resposta se perder, manter o arquivo marcado pendente e
verificar o acesso usando esse mesmo arquivo; não substituir credenciais por
suposição. A senha não é emitida no terminal/logs. O arquivo `.confirmed.json`
separado registra apenas confirmação e data, sem a senha.
