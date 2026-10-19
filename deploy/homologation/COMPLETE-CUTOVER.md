# Corte Mac → AWS: consolidação e execução única

## Evidência já aceita; não repetir preparo/publicação/redimensionamento

- EC2 m7i.xlarge concluída; POSNET retornou e foi validado.
- API ADL saudável, HTTPS/aplicação confirmados e credenciais do fornecedor
  armazenadas em arquivo protegido. Preservar os composeOverrides salvos.
- Nenhum worker AWS iniciado. Mac tem o dono do lock PID 12811 e pai 12809;
  ambos suspensos conforme verificações anteriores. Journals/checkpoint legíveis
  e estáveis, não migrar bilhetes nem a plataforma Argentina Demo do Mac.
- SIGTERM anterior enviado sem conclusão. Campo macOS ps pending/sig foi retirado
  como gate por usar p_siglist legado; não inferir ausência de sinal/handler.
- A retomada não enviou sinais: bloqueou no tipo do pai, antes do backup/intent.

## Coleta consolidada concluída

O relatório recebido identificou o pai 12809 como concurrently suspenso, com UID e
cwd corretos; faltava somente o marcador de CLI TSX exigido pelo gate anterior.
O procedimento atual está na seção “Um único comando de execução no Mac”. Não é
necessário executar novamente o diagnóstico manual; o executor faz a revalidação
somente leitura antes de agir. O restante desta seção descreve a coleta já feita.

O relatório único contém:

- Mac: auditoria completa de processos/locks/journals/checkpoint/cooldown, cadeia
  de até quatro processos com PID/PPID/UID compatível/cwd classificado/estado T,
  grupos de job control, filhos/siblings por tipo, assinatura do launcher e **cada
  verificação que falhou** no gate atual. Distingue shell, CLI tsx, node --import,
  workspace relativo, watch, concurrently, outros targets web/API e expressões
  compostas. Argumentos são um esboço aproximado com valores/caminhos desconhecidos
  redigidos; isso é evidência para o plano, não autorização para retomar shell.
- Mac: estabilidade em cinco segundos, margem de disco para backup privado,
  origem configurada do state e prazos preliminares. Sem cópia de .env ou payloads.
- AWS: API saudável e worker parado, todos os overrides legíveis, imagem/usuário
  resolvidos, gates atuais, volumes isolados/UID/GID e existência de locks/journals,
  credenciais presentes com permissões, memória física disponível, disco e limites
  PM/IP configurados. GET local de status informa se há admin inicializado e modo
  financeiro simulado; não usa credenciais administrativas nem imprime segredo.
- Seção remota falha sem ocultar as demais independentes. Falha dependente informa
  a etapa, nunca texto bruto de Docker/modelo secreto. Não repetir DNS/TLS já
  confirmados nem iniciar diagnose:trade em paralelo ao consumidor.

status=collected significa que a coleta terminou, **não** liberação do corte.
readyToStartAWS permanece false. A saída identifica toda a informação necessária
para finalizar uma execução única; se houver campo unverified, sua etapa/reason
fica no mesmo documento, não como uma nova tentativa de sinal.

## Contrato do executor final, após identificação do pai

O comando de execução final deverá seguir os pontos abaixo sem pedir novamente
aprovação financeira/manutenção, e sem parar em cada etapa para um novo comando.
O executor está implementado em `complete-adl-cutover.mjs`. Os testes locais e
os testes remotos com Docker simulado estão descritos abaixo. Sua execução real
no Mac/AWS ainda precisa ser confirmada pela saída; não há acesso à chave do Mac
neste workspace.

1. **Preflight único**: revalidar identidade PID/início/UID/cwd e relação pai-filho,
   confirmar único consumidor Mac e worker AWS parado. Decidir retomada apenas
   para launcher dedicado demonstrado, nunca shell/supervisor genérico presumido.
2. **Backup e parada**: backup 700/600 fora do Git do checkpoint/journals/lock,
   SHA-256 fonte/cópia/manifesto e espaço suficiente; retomar identidades verificadas,
   TERM dirigido somente após retomada/revalidação se necessário; nenhum KILL.
   Aguardar persistência, saída, locks liberados e estabilidade; falha real bloqueia
   sem repetir sinais ou excluir locks. Intenções preservadas impedem repetição.
