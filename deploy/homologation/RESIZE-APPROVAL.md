# Proposta de mudança para aprovação — não executar a parada ainda

## Valor e escopo confirmados pelo operador

| Item | Atual | Proposto |
|---|---|---|
| Tipo | c7i-flex.large | m7i.xlarge |
| CPU/RAM nominal | 2 vCPU / 4 GiB | 4 vCPU / 16 GiB |
| Região/zona | Ohio / us-east-2c | Mesma |
| Subtotal mensal oficial informado | US$ 68,7467 | US$ 154,018 |

Diferença: **US$ 85,2713/mês** (arredondada: **US$ 85,27**).
Subtotal proposto arredondado: **US$ 154,02/mês**. Premissa: On-Demand, Linux,
Shared, 730 h/mês, sem créditos ou descontos. Não é o total da conta AWS:
transferência, backups/snapshots, impostos, outros serviços e compromissos não
incluídos continuam separados. Não criar recursos pagos adicionais.

Preço oficial, Elastic IP associado e oferta na AZ: concluídos. Caddy ativo vs
arquivo de arranque: concluído. Dois originfix: políticas corrigidas e identidade,
imagens, volumes, redes, aliases e processos preservados. Não repetir correções,
consultas ou migrações já concluídas.

Manter EIP/ENI, discos, security groups, IAM e mesma instância. O IP público deve
permanecer com a associação existente. Não liberar nem reassociar a EIP.

## Backup de configuração sem parar nada

No Mac, atualizar a branch e transmitir o script pelo mesmo SSH. A chave é
selecionada por padrão; nomes especiais são preservados por NUL e aspas:

```bash
bash <<'MAC'
set -euo pipefail
cd "$HOME/LSports"
git switch feat/sportsbook-demo
git pull --ff-only origin feat/sportsbook-demo
keys=()
while IFS= read -r -d '' key; do keys+=("$key"); done < <(find "$HOME/Downloads" -maxdepth 1 -type f -name '*Lottery*Key.pem' -print0)
if [ "${#keys[@]}" -ne 1 ]; then
  printf 'Abortado: esperado exatamente um arquivo de chave; encontrados %s.\n' "${#keys[@]}"
  exit 1
fi
ssh -o IdentitiesOnly=yes -i "${keys[0]}" \
  ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com \
  'sudo -n bash -s' < deploy/homologation/prepare-posnet-resize-backup.sh
MAC
```

Só cria backup em `/var/backups/posnet-resize-config-*` (diretório 0700, arquivos
0600), com leitura de verificação. Inclui os arquivos temporários que não podem
ser pressupostos após boot. Não sobrescreve backups, não instala ferramentas,
não muda serviços/rotas/políticas. Guarda inspect completo e configurações em
arquivos **privados**, que podem conter segredos: nunca anexar, imprimir ou subir
esses arquivos ao Git. Compartilhar somente a pequena saída sanitizada.

Esperado: `stage=complete`, `status=ok`, `noRestartRequested=true`. Isso conclui
apenas configuração. `databaseBackup=not_verified` é intencional: não falseia
backup de dados. Se falhar, preservar diretório parcial e não continuar.

## Backup de dados: condição obrigatória antes da parada

Preencher com evidência existente, sem enviar segredos:

- Banco/serviço realmente usado pelo POSNET e demais dados persistentes críticos.
- Backup consistente mais recente, data/hora, localização recuperável e responsável.
- Método de restauração e evidência de teste/recuperabilidade.
- Persistência dos volumes replay e certificados Caddy; nenhuma cópia ao vivo deve
  ser apresentada como backup consistente sem suporte do banco/aplicação.

Não há dados suficientes no inventário para escolher pg_dump, backup Supabase,
SQLite online ou outro mecanismo. Não executar SQL nem restore por suposição.
Se faltar backup adequado, definir seu procedimento antes da aprovação operacional.
Snapshot AWS adicional só com aprovação de custo; não está incluído nesta proposta.

## Ordem de execução após aprovação de valor e janela

