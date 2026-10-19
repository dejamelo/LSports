# Dimensionamento da janela, cópia para o Mac e recuperação

## Autorização financeira registrada

O operador autorizou **m7i.xlarge**, subtotal de computação/disco/IPv4
**US$ 154,02/mês**, acréscimo **US$ 85,27/mês**, ciente de tráfego, backups e
impostos adicionais. Não pedir aprovação financeira novamente nesse escopo.
**Horário/início da parada ainda não combinado.** A autorização financeira não
executa nem antecipa a parada. Nenhum recurso pago novo é necessário para estes
arquivos locais, mas a transferência AWS → Mac integra tráfego faturável conforme
franquia/tarifa existente.

Preço, EIP, oferta na AZ, Caddy, políticas dos originfix e backup de configuração
já concluídos. Não repetir suas rotinas. Os scripts abaixo usam o backup privado
existente. Preservar alterações locais no Mac; não reset/clean o checkout.

## 1. Executar agora: somente dimensionamento, sem parada

No Terminal do Mac:

```bash
cd "$HOME/LSports"
git pull --ff-only origin feat/sportsbook-demo
node deploy/homologation/mac-posnet-backups.mjs preflight
```

Usa Node existente e seleciona exatamente uma chave `*Lottery*Key.pem` de
`~/Downloads`. Usa o SSH já identificado e suas host keys, BatchMode/IdentitiesOnly;
não altera permissões da chave nem desativa verificações SSH. Falha se houver
zero/múltiplas chaves, erro de confiança ou sudo não autorizado.

A pasta é **`~/Library/Application Support/ADL/Backups/posnet-aws`**, fora do
repositório e não em Documents/Desktop/iCloud por padrão; diretório 0700 e
arquivos 0600. Não colocá-la no Git ou sincronização pública. Backups contêm
segredos/certificados; usar o Mac autorizado e sua proteção de disco existente.
Não imprimir/anexar arquivos privados. Só compartilhar o relatório JSON sanitizado.

A ação consulta apenas os tamanhos dos três volumes conhecidos, bytes de backup
já existente, espaço livre `/var/backups` e espaço disponível do destino Mac.
Inclui **8 MiB de dados sintéticos** para medir SSH/download (sem conteúdo POSNET,
sem escrever arquivo no servidor), com compressão SSH desligada. Não é uma nova
consulta ao fornecedor, inventário geral, backup nem parada.

Resultado salvo em `preflight-report.json` na pasta protegida. Compartilhar sua
saída: por volume `logicalBytes`, `allocatedBytes`, `archiveEstimateBytes`; Mac/AWS
free/required; velocidade observada; intervalo `estimatedDowntimeMinutes` e
`suggestedWindowMinutes`. Se `insufficient_space`, liberar/aprovar destino antes
da janela; não apagar backups automaticamente. Nenhuma medição real do Mac/AWS
foi feita pelo workspace: é preciso executar este comando no Mac.

As estimativas de tar incluem folga por entrada/metadados. Não são limites rígidos.
Amostra de rede não garante velocidade futura. A parcela disco usa premissa
conservadora de 10–50 MiB/s e oito passes de I/O (criar, comparar, hashes etc.),
**não um benchmark** do EBS. A janela soma quiescência 2–5 min, EC2 5–15 min e
validação 5–10 min, além de backup/cópia; há margem adicional. A taxa observada
inclui negociação SSH, ficando conservadora para volumes grandes. Muita quantidade
de arquivos, variação de rede ou falha pode estender o prazo. Combinar o início
apenas após revisar o relatório e os procedimentos operacionais do POSNET.

## 2. Executar antes da janela: copiar configurações já prontas

Após preflight status ok:

```bash
node deploy/homologation/mac-posnet-backups.mjs copy-config
```