3. **Exportar**: auditoria fresca sem processos/locks; gerar handoff só dos journals
   e notBeforeUTC máximo de prazos compartilhados/por operação, Retry-After e
   intervalo após shutdown + margem. Não transferir checkpoint, DB ou bilhetes Mac.
4. **Importar/coordenar**: SSH para volume ADL confirmado, com backup e manifesto;
   conferir hashes, preservar prazos AWS já existentes (nunca encurtar por importação),
   criar apenas arquivos de scheduler com UID do worker, sem chown do volume inteiro.
   Não tocar assinaturas/filas. Importação parcial bloqueia partida e informa etapa.
5. **Esperar e partir**: aguardar prazo efetivo exibindo progresso. Só então afirmar
   gates de capacidade/Mac parado/notBefore via configuração específica do worker,
   preservando TODOS os overlays. Comparar modelo: nenhuma mudança incidental.
   Compose up de somente worker com --no-deps/--no-build/--pull never e profile
   feed-consumer. Consume exclusive/noAck=false e persistência antes do ACK intactos.
6. **Validar**: processo isolado, PM4511/IP4510, snapshots desta execução concluídos,
   handoff completo, regularSnapshotReady=true, atualizações efetivas de mercado
   distintas de keepalive. Confirmar candidatos abertos com preço atual pela API.
   Não forçar available, reaproveitar odds antigas, inventar dados ou repetir HTTP
   antes do retryAt. Emitir relatório único de sucesso ou falha local/fornecedor.
7. **Iframe e retorno**: acessar operação/sessão autenticadas da homologação separada.
   Em falha, manter AWS e Mac sem consumo simultâneo. Qualquer volta ao Mac exige
   primeiro parar AWS e importar seus prazos de volta. POSNET nunca é alvo do fluxo.

## O que ainda falta para dados reais e iframe na AWS

- Launcher identificado e política corrigida; executar parada/exportação/importação.
- Respeitar cooldown e iniciar um só consumidor por feed com limites PM256/IP128,
  container4GiB/heap3072, sem remover admissão de memória.
- Validar **realmente** credenciais HTTP/AMQP, distribuição e snapshots sob a nova
  memória. Credenciais gravadas e HTTPS funcionando ainda não comprovam isso.
- Receber eventos/mercados abertos atuais do pacote Test. Se só houver encerrados,
  resumir razões locais e IDs para LSports; não reabrir nem inventar odds.
- Confirmar bootstrap/admin na AWS e configurar seu próprio cliente/operação,
  domínio permitido, credencial backend e sessão iframe temporária. Status local
  do painel só comprova inicialização, não esse caminho autenticado. Manter moeda,
  isolamento, limites, risco e bilhetes/carteira simulados.

O setup do iframe administrativo é independente do consumidor: o feed pode ser
validado tecnicamente antes de uma operação estar pronta para incorporação.
Nenhuma etapa usa dados/tickets do Mac para preencher a homologação AWS.


## Relatório consolidado recebido e solução aplicada

Coleta de 19/10/2026 00:01:56 de Brasília (03:01:56 UTC): dono 12811,
Node com `--import tsx`, estado T; pai 12809 é Node executando **concurrently**,
também T; ancestral npm 12799 também T. Ambos os últimos são supervisores,
não dois consumidores. A validação TSX falhava por exigir `tsx/dist/cli` no pai.
O campo de sinais pendentes do macOS não é usado como autoridade.

**Somente o dono recebe SIGCONT** quando o pai observado é concurrently. O pai
compartilhado e o npm permanecem suspensos: nenhum sinal de grupo, TERM no pai ou
retomada dos outros comandos. Um launcher TSX dedicado continua com o fluxo
anterior. Identidade, início, UID, cwd, relação pai-filho e lease são revalidados.
Depois do backup SHA-256, uma intenção durável impede repetir sinais. Se o dono
continuar executável após a graça, no máximo um TERM dirigido é permitido.

