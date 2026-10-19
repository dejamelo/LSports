# ADL / LSports · implantação AWS autorizada em etapas

**Estado atual prevalece sobre as notas históricas abaixo:** EC2 m7i.xlarge já
validada pelo operador; POSNET retornou saudável. Domínio autorizado
`sportbook.apuestadeportiva.lat` (sem s após sport), A cadastrado para
77.113.150.100. Homologação AWS separada; Argentina Demo e bilhetes ficam no Mac.
Não repetir redimensionamento ou migrações. Ver [ADL-EXECUTION.md](ADL-EXECUTION.md)
para comando de preparação da API isolada, DNS, HTTPS e corte único com cooldown.
Credenciais/chave estão no Mac; execução remota precisa das saídas do operador.

## Histórico da preparação inicial

Iframe, painel e API com feed LSports Test e bilhetes/carteira exclusivamente simulados. Projeto independente do POSNET Lottery. Nenhum serviço AWS foi acessado ou alterado nesta entrega; não há destino SSH, AWS CLI/credenciais ou conector AWS disponíveis no workspace. Não é possível declarar RAM/CPU/disco suficientes sem o diagnóstico do host.

## 1. Primeiro: inventário somente leitura

No Mac, depois de atualizar esta branch, substituir usuário/host e executar **um único comando**:

```bash
ssh USUARIO@HOST_AWS 'bash -s' < deploy/homologation/diagnose-host.sh > diagnostico-aws.txt
```

O script local é enviado ao shell remoto: não precisa clonar ou instalar nada no servidor. Mede RAM disponível/swap, CPU/carga atual, disco/inodes, portas, Docker/Compose, serviços, containers e limites já existentes, redes e destinos de volumes. Não imprime env/config/logs de containers, credenciais ou argumentos de processos. Não executa instalação, prune, restart, reload ou mudanças de configuração. Não usa sudo; falta de permissão deve ser resolvida pela coleta com um operador autorizado, nunca alterando o daemon ou grupos automaticamente. A coleta não mede picos históricos: comparar com métricas existentes do período de maior uso do POSNET antes de aprovar capacidade.

## 2. Proposta de capacidade — condicional ao inventário

| Componente ADL | Teto RAM | Heap Node | CPU máxima | Persistência |
|---|---:|---:|---:|---|
| Worker único | 4 GiB | old-space 3 GiB | 2 vCPU | feed/checkpoint/journal + plataforma |
| API/painel/iframe | 768 MiB | old-space 512 MiB | 0,5 vCPU | plataforma; feed somente leitura |
| Caddy atual | reutilizado | — | medir atual | volumes/configuração atuais preservados |
| Proxy opcional, somente se não existir Caddy | 128 MiB | — | 0,25 vCPU | certificados/configuração próprios |

Aumentar o heap não é solução para a falta de RAM física observada no Mac. Estes são limites **novos para containers isolados na AWS**, não alterações no Mac ou na instância. O worker admite PreMatch 256 MiB / InPlay 128 MiB somente se a margem real satisfizer `min(heap restante, memória disponível)` >= `8 × teto + 64 MiB`. Para PreMatch são 2.112 MiB; estado residente e aplicação consomem memória adicional. O teto do container não garante essa margem no host.

Condição inicial conservadora: memória **disponível adicional** para os tetos ADL (4,75 GiB sem novo proxy) + pelo menos 1 GiB de folga do host, sem consumir reservas/picos do POSNET; CPU livre para ADL sem saturar os serviços atuais; pelo menos 10 GiB de disco/inodes livres após considerar imagens, dados e backups. São critérios de triagem, não certificação de carga. Se a infraestrutura não comportar isso, **não iniciar** e não criar/redimensionar recursos: apresentar a insuficiência para decisão posterior. Limites são ajustáveis no arquivo de proposta somente após medir; não reduzir a proteção do snapshot para fazê-lo caber.

## 3. Isolamento e segredos

