# Painel ADL — validação local e funcionalidades entregues

## Abrir sem iniciar nenhum worker

No Mac, dentro do checkout existente:

```bash
cd "$HOME/LSports" &&
git pull --ff-only origin feat/sportsbook-demo &&
npm run build &&
node scripts/restart-synthetic-demo.mjs
```

Painel: `http://localhost:3101/control`.
Iframe do cassino de teste: `http://localhost:5174/demo/synthetic`.
Login **exclusivo da demonstração isolada**:
`admin@synthetic.local` / `Solo-pruebas-aisladas-2026`.
Não é uma conta da AWS ou do Argentina Demo.

O runner usa somente `.local-synthetic-demo`, identificado por manifesto. Não
carrega `.env`, não inicia worker, não consulta LSports e rejeita produção. Dados
anteriores da demonstração são preservados, inclusive bilhetes e auditoria. O runner autoriza somente as duas origens locais exatas do cliente sintético:
`http://localhost:5174` (página do cassino) e `http://localhost:3101` (painel).
Ajusta também demos marcados já existentes no reinício, com auditoria, sem
recriar clientes, operações, credenciais ou bilhetes. Não usa wildcard nem
altera as configurações de outros clientes ou da AWS.
A abertura exige credencial ativa; usa somente seu ID no backend, não o segredo.

## Entregue

- Login/logout existentes mantidos; erro de conexão e sessão expirada explícitos.
  Troca autenticada de senha exige a senha atual e encerra todas as sessões
  administrativas da conta. Senhas digitadas permanecem no formulário se houver
  erro e são apagadas ao concluir. Nenhuma senha é registrada em auditoria.
- Recuperação assistida: administrador da plataforma pode restabelecer o acesso
  do administrador de um cliente. Administrador de cliente não pode executar essa
  ação. Sessões administrativas antigas são revogadas; credenciais de integração,
  bilhetes e odds aceitas não mudam. Não há envio de e-mail configurado.
- Cadastro existente de clientes/operações mantido; nome do cliente editável na
  configuração, com escopo verificado no servidor.
- Terminal registrado/editado por operação, com nome, ID e estado. **O primeiro
  registro ativa a verificação do cadastro para POS nessa operação**: novos
  bilhetes/sessões exigem ID ativo. Operações sem cadastro preservam o contrato
  POS anterior. Registre todos os terminais existentes antes de habilitar seu uso.
  Suspensão não cancela bilhetes e não interrompe liquidação. Reenvio idempotente
  via integração backend conserva o bilhete já aceito. Registro não é atestado
  físico do dispositivo; hardware e APK real ainda precisam de homologação.
- Aba Sportsbook: sessão temporária e descartável com cliente/operação/moeda
  fixados no servidor; jogador `control-demo:<adminId>`, separado dos jogadores
  do cassino. Abre o iframe e volta ao resumo sem sair do painel. Web/móvel/POS
  usam o mesmo contrato existente e a validação financeira continua no backend.
- Aba Billetes: paginação de 30, busca por parte do ID ou jogador, detalhes com
  seleções, odds aceitas, resultados e revisões. Consulta usa SQL paginado, não
  carrega o histórico inteiro. Nada é somado entre operações ou moedas. Bilhetes
  legados em pontos continuam separados no fluxo legado existente.
- Estados de carregamento/erro, feed incompleto, sessão vencida; navegação em
  espanhol validada em 390px e tablet 1024px. Dados armazenados não são marcados
  como preços atuais. Não houve mudança de regras de preço, feed ou liquidação.

## Recuperação da conta de plataforma pelo responsável do servidor

Procedimento assistido local, sem endpoint público. Faça primeiro backup normal
recuperável de `control.sqlite` pelo processo operacional aprovado. Prepare um
arquivo JSON regular, pertencente ao operador, com permissão **0600**, fora do
repositório, contendo `action: "recover_platform_access"`, `email` e
`newPassword` (12–256 caracteres). Não use senha em argumentos ou histórico do
shell. Com `PLATFORM_DATA_DIR` apontando para o banco **existente** correto:

```bash
node --import tsx scripts/recover-platform-access.ts < /caminho/protegido/recovery.private.json
```

O comando exige arquivo privado regular em stdin e banco preexistente; não aceita
um pipe público nem imprime dados de entrada. Registra auditoria, revoga sessões
administrativas e preserva integrações e bilhetes. Não foi executado na AWS.
Após uso, mantenha o arquivo fora de sincronização/compartilhamento e aplique a
política local de retenção de segredos. Não forneça seu conteúdo por chat.

## Evidência dos testes e limites

- Build de API/web/worker (checagem de tipos; nenhum worker iniciado).
- Suíte de API/armazenamento: permissões, isolamento, CSRF, expiração,
  preview/domínios, terminais, recuperação CLI, bilhetes, liquidação e preservação
  de arquivos legados. Usa diretórios temporários e dados sintéticos explícitos.
- Navegador Chromium: login, clientes/operações, rotação, iframe autorizado e
  pai bloqueado, bilhete/comprovante, risco, busca/detalhes, terminal, preview no
  painel/retorno, logout, recuperação assistida e tamanhos móvel/tablet.
- Runner sintético: aceite/recusa, limites e concorrência, histórico,
  comprovante, liquidação e correção idempotentes, suspensão sem parar resultados.

Sem deploy, reinícios ou alteração dos workers LSports. Feed AMQP real, snapshots
atuais, odds reais na AWS e integração física com APK/POS permanecem sem validação
nesta etapa. O AMQP 403 segue no ticket #217525. Estes testes não o resolvem.

Prévia do ambiente **isolado com dados sintéticos**, sem conexão à LSports:

![Painel com iframe e retorno ao resumo — prova isolada](previews/control-panel-isolated.png)

## Correção de origem e reinício exclusivo do demo

O erro `DOMAIN_NOT_ALLOWED` era reproduzível porque o manifesto antigo permitia
somente o pai da porta 5174; o backend cria a sessão do painel com `parentOrigin`
igual à origem pública da API/painel, porta 3101. A verificação Origin/CSRF da API
continua exigindo a origem exata do painel; a criação e a troca do código do
iframe continuam exigindo o domínio autorizado. Origens externas seguem negadas.

`restart-synthetic-demo.mjs` identifica os donos das portas 3101 e 5174 e só
encerra normalmente se ambos forem o mesmo processo, pertencente ao usuário,
com diretório deste checkout e comando exato do runner sintético. Revalida a
identidade antes de um único SIGTERM, espera a saída e a liberação das portas e
inicia somente o demo. Não usa kill -9, nomes genéricos de processos ou comando
`npm run dev`. Se as evidências divergirem, bloqueia sem sinalizar outro serviço.
O novo demo fica no terminal; Ctrl+C o encerra normalmente.

Testes específicos: correção idempotente de origens em armazenamento antigo,
negativa de origem externa, manifesto/credenciais preservados, navegador pelos
três canais (Web/Móvil/POS), guardas de identidade/reutilização de PID e reinício
real de um runner com diretório temporário exclusivo. Nenhum acesso à LSports,
POSNET, worker ou ambiente AWS ocorreu nesses testes.