Janela reservada: **20–30 minutos**, indisponibilidade estimada **5–15 minutos**,
sujeita a capacidade da AZ e recuperação dos serviços. Horário a combinar no
fuso America/Sao_Paulo. Nenhuma parada está autorizada por este documento.

1. Confirmar backup de configuração concluído e backup consistente de dados
   identificado. Registrar InstanceId da consulta oficial e caminho do backup.
   Não repetir inventário/consulta oficial; não inventar InstanceId a partir do IP.
2. Avisar usuários e concluir/quiescer operações POSNET pelo procedimento atual.
   Não editar bilhetes/resultados; não implantar o LSports nessa mesma mudança.
3. Executar stop → aguardar stopped → modificar para m7i.xlarge → start → aguardar
   status checks. Comandos estão em EC2-RESIZE-RUNBOOK.md; não terminate, não
   compose down/up, não remover/recriar containers, imagens, redes ou volumes.
4. Docker, Caddy público e os originfix devem iniciar pela política persistente.
   Os dois outros containers já `unless-stopped` também devem retornar. A partida
   do Docker não garante backend healthy; aguardar saúde antes de liberar acesso.
5. Para conservar os **outros sete serviços antes ativos**, sem decidir importância
   pelo nome, usar o retorno dirigido abaixo. Não alterar políticas em massa.
6. Validar rotas públicas e SSO, demo, staging e canais internos/POS identificados;
   mesmo conjunto de imagens/mounts/aliases e 12 containers antes ativos. Não
   arrancar rollback/hello-world que estavam parados. Aceitar uma alteração desse
   conjunto apenas com decisão explícita do operador. Checar RAM/CPU/disco novos.
7. Liberar operações POSNET somente após validação; guardar evidências. O deploy
   LSports e transferência do consumidor Mac → AWS permanecem outra etapa,
   com worker Mac parado antes de ativar AWS e cooldown/retryAt preservados.

## Retorno dirigido dos sete que não têm política automática

Não executar antes da janela autorizada. São os containers existentes, IDs do
inventário; divergência de identidade deve interromper o retorno, sem recriação.
Primeiro os cinco backends:

```bash
sudo docker start \
  b030b0e88ed77c1db9b216045e9db5349a1b7dd8bd0e0212f18908ce21e71841 \
  a3e5bb8fe52831383d876d042b1c5962bde2ae1736aa97bdc668d05364df194d \
  b7d4d72f5bb96ffeafe405cebc5c68f001bfa661ce22b52e8a39511c1516632c \
  a6a19a1afe3b75745e4fb4188923f24f7d56361eb19076153624c745c7b36bd6 \
  81a718f0d6ce7129e8142e6ea76ee5821d0b10930c6d8f27edc7a3d4cd685b82
```

Se os arquivos Caddy privados em `/tmp` estiverem ausentes, recuperar somente
esses dois arquivos a partir do manifest/backup protegido, antes de start dos
Caddys privados. Usar os backups `file-N.private` indicados no manifest e instalar
nos caminhos originais `/tmp/Caddyfile.posnet-originfix-private` e
`/tmp/Caddyfile.posnet-private-test`, com modo 0600/root. Se o destino já existe,
comparar hash; se diferente ou for diretório, parar para revisão. Não sobrescrever
mudanças novas, não imprimir conteúdo, não limpar `/tmp` nem trocar bind mounts.
A restauração é manual nesta janela; não depende de recriar Compose ou de um
hook novo no boot. Os sete continuarão exigindo esse plano manual em futuros
boots até uma mudança separada de autostart aprovada.

Depois dos arquivos e backends, iniciar os dois Caddys privados existentes:

```bash
sudo docker start \
  3ef69dc72f8cff7bbb209f615ac89e33f2a9fc21cee2624697e519f16ba6f419 \
  2323753931e54bbd66daf876fa417465408c54884f9bcd21019942723618ba5c
```

Confirmar cada resultado; start parcial não é sucesso global. Não mudar suas
rotas nem publicar novas portas. Não há garantia de ordem automática entre
containers: essa ordem é tarefa explícita do operador após o boot.