Não cria outro backup no servidor. Lê a cópia privada concluída existente, obtém
SHA-256/tamanho de cada arquivo e transmite por SSH/sudo para subpasta `config-*`
no Mac. Mantém arquivos `.part` privados em caso de falha; só finaliza cada arquivo
após byte count + SHA-256 e releitura SHA-256 do arquivo salvo. `transfer-verification.json` registra o conjunto verificado.
Saída esperada `stage=complete/status=ok/sha256Verified=true`.
Essa transferência pode ocorrer com serviços funcionando, pois a fonte é o backup
imutável, **não dados vivos dos volumes**. Não exige expor arquivos root ao usuário
ubuntu nem mudar permissões do servidor.

## 3. Somente na janela combinada — NÃO executar agora

Estas ações são operacionais separadas da autorização financeira. As flags de
aprovação são declarações explícitas do operador, não um agendador automático.

Concluir as operações POSNET e bloquear novas entradas pelo procedimento existente.
Confirmar ausência de gravações externas/automação concorrente; os scripts não
inventam um endpoint para isso. Quando a aplicação estiver quiescida:

```bash
node deploy/homologation/mac-posnet-backups.mjs stop-services --approved --quiesced
```

Valida os 12 IDs/imagens/mounts/portas/aliases contra o backup existente, para
os três Caddys e depois os nove backends; timeout de encerramento 120 s/grupo.
Não muda políticas nem remove/recria containers. Recusa encerramento forçado
(exit 137/OOM) ou ainda running. Se houver falha, não iniciar backup/redimensionar:
seguir recuperação abaixo. A confirmação de quiescência é responsabilidade do
operador; a rotina não prova término de transações só pelo exit code.

Em seguida, executar o backup offline usando o mesmo SSH. Dentro de um bloco
Bash do Mac (mesma seleção de chave, sem digitar hífens especiais):

```bash
bash <<'MAC'
set -euo pipefail
cd "$HOME/LSports"
keys=()
while IFS= read -r -d '' key; do keys+=("$key"); done < <(find "$HOME/Downloads" -maxdepth 1 -type f -name '*Lottery*Key.pem' -print0)
[ "${#keys[@]}" -eq 1 ] || { echo 'Abortado: esperado exatamente uma chave.'; exit 1; }
ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "${keys[0]}" \
  ubuntu@ec2-77-113-150-100.us-east-2.compute.amazonaws.com \
  'sudo -n bash -s' < deploy/homologation/backup-posnet-local-volumes.sh
MAC
```

Não contém stop/start EC2. Esperar `stage=complete/status=ok/tarCompare=ok`.
Usar **o caminho exato** `/var/backups/posnet-local-volumes-...` emitido:

```bash
node deploy/homologation/mac-posnet-backups.mjs copy-volumes /var/backups/posnet-local-volumes-CAMINHO_EMITIDO
```

Substituir o caminho, não usar esse placeholder literalmente. A cópia valida os
três archives contra o manifest do backup e verifica SHA-256 após download;
não extrai/restaura nada. Não reutilizar um diretório parcial como completo.
Salvar a saída e o destino `volumes-*` no Mac. Ambos backups ficam privados e
os originais no servidor são preservados. Sem cópia completa verificada fora do
EBS, não avançar para a mudança.

Depois de cópia verificada, executar a sequência EC2 já documentada em
EC2-RESIZE-RUNBOOK.md, com InstanceId oficial: stop, wait stopped, modify tipo,
start, wait checks. Não repetir a cotação ou comparação Caddy prévia.

## 4. Recuperação dos serviços se backup/cópia falhar

Se a EC2 ainda está funcionando e a falha foi no backup/cópia, **não redimensionar**:

```bash
node deploy/homologation/mac-posnet-backups.mjs recover-services --approved
```

Usa os mesmos 12 containers existentes, restaura apenas os dois Caddyfiles `/tmp`
se estiverem ausentes e seus backups tiverem hash correto; não sobrescreve
arquivos diferentes/symlinks. Inicia os nove backends e depois os três Caddys,
sem iniciar rollback/hello-world antes parados. Recusa divergência de identidade,
imagem, mounts/portas/aliases; não resolve isso recriando containers.

