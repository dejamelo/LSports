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

## Apresentações Web, Móvil e POS

A prévia usa pixels CSS reais, sem zoom ou escala:

| Formato | Dimensão preferida | Apresentação |
| --- | --- | --- |
| Web | 1440 × 900 | Navegação lateral, eventos e bilhete lateral |
| Móvil | 390 × 844 | Uma coluna, cabeçalho compacto, esportes horizontais com quebra de linha, botão inferior do bilhete |
| POS | 480 × 800 | Sem banner grande; busca/eventos/cuotas, alvos de toque de 44–60px e confirmação fixa |

O painel mostra a dimensão **efetiva**. A largura e a altura são reduzidas quando
não cabem na tela externa; o conteúdo reflui, não é reduzido por zoom. Nos formatos
compactos, informações de diagnóstico detalhadas permanecem no painel; o
sportsbook mantém o estado resumido do feed e os bloqueios do backend.

Depois de abrir o iframe, **Formato de la vista previa** muda somente tamanho e
apresentação do mesmo documento. Não recria sessão, não muda o canal autorizado,
não limpa seleções nem o valor digitado. Para mudar o canal de autenticação,
feche o iframe e crie uma sessão nova. A mensagem de apresentação é aceita apenas
do pai da mesma origem; não altera token, credencial, moeda, jogador ou regras.

**Simular teclado abierto** reduz a altura disponível em 320px, respeitando o
espaço mínimo da tela. O bilhete tem conteúdo rolável e confirmação separada;
em alturas pequenas ocupa a área útil e usa seu botão de fechar, liberando o
espaço do atalho inferior. O aplicativo observa resize/VisualViewport e mantém
os campos focados alcançáveis. Isso é validação de viewport reduzido, **não**
homologação do teclado físico, APK, WebView, impressora ou terminal real. Pais de
iframe devem fornecer uma área que acompanhe o viewport disponível do aparelho.

Capturas de dados **sintéticos isolados**:

- [Web](previews/sportsbook-web-isolated.png)
- [Móvil](previews/sportsbook-mobile-isolated.png)
- [POS](previews/sportsbook-pos-isolated.png)
- [Bilhete POS](previews/sportsbook-pos-ticket-isolated.png)

O roteiro `scripts/validate-channel-layouts.mts` testa os três canais autenticados,
redimensionamento sem nova troca de sessão, seleções/valor preservados, tela externa
de 320px, ausência de overflow horizontal e campo/confirmar sem sobreposição,
inclusive na página externa do painel. Os roteiros existentes continuam cobrindo
aceite/recusa, histórico, comprovante e liquidação em armazenamento temporário.

### POS: revisión, confirmación y comprobante (simulación)

En la sesión POS: elegir cuota → informar importe → **Revisar billete** →
**Confirmar simulación** → **Ver billete registrado** → abrir comprobante.
Cambiar importe o selecciones invalida la revisión. El servidor conserva la
validación de origen, sesión, identidad, precios, estado, límites y riesgo.
La presentación POS también muestra revisión cuando se usa como vista previa.

La referencia idempotente se conserva para el mismo contenido. La prueba aislada
intercepta una respuesta DESPUÉS de recibir HTTP 201 del servidor y la pierde:
el reintento devuelve el mismo ID. El bloqueo síncrono evita dos solicitudes por
doble clic. Tras confirmación visible el botón queda deshabilitado hasta armar
otro billete. No cambiar el billete después de una respuesta no confirmada:
consultar historial o reintentar exactamente el mismo contenido. No se promete
continuidad de la clave tras cerrar/recargar una sesión iframe.

El comprobante HTML reutiliza el billete persistido: ID, fecha ISO UTC, evento,
mercado, selección, cuota aceptada, importe, retorno potencial exacto calculado
con cuotas aceptadas, resultado y revisiones. Indica SIMULACIÓN sin valor fiscal
ni monetario. CSS de impresión para rollo de 80 mm, margen de 3 mm. Reabrir e
imprimir no crea apuestas. El navegador abre el diálogo, sin confirmar papel
impreso ni estado físico de la impresora.

No hay APK, SDK Android ni driver de impresora en este repositorio. Existe el
protocolo legado `/api/posnet/test/capabilities` con trabajos y ACK de impresión
para billetes `posnet_test`; no es prueba de compatibilidad ni reemplaza la
sesión POS aislada por cliente/operación. En modo plataforma no se deben abrir
rutas anónimas legadas para conectar un terminal. POSNET Lottery permanece aparte.

Pendiente físico: identificar APK y contrato autenticado/bridge nativo, modelo
de terminal e impresora, SDK/driver, papel (80 mm preparado; 58 mm requiere
adaptación y prueba), teclado Android real, corte de papel, caracteres españoles,
lectura del ID, reconexión y reimpresión del mismo ID. No se validó dispositivo.

### Plataforma AWS recém-inicializada: navegação sem cliente/operação

Causa reproduzida em ambiente isolado: o conteúdo da maioria das abas era
renderizado somente dentro de `client && (...)`. Os handlers alteravam a aba,
mas a área principal voltava ao mesmo estado vazio. A auditoria global também
ficava dentro desse gate; o demo pré-configurado não reproduzia o problema.
Não há evidência de perda de permissão do administrador por esse sintoma.

Correção: Resumen mostra estado global; cada aba dependente indica cliente e/ou
operação necessários; Acceso e Auditoría funcionam sem cliente. Sportsbook
permite abrir o componente existente em somente leitura antes da configuração,
sem fabricar cliente, operação, moeda, credencial ou bilhete. A vista exibe os
erros de conexão e não registra apostas. Na operação configurada, continuam
obrigatórios domínio autorizado e credencial vigente para a sessão do iframe.

Endpoints globais GET `/api/control/feed-overview` e `/api/control/feed-preview`
exigem sessão de platform_admin no servidor. Cliente admin recebe 403; sem
sessão, 401. A página `/control/sportsbook-preview` é apenas shell estático como
/control e pode ser embutida somente no mesmo domínio; os dados são protegidos.
O cookie administrativo permanece HttpOnly e restrito a `/api/control`.
Não se ampliam o cookie, os domínios autorizados nem as permissões de aposta.
Os dados vêm exclusivamente da projeção local; nenhuma consulta LSports nova.

Removida a importação remota de Google Fonts que era bloqueada pelo CSP:
fontes de fallback locais, sem dependência de rede para o funcionamento.
Corrigido também o favicon `/adl.svg`, antes respondido com 404 no modo plataforma.
A vista global de somente leitura não exibe bilhete, valor ou controles de admissão.

Validação local: `scripts/validate-empty-platform.mts` cria plataforma sem
clientes nem operações, com erros AMQP 403 simulados e zero eventos. Percorre
todas as abas, acesso/auditoria, atualização, abertura/fechamento do sportsbook,
orientações por escopo, criação de cliente e formulário de operação, logout.
Confere ausência de erros de JS/rede e de POST de bilhetes. Testes de API
verificam autorização e bloqueio de admissão. Regressões completas de painel e
demo isolados passaram; esse resultado NÃO é validação real do feed AWS.

Não houve acesso autenticado ao painel AWS neste ambiente. A consulta pública
por domínio falhou com EAI_AGAIN; não se afirma ter inspecionado o console ou o
bundle remoto nesta sessão. O deploy informado d6d3d3a já teve a fonte verificada
pelo executor. A atualização usa o mesmo executor API-only, backups e rollback,
sem migração nem mudança de workers. Após aplicar: confirmar installedCommit,
installedSourceVerified, HTTPS/API 200 e navegar no painel com a conta existente.