## Recuperação e critério de abortar

Se modificar/arrancar a m7i.xlarge falhar, preservar evidência, parar a mesma
instância se necessário e voltar para c7i-flex.large, sem substituir EBS/ENI/EIP.
Retomar os mesmos serviços e validar. Rollback pode exigir nova indisponibilidade
e depende de capacidade do tipo original; não garantir retorno instantâneo.

Se o problema for apenas um container, não redimensionar repetidamente: revisar
causa, dados e arquivos montados; usar start dirigido autorizado. Não reverter
as políticas originfix para no, pois isso recria o risco já corrigido. Restore de
banco só com responsável e procedimento próprio; não é parte automática do
rollback de tipo. Manter backups e bilhetes intactos.

## Aprovação a registrar

Aprovação deve mencionar: m7i.xlarge em Ohio, subtotal US$ 154,02/mês (+US$ 85,27),
exclusões acima, janela, indisponibilidade e plano de retorno dos 12 serviços.
Pode-se aprovar a proposta econômica antes, mas **execução permanece bloqueada
até a evidência de backup consistente e a conclusão do backup de configuração**.

## Informação posterior: POSNET usa Supabase

Evidências informadas pelo operador em 18/10/2026, consultadas no projeto
**posnet-lottery-production**:

- Backups diários listados de **11 a 18/10/2026**.
- Backup mais recente: **18/10/2026, 12:47:58 UTC / 09:47:58 America/Sao_Paulo**.
- **PITR desabilitado**: não presumir recuperação para qualquer instante após o backup.
- **Storage → Files → Buckets vazio** na consulta; nenhum bucket a proteger foi
  observado nesse projeto. Isso não cobre dados locais da EC2 ou outros serviços.
- **Teste de restauração não confirmado**: existência de backups listados não
  equivale a recuperação testada. Nenhuma restauração foi executada.

A evidência foi fornecida pelo operador; não houve acesso direto deste workspace
ao Supabase. Não repetir essas consultas, preço/IP/Caddy/originfix. Conservar o
risco de recuperação não testada e a diferença temporal entre último backup e
momento da futura mudança na aprovação operacional. Não habilitar PITR/plano pago.
A próxima ação é a preparação de configuração/levantamento local da EC2, ainda
sem autorização de parada ou redimensionamento.

A rotina de preparação agora também informa por container: famílias de configuração
presentes (ex.: supabase, sem valores), mounts e contagem de possíveis arquivos de
banco/uploads/replay na camada gravável (`docker diff`, sem conteúdo). Os caminhos
brutos ficam apenas no backup privado. Ausência de arquivos classificados não
prova ausência de dados; o relatório deve ser revisado antes da execução.

Persistência local já demonstrada: volume replay do demo originfix e volume de
dados/certificados Caddy; existe também replay do demo anterior. Preservar todos.
A rotina não faz cópia consistente desses volumes/dados, nem inventa backup de
Supabase. Se houver estado adicional em camada gravável, não recriar containers;
identificar tratamento/backup apropriado. Stop/start EC2 mantém EBS/camadas dos
containers existentes, mas isso não substitui uma proteção recuperável.

Referência para eventual revisão futura, **sem repetir agora a conferência já
concluída**: painel Supabase, **Database → Backups** (local pode variar):

1. Confirmar projeto, plano, data/hora UTC do último backup bem-sucedido e retenção.
2. Verificar se PITR está habilitado e qual intervalo recuperável já existe. Não
   habilitar plano/PITR pago nem clicar Restore agora.
3. Se não houver backup disponível, definir um dump lógico com ferramentas oficiais
   e acesso seguro do backend, em local protegido; não pedir connection string ou
   senha no chat. Não instalar nem executar ferramenta automaticamente neste passo.
4. Conferir também Supabase Storage: backup do Postgres não garante cópia dos
   objetos dos buckets. Identificar objetos importantes e sua proteção. Registrar
   ainda configurações/segredos necessários à recuperação sem expô-los no relatório.