O resultado `running_not_application_validated` **não libera operações** sozinho:
aguardar Docker healthchecks e validar URLs públicas, SSO, staging e canais POSNET.
Só então reabrir entradas. Conservar backups e `.part`, não restaurar banco/volumes.
Se a conexão cair durante stop/start, pode haver aplicação parcial: usar o mesmo
retorno dirigido após restabelecer SSH e revisar status; não repetir às cegas.

## 5. Recuperação se redimensionamento falhar

Se a EC2 está parada ou não chega a running, o SSH não funciona. No CloudShell da
conta correta, somente durante a janela combinada, com o InstanceId já confirmado:

```bash
aws ec2 stop-instances --region us-east-2 --instance-ids INSTANCE_ID_CONFIRMADO
aws ec2 wait instance-stopped --region us-east-2 --instance-ids INSTANCE_ID_CONFIRMADO
aws ec2 modify-instance-attribute --region us-east-2 --instance-id INSTANCE_ID_CONFIRMADO --instance-type '{"Value":"c7i-flex.large"}'
aws ec2 start-instances --region us-east-2 --instance-ids INSTANCE_ID_CONFIRMADO
aws ec2 wait instance-status-ok --region us-east-2 --instance-ids INSTANCE_ID_CONFIRMADO
```

Se já stopped, não precisa solicitar stop novamente. Confirmar cada etapa antes
da seguinte. Isso reverte só o tipo na mesma instância; não terminate, detach,
release EIP, restore nem cria outra instância/AZ. A volta também depende de capacidade.
Depois de SSH restabelecido, executar `recover-services --approved` e validar o
POSNET. Não retornar políticas originfix a no. Dados corrompidos exigem outro
procedimento autorizado de restore; não extraímos archives sobre produção.

Em caso de sucesso do tipo novo, o mesmo `recover-services --approved` é o retorno
normal dos 12 após boot, porque eles foram parados manualmente. LSports continua
sem deploy nem ativação de consumidor nesta janela. Não repetir migrações.

## Evidências recebidas: preparação concluída, início ainda não confirmado

Preflight informado pelo operador: `2026-10-19T00:13:03.116Z`, equivalente a
**18/10/2026, 21:13:03 de Brasília**. Resultado `status=ok`, sem stop solicitado:

| Volume | Bytes lógicos | Estimativa de arquivo |
|---|---:|---:|
| Replay originfix | 11 | 69.643 bytes |
| Replay anterior | 11 | 69.643 bytes |
| Dados Caddy | 17.835 | 210.347 bytes |
| Total | 17.857 | 349.633 bytes |

Espaço informado: Mac **104.053.583.872 bytes** livres; servidor
**26.817.519.616 bytes** livres. Ambos passaram nas margens previstas. Amostra SSH
8 MiB: aproximadamente **1,68 MiB/s**. Estimativa total **13–31 minutos**, com
**janela sugerida de 40 minutos**. São medidas/amostra do preflight, não SLA.

`copy-config` concluído: `stage=complete`, `status=ok`, **35 arquivos**, **174.261
bytes**, `sha256Verified=true`, `noStopRequested=true`, em subpasta `config-*` de
`~/Library/Application Support/ADL/Backups/posnet-aws`. Evidência fornecida pelo
operador; não repetir cópia/preflight. Os dados dos três volumes ainda aguardam
a etapa offline e sua cópia verificada fora da EC2.

A autorização financeira já está concedida. A janela de 40 minutos foi apresentada,
mas **a confirmação de início ainda não foi dada**. Nenhum stop/start de serviço ou
EC2 está autorizado para execução agora. Não criar agenda/horário automaticamente.

Após confirmação explícita de início e término das operações POSNET, primeiro
comando operacional no Mac:

```bash
cd "$HOME/LSports" && node deploy/homologation/mac-posnet-backups.mjs stop-services --approved --quiesced
```