- Sempre usar `docker compose -p adl-homologation ...`; nunca reutilizar projeto, volumes ou diretórios do POSNET.
- Compose principal inicia somente API por padrão. Worker está no profile `feed-consumer`, exige gates explícitos e tem restart automático desativado. Após reboot/OOM, investigar e verificar novamente o corte antes de iniciá-lo. O loop interno do worker continua persistente/reconecta falhas de transporte.
- API publica somente `127.0.0.1:13001`, condicionado a essa porta estar livre. O Compose padrão não publica 80/443. O proxy novo é um profile separado `standalone-proxy`, que **não deve ser usado** se essas portas/Caddy já pertencem aos serviços atuais.
- Caddy de host: novo site a partir de `Caddy.existing-host.snippet`, apontando a loopback. Caddy em container: `compose.existing-caddy.yaml` conecta somente a nova API à rede já existente, com alias `adl-homologation-api`; o novo site aponta a esse alias na porta 3001. Não sobrescrever o Caddyfile atual, não remover rotas POSNET, não abrir portas, não recarregar Caddy nesta preparação.
- `deploy.env.example`: parâmetros não secretos, imagem identificada por commit, limites e gates. `api.env.example`: origem pública HTTPS. `worker.env.example`: endpoints/filas atuais Test e credenciais somente do worker. `bootstrap.env.example`: conta inicial administrativa, arquivo temporário.
- Arquivos reais em `/etc/adl-homologation/` com diretório 700 e arquivos 600, fora do Git. Não colocar senha em argumentos, chat, imagem ou navegador. Proxy recebe apenas hostname/CIDRs; API não recebe credenciais LSports.
- Containers sem privilégios, raiz somente leitura, tmpfs limitado, logs JSON com rotação 10 MiB × 3 por serviço. Volumes nomeados `feed-data` e `platform-data`, prefixados pelo projeto. `TEST_TICKETS_DB` aponta para um arquivo separado no volume de plataforma: a API não tenta criar SQLite na montagem de feed somente leitura. Não montar `.runtime` ou banco do POSNET.
- Homologação usa nova plataforma/cliente/operações de teste; não copia bancos, chaves, bilhetes, backups ou `.env` do Mac. Os bilhetes e odds já existentes permanecem no Mac. Uma migração desses dados exigiria outro plano auditado, não executado aqui.

## 4. Plano de corte: Mac → AWS, sem consumidores simultâneos

1. Aprovar capacidade com o inventário e picos atuais. Confirmar domínio, CIDRs administrativos, porta livre e forma do Caddy. Montar arquivos reais protegidos e construir a imagem fora do pico do POSNET, preferencialmente em CI/outro ambiente. Não criar recursos pagos nem fazer resize.
2. Preparar API/volumes/conta administrativa de homologação, **sem profile do consumidor**, somente após autorização de deploy. `/control` saudável não prova feed conectado. Registrar backup inicial consistente e recuperação; snapshots EBS/S3 novos não estão autorizados.
3. No Mac, registrar diagnóstico de conexões, maior `retryAt` e prazos de operações bem-sucedidas (última tentativa + intervalo); suspender novas apostas simuladas se necessário. Encerrar seu worker pelo Ctrl+C normal, aguardar persistência e `worker.shutdown` com lock liberado. Verificar que o PID proprietário não está rodando. Não matar todos os processos Node nem apagar locks.
4. Confirmar no operador/painel que não há outro consumidor desses mesmos pacotes/filas. Não usar `stopDistribution`, cancelar assinaturas ou criar filas. Os gates da AWS são **confirmações do operador**, não detecção remota/fencing automático do Mac.
5. Definir `ADL_CAPACITY_APPROVED=yes`, `ADL_MAC_WORKER_STOPPED=yes` e `ADL_SUPPLIER_NOT_BEFORE_UTC` como barreira UTC posterior a **todos** os cooldowns/Retry-After e intervalos já reservados no Mac. Não copiar arquivos `.lock`; não iniciar com journal vazio para antecipar consultas. Se esses prazos não puderem ser apurados, não iniciar. Verificar relógio UTC/NTP do host.
6. Só após essa revisão/autorização, iniciar um único worker com profile `feed-consumer`. O launcher bloqueia falta de confirmação, horário prematuro, configuração inválida ou memória insuficiente antes de importar o worker/provedor. A checagem de memória é repetida depois da restauração, antes de cada HTTP.
7. Validar conexões, snapshot regular realmente concluído, handoff, status/odds e processamento do tipo 40. Não aceitar preços antigos, mercados encerrados ou HTTP 200 como único sucesso. Validar bilhetes simulados novos, idempotência e settlement/correção. Não declarar conexão real validada antes disso.

