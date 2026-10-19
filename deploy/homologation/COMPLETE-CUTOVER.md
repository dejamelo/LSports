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

## Única informação crítica ainda não identificada no Mac

A saída STOPPED_PARENT_NOT_VERIFIED_TSX_LAUNCHER informa que o predicado composto
falhou, mas não identifica o executável/forma do pai nem qual condição falhou.
Não sabemos se é shell dedicado, node --import, CLI tsx, npm/concurrently/watch,
outro diretório ou outro usuário. Retomar um supervisor amplo poderia afetar
outros processos ou recriar o consumidor. Não autorizar isso por correspondência
solta da palavra worker. O código já confirma identidade do dono; a dúvida é o
launcher pai. Nenhum novo sinal é necessário para identificar essa informação.

## Uma única coleta local + AWS, com verificações independentes

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
node deploy/homologation/inspect-complete-cutover.mjs --pid 12811
```

É diagnóstico somente leitura, não nova tentativa de recuperação. Não envia
CONT/TERM, não remove locks, não exporta nem escreve dados, não faz consultas
LSports, não inicia containers ou altera Caddy/overrides/POSNET. Usa a chave SSH
existente pelo padrão Lottery.*Key.pem; nunca pede/exibe seu conteúdo.
Coleta Mac e AWS independentemente, inclusive se uma coleta falhar.

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
Ele ainda não é liberado: falta o relatório acima para definir a política do pai
com evidência. Não anunciar como pronto/validado um executor remoto não executado.

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

- Resolver o launcher com a coleta única; concluir parada/exportação/importação.
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