A flag `--quiesced` declara que o operador já concluiu operações e impediu novas
entradas pelo procedimento atual; o script não faz essa parte automaticamente.
Sem isso, não executar. O comando encerra os 12 containers preservados, não para
nem redimensiona EC2. Esperar `stage=complete/status=ok/action=stop/containers=12`
antes da etapa offline. Falha não é sucesso parcial aceitável: preservar saída e
seguir o retorno dirigido, sem avançar para EC2.

## Ocorrência: FreeTierRestrictionError e recuperação

O operador informou que a alteração para m7i.xlarge foi bloqueada por
`FreeTierRestrictionError`, religou a mesma EC2 e retornou os **12 containers**.
A saída `running_not_application_validated` confirma execução, não saúde/SSO.
Não declarar redimensionamento concluído. Não repetir stop/backup/cópia agora.
Backup offline dos três volumes e cópia no Mac já concluídos, com tar compare e
SHA-256 verificados (4 arquivos/103.399 bytes conforme saída). Preservar backups;
se novas operações ocorrerem, avaliar atualização do ponto de backup na futura
janela, sem restaurar um ponto antigo para desfazer operações novas.

### Validação pós-retorno, sem escrita de aplicação

No Mac, atualizar a branch e executar:

```bash
cd "$HOME/LSports"
git pull --ff-only origin feat/sportsbook-demo
node deploy/homologation/mac-posnet-backups.mjs validate-services
node deploy/homologation/validate-posnet-pages.mjs
```

Primeiro comando: só inspect dos 12 containers e comparação com o backup de
identidade/imagens/mounts/portas/aliases. Mostra running, health, OOM, restartCount
e horário/exit code da última checagem, nunca Output dos healthchecks ou env.
`status=ok` exige apps healthy e proxies running (proxies sem healthcheck não
são apresentados como tendo HTTP validado). Não restaura arquivos nem start/stop.

Segundo comando: GET público HTTPS em www/demo, com TLS verificado, HTML e amostra
JS/CSS, sem cookies/tokens/credentials/login/apostas. Redirecionamento externo
exige conferência manual e não é seguido; nenhum header/query/body sensível é
impresso. HTTP 200 com HTML no lugar de JS/CSS falha. Essa amostra não testa todos
os assets nem autenticação. O workspace recebeu 403 do próprio proxy de saída
nas tentativas de acesso público: não é diagnóstico HTTP do POSNET.

### SSO autenticado — navegador, fluxo habitual

1. Abrir a origem habitual autorizada e autenticar-se normalmente, sem enviar
   senha/token/cookies ao chat. Usar janela privada se for necessário separar
   sessões, respeitando o fluxo e as permissões existentes.
2. Iniciar um **novo** acesso SSO ao POSNET pela origem; não reutilizar URL/token
   antigo nem dar refresh em callback de uso único como se fosse um novo login.
3. Confirmar destino www/demo apropriado, usuário/permissões esperados, ausência
   de loop de login e navegação normal em uma página autorizada sem nova exigência
   indevida de autenticação. Não criar vendas/apostas/pagamentos para testar.
4. Informar apenas sucesso/falha, origem/destino sem query e mensagem sanitizada.
   Não anexar HAR, headers, URLs completas de SSO, tokens, cookies ou payloads.

Sem essa evidência, `authenticatedSsoValidated` permanece false. Página HTTP ok e
healthcheck não provam SSO. A validação não deve ser declarada concluída antes
da saída remota/Mac e confirmação funcional no navegador.

### Próxima tentativa de ampliação

Primeiro concluir saúde/páginas/SSO. Depois conferir a indicação do plano na
console AWS e a opção oficial de atualização do Free Plan para Paid Plan, se essa
for a restrição confirmada na conta; não inventar comando CLI de upgrade.
A aprovação financeira da m7i.xlarge continua válida; não pedir de novo o mesmo
valor. Ler a tela real e condições/cobranças do plano antes de confirmar mudança
de conta. Nenhum upgrade de conta, nova instância, recurso ou nova parada foi
executado pelo workspace. Combinar novo início operacional depois de resolver a
restrição; não parar novamente só para testar se a conta já permite a troca.