Com pai suspenso, o filho pode sair e ficar Z até o pai coletar seu status. Z é
processo encerrado, sem execução nem descritores; NÃO é T. O coletor não o conta
como consumidor, mas exige liberação normal de TODOS os locks e journals estáveis.
Um concurrently T não é contado pelo texto do comando do filho; se estiver em
execução ele volta a bloquear a exportação. **Não execute fg, não retome o npm
antigo e não execute npm run dev após o corte.** Nenhum lock é removido manualmente.

AWS: API saudável/200, credenciais presentes em 600/700, dois overlays legíveis,
nenhum worker/checkpoint/journal/lock no volume isolado, aproximadamente 14,1 GiB
MemAvailable e 24 GiB livres. Plataforma ainda `initialized=false`: o bootstrap,
cliente/operação e sessão temporária de iframe são uma etapa administrativa
separada, não preenchida com bilhetes ou dados do Mac.

## Um único comando de execução no Mac

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/complete-adl-cutover.mjs --pid 12811
```

O PID é explícito, mas nunca confiado isoladamente. Se mudou ou houve reutilização,
o executor bloqueia por identidade. Não repita este comando após falha real sem
ler a etapa: intenções, backups e importações parciais são preservados.

O comando revalida as condições essenciais (sem repetir manutenção POSNET), faz
backup/parada/exportação, importa somente journals por SSH e mostra `notBeforeUTC`.
Espera automaticamente o maior prazo local/remoto, reaudita ausência do consumidor
Mac imediatamente antes da partida e inicia apenas `worker` com os overlays salvos.
A partida é exclusive por fila e sem ACK antecipado, build, pull ou recriação da API.
Não há chamadas HTTP paralelas de diagnose ao fornecedor. O próprio scheduler
continua responsável pelos limites e retryAt.

A importação faz backup dos journals AWS existentes, verifica leitura após gravação,
usa UID/GID do volume e arquivos 600, fsync e rename; não encurta prazos existentes.
Há recibo por hash do handoff e backup da configuração. Um overlay adicional muda
somente os três gates operacionais do worker; o modelo completo precisa ser
idêntico fora desses campos. Nenhuma alteração de Caddy, POSNET, assinaturas ou
bilhetes. Falha após importação informa backup e arquivos já gravados; não desfaz
coordenadores nem liga o Mac automaticamente.

A observação por até 15 minutos lê o checkpoint com orçamento de memória e informa
sessões, snapshots, handoff, diagnósticos, últimas atualizações efetivas/controle e
contagens de eventos/preços/seleções. Só retorna `snapshots_verified` com uma única
instância AWS ativa, publicação recente e snapshots completos de ambas as sessões
iniciadas nesta partida. Keepalive não prova atualização de mercado. Zero seleções
não é convertido em sucesso de odds. `validation_pending` conserva o worker e seus
prazos; não é instrução para reiniciar nem repetir consultas.

O relatório distingue `projectionOddsAvailable`, `authenticatedApiVerified=false`
e `iframeAuthenticated=false`. Receber odds no checkpoint não comprova ainda a
sessão de incorporação autenticada. Depois do feed, falta criar o administrador
AWS e configurar sua operação/sessão no painel exclusivo. Nenhuma senha é pedida
no chat e nenhum segredo LSports vai ao navegador.

## Testes desta correção

- 42 testes Node de identidade/parada, recuperação, processo OS suspenso, zumbi,
  exportação e cooldown: passaram. Incluem supervisor realmente suspenso que só
  é retomado no cleanup do próprio fixture isolado, após verificar filho encerrado.
- 4 testes Python: merge por máximos, rejeição de journals inválidos e fluxo
  importação/recusa por cooldown/partida somente do worker com overlays preservados; rejeição de snapshots de sessões antigas.
  Docker/SSH são simulados nesses testes; não comprovam conexão real LSports.
- Typecheck dirigido dos módulos de parada e sintaxe do executor verificados.

A confirmação final dos feeds reais depende da execução no Mac. Se fornecedor
recusar autenticação/distribuição, enviar 429 ou apenas eventos encerrados, os
códigos e retryAt ficam visíveis; nenhuma proteção é removida para apresentar odds.