5. Registrar responsável, localização recuperável e evidência de restore testado.
   Na ausência de teste, preparar validação isolada e aprovar antes qualquer
   projeto/recurso pago necessário. Não restaurar sobre o POSNET para testar.

Compartilhar somente: projeto identificado (nome/identificador público), plano,
data/hora/status do backup, retenção/PITR e existência de Storage. Sem credenciais,
dump, URLs de conexão ou conteúdo de tabelas. Esse é o último bloqueio de dados
conhecido; outras pendências que a coleta local revelar devem ser tratadas.


A saída da rotina EC2 mantém `databaseBackup=not_verified` porque ela não consulta
nem testa o Supabase; esse campo não invalida as evidências manuais acima.
`stage=complete/status=ok` confirma somente backup de configuração/levantamento
local e leitura de verificação. Os volumes/dados locais não são copiados de forma
consistente por essa rotina. Preservar backups antigos e compartilhar apenas a
saída sanitizada, nunca arquivos `.private`/inspect ou manifests privados.

## Evidência recebida: configuração EC2 concluída

O operador confirmou saída `stage=complete`, `status=ok`,
`noRestartRequested=true`, **12 containers em execução**, **7 arquivos de
configuração** e configuração Supabase presente nos serviços de aplicação.
Backup exibido na captura: **`/var/backups/posnet-resize-config-3gugdwsa`**.
Usar o caminho emitido pelo terminal/manifest como referência operacional se a
transcrição visual divergir; não adivinhar caminhos nem recriar o backup.

Não repetir a preparação, inventário, preços, IP, comparação Caddy ou políticas.
Nas camadas graváveis, a coleta não encontrou candidatos de banco; isso não
inspeciona conteúdos dos volumes nem prova ausência de estado. Volumes locais
que ainda exigem cópia de dados:

1. `posnet-demo-sso-originfix-replay-20261009` — replay do demo atual.
2. `posnet-demo-sso-canary-replay-20261009` — replay do demo anterior, preservado.
3. `deploy_caddy_production_data` — certificados/estado do Caddy; os Caddys privados
   montam o mesmo volume somente leitura, não são cópias independentes.

Também apareceu `D deploy/homologation/diagnose-aws-resize.py` no status local do
Mac. É uma alteração local, não prova de perda de dados na EC2. Não executar
reset/clean nem restaurar sem consentimento; não é necessário repetir o diagnóstico
oficial nem recuperar esse arquivo para efetuar o backup dos volumes.

## Próximo passo: aprovar janela com backup offline antes da mudança EC2

O próximo passo não é copiar um volume ativo com tar e declarar consistência.
A rotina `backup-posnet-local-volumes.sh` está preparada para a etapa offline:

- Recusa se houver container gravador ativo nos três volumes. Não stop/start/pause
  containers, não altera políticas, não cria snapshots pagos.
- Valida volumes locais e espaço, cria arquivos privados em
  `/var/backups/posnet-local-volumes-*`, preserva ownership/ACLs/xattrs e compara
  os arquivos arquivados com as origens, além de produzir SHA-256/manifest.
- Exige que o operador tenha concluído operações e garantido ausência de gravações
  externas/novos containers durante a cópia. Desligamento forçado ou quiescência
  não confirmada não autoriza alegar consistência da aplicação.
- Não restaura por cima da origem e não declara teste de recuperação do aplicativo.
- Falha mantém backup parcial e bloqueia a mudança; não remover backups existentes.

**Não executar essa etapa agora.** Proposta de janela, para aprovação explícita:

1. Concluir operações POSNET e suspender novas entradas pelo procedimento existente.
2. Encerrar controladamente os 12 containers antes ativos. Registrar sucesso de
   término e interromper a mudança se houver gravação pendente/encerramento forçado.
   Não `compose down`, não remover nada. Como stop manual muda a condição de
   `unless-stopped`, **retornar explicitamente os 12**, não depender só de autostart.