Rollback: suspender novas aceitações AWS, manter liquidação até resolver os bilhetes de homologação pendentes, fazer backup consistente e parar o worker AWS normalmente. Confirmar ausência do consumidor AWS antes de reativar o Mac, respeitando também os prazos AWS. Não sobrepor bancos diferentes ou abandonar bilhetes pendentes. Local file locks não impedem consumidores em hosts diferentes; não prometer failover automático.

## 5. Validação estrutural sem segredos nem deploy

```bash
API_ENV_FILE=./api.env.example WORKER_ENV_FILE=./worker.env.example \
  docker compose -p adl-homologation -f deploy/homologation/compose.yaml config --quiet
API_ENV_FILE=./api.env.example WORKER_ENV_FILE=./worker.env.example ADL_CADDY_NETWORK=rede-existente-exemplo \
  docker compose -p adl-homologation -f deploy/homologation/compose.yaml \
  -f deploy/homologation/compose.existing-caddy.yaml config --quiet
```

Usar `config --quiet` com arquivos reais; imprimir config completa ou `docker inspect` sem seleção pode revelar segredos. Não executar `compose up`, bootstrap, reload, `down -v`, prune ou alteração de serviços nesta etapa. O Dockerfile continua usando lockfile, TLS verificado e usuário sem privilégios; suporte a CA pública via build secret já está preparado. A imagem da revisão atual ainda deve ser construída e identificada pelo commit antes da publicação.

## 6. Custos e pendências antes de publicar

**Recursos pagos novos propostos nesta etapa: nenhum.** Se couber no host e nos volumes já provisionados, não se propõe custo fixo incremental de EC2/EBS, ALB, NAT, novo IP público ou nova instância. Isso não garante fatura adicional zero: tráfego de saída, DNS e backups/monitoramento eventualmente contratados dependem da região, franquias e serviços existentes. Instâncias burstable (por exemplo T3/T4g) em modo Unlimited também podem cobrar créditos excedentes de CPU, mesmo sem resize; confirmar família/política de créditos antes de aprovar a carga. Caddy/Compose não exigem licença paga; certificados ACME não têm tarifa do Caddy. Nenhum CloudWatch/S3/EBS snapshot ou recurso novo foi criado. Antes de qualquer recurso pago, apresentar preço e obter autorização.

Pendente: inventário AWS real, folga sobre picos POSNET, região/arquitetura, egress/allowlists atuais, domínio/CIDRs, estratégia de backup no armazenamento existente, orçamento de retenção e autorização de deploy. O fechamento AMQP 320 do Mac e `distribution_still_off` são questões separadas: pedir ao fornecedor o motivo sanitizado nos horários UTC documentados, sem atribuir ao orçamento de memória ou alegar que mudar de host resolve. O objetivo permanece feed real **Test** e bilhetes simulados; carteira real não está habilitada.

### Revisión del servidor recibido (2026-10-18)

El c7i-flex.large de 3,72 GiB utilizables y 1,92 GiB disponibles no admite el
presupuesto del worker con snapshot de 256 MiB. No desplegar en esa capacidad.
Ver [CAPACITY-REVIEW.md](CAPACITY-REVIEW.md) para evidencia, diagnóstico Docker
complementario sólo lectura, opciones de ampliación/servidor separado, cálculo
de costos pendiente de región y estimación de indisponibilidad. Ningún cambio
remoto ni compra está autorizado hasta aprobar importe y ventana.

