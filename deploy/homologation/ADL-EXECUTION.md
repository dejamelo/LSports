# ADL: homologação separada autorizada, implantação em etapas

## Escopo vigente

EC2 **m7i.xlarge já confirmada** pelo operador; 12 serviços POSNET retornaram,
saúde/páginas passaram e demo abriu. Não repetir o redimensionamento. Plano pago
AWS já ativo. Valor e implantação ADL autorizados; sem novo pedido financeiro.
Preservar POSNET, backups, imagens, aliases, políticas e suas rotas. Não executar
novamente os scripts de manutenção POSNET.

Domínio autorizado: **sportbook.apuestadeportiva.lat**, exatamente sem `s` após
`sport`. O operador cadastrou Namecheap **A `sportbook` → 77.113.150.100**, TTL
5 min. DNS deste workspace retornou ECONNREFUSED/timeout do resolvedor: isso não
é NXDOMAIN nem prova de erro no cadastro. A consulta do Mac fará a verificação.
Não alterar os domínios POSNET. Se existirem A adicionais/AAAA incompatíveis,
resolver antes da publicação HTTPS, sem ignorar TLS ou falsificar resolução.

Homologação AWS **separada**: Argentina Demo, bilhetes, resultados, odds aceitas,
bancos e `.env/.runtime` continuam preservados no Mac. Não copiar banco ou
checkpoint inteiro para uma plataforma nova, não executar migrações. AWS terá
seus próprios clientes/operações/credenciais de teste, todos em simulação.

Este workspace não possui a chave SSH (ela fica no Mac), AWS CLI vinculada à
conta ou credenciais LSports. Não alegar execução remota/validação real sem a
saída obtida pelo operador. Nenhum segredo deve ser enviado ao chat.

## Etapa 1: DNS, imagem e API isolada — executar agora no Mac

```bash
cd "$HOME/LSports"
git pull --ff-only origin feat/sportsbook-demo
node deploy/homologation/prepare-adl-aws.mjs
```

Seleciona a chave existente por `*Lottery*Key.pem` e usa o mesmo SSH. Preserva
alterações locais; a exclusão local conhecida de diagnose-aws-resize.py não é
restaurada à força. O conteúdo enviado é **git archive HEAD**, não o diretório
com `.env`, node_modules ou `.runtime`. Não necessita GitHub login no servidor.
Não imprime/chama variáveis secretas. A imagem é identificada pelo commit.

O receptor exige Python >=3.12, pelo menos 4 GiB de memória disponível e 10 GiB
livres para construir; valida porta 13001 livre, rede deploy_default existente e
nenhum projeto ADL anterior. Esses são checks de admissão da implantação nova,
não uma repetição do inventário POSNET. Cria release em `/opt/adl-homologation/releases/COMMIT`
e arquivos protegidos em `/etc/adl-homologation` (700/600). Se já existir release
parcial/configuração, não sobrescreve: relata etapa e preserva para revisão.

Inicia **somente a API** no projeto `adl-homologation`, com volumes próprios;
loopback 127.0.0.1:13001, 768 MiB/0,5 CPU, feed somente leitura, plataforma RW.
Conecta apenas a API à rede existente com alias `adl-homologation-api`. Não
publica 80/443, não modifica Caddy nem containers POSNET. Health /control 200
prova processo web, não feed nem usuário administrativo já criado.

Resultado esperado `stage=complete/status=ok/apiStarted=true/workerStarted=false`.
Guardar release/imagem da saída. Build/deploy têm logs privados no release;
falha publica etapa sanitizada. Não compartilhar log bruto sem revisão. A
construção canônica da imagem precisa concluir na AWS: o build local da aplicação
passou, mas a tentativa de instalação em imagem neste workspace não concluiu.
Não foi fornecida uma imagem nova como se já estivesse validada.

**Não parar ainda o worker Mac** nesta etapa. Ele continua sendo o único
consumidor enquanto se prepara API, HTTPS e a nova plataforma.

## Etapa 2: HTTPS e nova plataforma, antes do corte

Após a saída real da etapa 1 e DNS confirmado:

- Gerar/revisar um bloco novo de site somente para sportbook.apuestadeportiva.lat,
  upstream `adl-homologation-api:3001`; não ativar standalone-proxy nem outro Caddy.
- Salvar configuração ativa e arquivo Caddy em backup root-only, comparar baseline
  imediatamente antes da alteração, adaptar/validar candidato e garantir que as
  rotas POSNET continuam iguais. A mudança requer rollback de arquivo + reload
  se falhar; nunca restart do Caddy nem sobrescrita cega.
- Manter painel/control API restritos à rede administrativa identificada, além da
  autenticação. `deployment.json` registra CIDR do cliente SSH para essa revisão;
  se navegador usar outra rede/VPN, não abrir o painel a todos para contornar.
- Alterar arquivo host preservando o bind/inode, reload controlado e verificar
  certificado, novo domínio e POSNET. Não declarar HTTPS pronto apenas pelo A.