3. Executar a rotina offline por SSH, no mesmo modelo já usado. Só prosseguir com
   `stage=complete/status=ok/tarCompare=ok`, com os três arquivos e hashes presentes.
4. Copiar configurações e arquivos de volumes, por SSH, para destino protegido
   fora da EC2 já disponível (ex.: Mac autorizado com pasta 0700/arquivos 0600),
   e comparar hashes. Contêm segredos e certificados: não publicar, anexar ao chat
   ou subir ao Git. Uma cópia só no mesmo EBS não protege contra perda do disco.
   Não criar armazenamento pago para isso sem aprovação. Não liberar entrada
   pública para transferência nem mudar permissões da origem para facilitar scp.
5. Só então stop EC2 → alterar tipo → start, preservando EIP/ENI/discos.
6. Restaurar arquivos temporários apenas se ausentes, a partir do backup, sem
   sobrescrever divergências. Iniciar os nove backends e depois os três Caddys
   existentes; são os 12 IDs registrados no manifest de configuração. Não iniciar
   rollback/hello-world antes parados. Validar saúde, rotas, SSO e canais POSNET.
7. Retomar operações após validação. Se falhar a etapa de backup/transferência,
   abortar o redimensionamento e retornar os mesmos serviços antes de liberar
   operações. Se falhar o tipo novo, voltar ao original conforme o runbook.

A ordem acima substitui a expectativa anterior de que todos retornariam apenas
por política: os containers parados manualmente precisam de start explícito.
LSports/worker Mac permanecem fora dessa janela; não ativar consumidor AWS.

A previsão de **20–30 min de janela / 5–15 min de parada EC2** não inclui duração
comprovada de arquivamento/transferência. Como o backup offline também interrompe
atendimento, a indisponibilidade total será **backup + transferência + stop/start +
validação**. Não apresentar 5–15 min como limite total garantido. Reservar a janela
com margem e medir o tamanho dos arquivos; se exceder o prazo aprovado, abortar
antes da mudança e retornar serviços, sem sacrificar proteção para cumprir horário.

O custo do tipo aprovado para revisão não mudou: subtotal **US$ 154,02/mês**, mais
**US$ 85,27/mês** versus atual, com exclusões já documentadas. Nenhum recurso novo
ou mudança está autorizado por este registro. Restore Supabase continua não testado
por evidência; PITR permanece desligado. A aprovação operacional deve reconhecer
esse risco e o intervalo desde o backup diário, sem executar restore de produção.

## Autorização financeira e dimensionamento da janela

O operador **autorizou** m7i.xlarge no subtotal US$ 154,02/mês (+US$ 85,27), com
exclusões de tráfego/backups/impostos. Não solicitar aprovação financeira de novo.
O horário de início da parada ainda será combinado. O procedimento concreto de
medição Mac/AWS, transferência protegida e execução/retorno está em
[MAC-BACKUP-WINDOW.md](MAC-BACKUP-WINDOW.md). Primeiro executar apenas `preflight`
e `copy-config`; nenhuma dessas ações para serviços. A estimativa numérica final
depende do relatório real de tamanhos/espaço/transferência, não disponível no workspace.

Preflight e copy-config concluídos pelo operador: espaço suficiente, estimativa
13–31 min, janela proposta 40 min; 35 arquivos/174.261 bytes copiados ao Mac com
SHA-256 verificado. Evidência detalhada em MAC-BACKUP-WINDOW.md. Não repetir.
Autorização financeira mantida; **aguardar confirmação do início** antes de
encerrar os serviços. Backup offline dos volumes permanece próximo passo da janela.

Tentativa de redimensionamento bloqueada por FreeTierRestrictionError; operador
religou EC2 e retornou os 12. Backup offline e cópia verificada já concluídos.
Próxima ação: validação somente leitura de saúde/HTTP e SSO manual, conforme
MAC-BACKUP-WINDOW.md. Não declarar m7i.xlarge ativa nem parar novamente até
concluir validação, tratar restrição de plano AWS e combinar novo início.
Autorização financeira mantida, sem nova solicitação do mesmo valor.