El colector Docker fue corregido para continuar por container e identificar
fallos sanitizados. También resume rutas de la configuración activa de Caddy,
servicios habilitados de systemd y, si la AWS CLI existente lo permite, precios
On-Demand oficiales de Ohio. No sustituye la revisión de scripts de arranque;
`restartPolicy=no` sin mecanismo externo confirmado bloquea el redimensionamiento.
Validación local: `python3 deploy/homologation/test-diagnose-docker.py`.

La corrección de arranque de los dos backends que atienden las rutas actuales
está propuesta, **no aplicada**, en [POSNET-BOOT-PLAN.md](POSNET-BOOT-PLAN.md),
con comandos de backup, cambio de política y reversión. Antes de stop/start,
comparar Caddy activo vs configuración de inicio con `check-posnet-caddy-boot.sh`.
Los campos de cotización oficial en AWS Pricing Calculator están al final de
CAPACITY-REVIEW.md; las tarifas anteriores no se consideran confirmadas.

El operador confirmó aplicación correcta de las dos políticas originfix, sin
restart. El siguiente plan, aún no autorizado, está en
[EC2-RESIZE-RUNBOOK.md](EC2-RESIZE-RUNBOOK.md). Incluye consulta sólo lectura desde
CloudShell para precio oficial/EIP/EBS, puertas pendientes para los otros siete
containers con política no, cambio EC2 y recuperación. No ejecutar la sección
stop/modify/start durante el diagnóstico.

Preço/IP/oferta confirmados pelo operador: subtotal US$ 154,018/mês, aumento
US$ 85,2713, Elastic IP associado. Não repetir a consulta. A proposta para revisão
está em [RESIZE-APPROVAL.md](RESIZE-APPROVAL.md), com backup de configuração sem
parada e retorno dirigido dos outros sete containers sem autostart. Backup
consistente dos dados do POSNET ainda exige identificação/evidência; metadados
não o substituem. Nenhuma parada está autorizada.

Preparação de configuração concluída pelo operador (12 containers/7 arquivos,
status ok, sem restart). Não repetir. Restam dados dos dois volumes replay e do
volume Caddy: há rotina **offline**, que bloqueia com gravadores ativos, e proposta
de janela/transferência protegida/retorno explícito dos 12 em RESIZE-APPROVAL.md.
Não executar backup offline nem parar serviços antes da aprovação da janela.

Autorização financeira recebida; parada ainda sem horário combinado. Ver
[MAC-BACKUP-WINDOW.md](MAC-BACKUP-WINDOW.md): `mac-posnet-backups.mjs preflight`
mede tamanhos/espaço e amostra SSH sem parar nada; `copy-config` antecipa a cópia
protegida para o Mac. Os comandos explícitos de janela e recuperação estão separados.

Falha da preparação em api_start: há retomada específica sem rebuild em
`resume-adl-api.mjs --apply`. Ela confirma o erro de tmpfs no log privado, informa
estado parcial e corrige apenas esse defeito por override persistido. Ver a seção
final de ADL-EXECUTION.md. Não repetir prepare-adl-aws, DNS, envs ou o corte Mac.

- [PreMatch particionado e mensagem 38](PARTITIONED-RECOVERY.md): atualização retomável
  do worker já migrado, preservando InPlay, memória, journals e POSNET.

Inventário sem avanço após 5069beb: [INVENTORY-RECOVERY.md](INVENTORY-RECOVERY.md)
(`--inventory-repair`, sem repetir migração ou aumentar limites).

Revisão da ativação e mensagem preliminar para o ticket 217525:
[SUPPORT-217525-DISTRIBUTION.md](SUPPORT-217525-DISTRIBUTION.md). Correção preparada,
sem reinício/implantação automática.

Aplicação autorizada da correção de distribuição, com status bruto e rascunho
pós-correção: [APPLY-DISTRIBUTION-2aa06f7.md](APPLY-DISTRIBUTION-2aa06f7.md)
(`--distribution-repair`, somente worker; retomável).