- Criar administrador no backend por entrada protegida no servidor, sem senha em
  chat/argv/log; configurar novo cliente/operação/moeda/domínio permitido e gerar
  credencial backend. Segredo LSports não vai para API/browser.
- Criar sessão temporária e página iframe da homologação pelo backend existente;
  não ativar /demo/argentina ou demonstração sintética em produção. Validar domínio
  autorizado e CSP. Bilhetes/carteira continuam simulados.

A publicação e bootstrap dependem da evidência da etapa 1; não apresentar um
reload ou conta criada como executado por este workspace.

## Etapa 3: corte Mac → AWS e cooldown

1. Encerrar normalmente o worker do Mac (Ctrl+C do processo npm/dev que o mantém).
   Esperar `worker.shutdown` e `lock=released`. Não apagar lock, SIGKILL geral,
   stopDistribution, novas filas ou cancelamento de assinaturas. Se npm dev
   reiniciar o worker, encerrar seu supervisor normal, sem matar outros Node.
2. Depois executar **no Mac**:

   ```bash
   npm run cutover:audit
   ```

   É leitura local, zero requisições ao fornecedor. Bloqueia qualquer lock de worker
   ou scheduler, processo reconhecido ainda ativo, journal ausente/corrompido ou
   evidência incompleta das lanes. Não recupera locks automaticamente.
3. O relatório calcula `notBeforeUTC` como máximo de todos `nextAt/due`, retryAt
   prematch/inplay e último snapshot + intervalo configurado, nunca antes de um
   intervalo completo após desligamento, com margem positiva. Não usar espera fixa
   de 5 min se algum Retry-After exigir mais tempo.
4. Transferir por SSH somente variáveis LSports permitidas e journals do scheduler
   (sem locks) para backend protegido; **não transferir `.env` inteiro**, plataforma,
   bilhetes ou checkpoint. Preservar prazos e hashes/auditoria da cópia. Arquivos
   secretos `worker.env` têm formato Compose **raw**, para não interpolar `$`/aspas.
   O formato exige Compose >=2.30; servidor informou v5.6.0.
5. Só após ausência de consumidor Mac, journals importados e horário UTC atingido,
   afirmar gates `ADL_CAPACITY_APPROVED=yes`, `ADL_MAC_WORKER_STOPPED=yes`,
   `ADL_SUPPLIER_NOT_BEFORE_UTC=...`; worker com perfil explícito feed-consumer.
   Launcher mantém orçamento de memória antes de importar cliente e a cada HTTP.
6. `basic.consume(exclusive=true,noAck=false)` fornece exclusividade de consumidor
   **na fila existente**, não cria fila exclusiva nem altera subscriptions. É opção
   AMQP suportada pelo amqplib instalado. Se já houver consumidor/incompatibilidade,
   falhar com diagnóstico, nunca rebaixar para não exclusivo. Exclusividade não
   substitui encerramento normal do Mac nem preservação de cooldown.

Local file lock não é fencing entre hosts. O gate operacional declara corte;
exclusividade de basic.consume impõe a restrição no broker. A aceitação dessa
opção nas filas específicas só pode ser validada na conexão real; não presumir
suporte a configurações especiais como single-active-consumer.

## Etapa 4: validação real, sem fallback

PreMatch cap 256 MiB/old-space 3072 MiB/container 4 GiB; InPlay cap 128 MiB.
Admissão usa margem física/cgroup e heap, não a RAM total isoladamente. Não baixar
guardas, timeout20s, cooldowns ou forçar available. Snapshot precisa completar
nesta execução, handoff terminar e regularSnapshotReady=true antes de aceitar odds.

Usar evidências existentes do painel: snapshot lastAttempt/lastSuccess, auditoria
bytes/eventos/mercados, phase de cada lane, último dado e último mercado efetivos,
exclusões locais e candidatos abertos; keepalive não prova atualização de preço.
Conferir mesmo fixture/mercado/seleção no diagnóstico API e iframe, preço/status
servidor e bilhete simulado. Sem evento aberto, registrar exclusões e evidência
para LSports; não inventar evento/odd para declarar conexão validada.

- memory_budget_exceeded/response_size_limit: bloqueio local, não ausência de feed.
- local_*_cooldown: adiamento sem HTTP; supplier_http/429: fornecedor, respeitar retryAt.
- AMQP consumer_conflict: outro consumidor/acesso exclusivo, não senha por suposição.
- HTTP401/403/AMQP autorização: registrar operação/código sanitizado; não revelar chave.
- AMQP320/distribution_still_off: separar transporte/distribuição de memória.
- Tipo desconhecido: preservar NACK/requeue e persistência antes do ACK; não descartar.

Rollback: parar worker AWS normalmente e confirmar ausência antes de reativar Mac,
respeitando também os prazos AWS; manter API/dados de homologação e processar seus
resultados pendentes. Não apagar volumes ou religar dois consumidores. Não
restaurar bancos Mac ou repetir migrações para corrigir falha de transporte.
