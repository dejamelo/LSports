# Revisión de capacidad AWS — pendiente de autorización

No ejecutar deploy, stop/start, cambios de instancia, reinicios ni nuevas compras.
Usa el flujo de la skill `cloud-environment-onboarding:setup` para preparar/verificar;
la ejecución remota y la aprobación del costo siguen pendientes.

## Evidencia recibida

Informe `diagnostico-aws.txt`, 2026-10-18T23:00:21Z:

- c7i-flex.large, x86_64, 2 CPU; RAM utilizable 3.999.264.768 bytes (3,72 GiB).
- MemAvailable 2.065.985.536 bytes (1,92 GiB); sin swap.
- Volumen raíz 38 GiB, 25 GiB disponibles, 10% de inodos utilizados.
- CPU 97% ociosa en la última muestra de un segundo; no representa picos.
- dockerd ~663 MiB RSS; varios Node y Caddy. RSS no equivale a RAM recuperable.
- Puertos 80/443 ocupados. Preservar el proxy existente; no iniciar otro proxy ahí.
- Docker no fue inventariado: el script anterior ocultaba stderr y seguía tras errores.
  `DockerRoot= CPUs=0 MemoryBytes=0` NO demuestra un daemon vacío ni ausencia de containers.

El snapshot de 256 MiB requiere 2.214.592.512 bytes de margen según la protección
actual (8×respuesta + 64 MiB), ~142 MiB más que MemAvailable de esta captura,
sin sumar la nueva API. Además, el límite propuesto del worker es 4 GiB: supera
por sí solo la RAM utilizable del host. No aprobar esta instancia para ese despliegue.
No bajar las protecciones, usar swap como sustituto ni aumentar heap para simular RAM.

## Completar primero el inventario de Docker

Desde el checkout actualizado en el Mac, con el mismo usuario/host SSH existentes:

```bash
ssh USUARIO@HOST_AWS 'sudo -n bash -s' < deploy/homologation/diagnose-docker.sh > diagnostico-docker-aws.txt
```

Comprobar exit code y compartir el archivo. Usa únicamente sudo ya autorizado,
no cambia permisos ni grupos y no reinicia servicios. Si sudo requiere contraseña,
el comando falla sin modificar nada: no interpretar esa falla como inventario vacío.
El script obtiene región mediante IMDSv2 opcional (no consulta credenciales IAM),
consumo actual, límites de memoria/CPU, reinicios/OOM, salud y destinos de volúmenes.
No imprime env, inspect completo, comandos, logs ni secretos. En caso de Docker
rootless, hay que inventariar también el contexto del usuario correspondiente;
la vista rootful no prueba que no exista otro daemon.

## Opciones a cotizar

| Opción | Configuración candidata | Evaluación |
|---|---|---|
| Mantener host actual | 2 vCPU / 4 GiB nominales | No apta para el worker con este volumen; no desplegar. |
| Ampliar servidor compartido | **m7i.xlarge, 4 vCPU / 16 GiB**, Linux x86_64, misma región/AZ y EBS actual | Recomendación preliminar para compartir con POSNET. Confirmar disponibilidad/tipo soportado, demanda y límites de containers. No es garantía de rendimiento sin prueba. |
| Servidor LSports separado | m7i.xlarge, 4 vCPU / 16 GiB | Mejor aislamiento de fallos y consumo; costo adicional de instancia completa y almacenamiento/red que se aprueben. No parar POSNET. |
| Alternativa económica separada | m7i.large, 2 vCPU / 8 GiB | RAM candidata para homologación ligera; CPU más ajustada. Las cuotas actuales suman 2,5 CPU: revisar presupuesto/pruebas, no aplicar automáticamente esa configuración. |

Presupuesto inicial LSports: worker máximo 4 GiB / 2 CPU, API 768 MiB / 0,5 CPU;
Caddy reutilizado, o 128 MiB si realmente se necesita otro servidor/proxy.
Reservar al menos 1 GiB para host además del consumo/picos del POSNET y margen
operativo. El build debe realizarse fuera del servidor compartido si su pico de
memoria/CPU no fue presupuestado. Los límites máximos no son consumo esperado
ni reservas exclusivas. Confirmar uso y crecimiento del disco; 25 GiB libres es
una muestra favorable, no una certificación de capacidad de backups e imágenes.

## Costo preliminar — Ohio, us-east-2c

Región confirmada por el usuario: us-east-2 (Ohio), AZ us-east-2c. Premisa:
Linux, tenancy compartida, On-Demand, 730 horas/mes, USD, sin impuestos,
Savings Plans, reservas ni créditos promocionales. La modalidad real de compra
no está confirmada. Estas tarifas son **referencias presupuestarias pendientes
de verificación en AWS**, no una cotización cerrada: las consultas a precios
públicos AWS desde este workspace devolvieron 403 del proxy de salida.

| Cómputo | Tarifa referencial USD/h | Estimación USD/mes | Incremento vs actual |
|---|---:|---:|---:|
| Actual c7i-flex.large (2 CPU / 4 GiB) | 0,0848 | 61,90 | — |
| Compartido m7i.xlarge (4 CPU / 16 GiB) | 0,2016 | 147,17 | **85,26** |
| Separado m7i.xlarge, conservando el actual | 0,0848 + 0,2016 | 209,07 | **147,17**, más almacenamiento/red nuevos |
| Separado m7i.large (2 CPU / 8 GiB), conservando el actual | 0,0848 + 0,1008 | 135,49 | **73,58**, más almacenamiento/red nuevos |

El informe sólo mide el filesystem: 38 GiB visibles **no confirma** tamaño,
tipo ni número de volúmenes EBS. Tampoco confirma número de IPv4 facturables,
backups ni transferencia. Por eso el total exacto de la cuenta queda pendiente.

**Ejemplo de total presupuestario**, si existe sólo un EBS gp3 de 40 GiB
(40 × USD 0,08 = USD 3,20/mes), una IPv4 pública (730 × USD 0,005 = USD
3,65/mes), sin otros cargos: actual **USD 68,75/mes**; compartido recomendado
**USD 154,02/mes**; incremento **USD 85,26/mes**. Son hipótesis explícitas,
no inventario confirmado ni importe para autorizar un cambio. Transferencia,
backups, otros discos/IP e impuestos se agregan cuando correspondan. Para
servidor separado con el mismo ejemplo de disco/IP adicional, total conjunto
aproximado USD 222,77/mes (incremento USD 154,02/mes).

Antes de pedir aprobación final: confirmar las tarifas en la consola/calculadora
AWS de Ohio, inventario EBS/IPv4, cargos adicionales y compromisos existentes.
Con Savings Plans/reservas, distinguir factura efectiva de costo incremental:
detener/redimensionar no necesariamente elimina compromisos ya contratados.
No crear recursos para obtener la cotización.

Fuentes oficiales a verificar: https://aws.amazon.com/ec2/pricing/on-demand/ ,
https://aws.amazon.com/ebs/pricing/ y https://aws.amazon.com/vpc/pricing/ .
No se han validado sus tarifas en vivo desde este entorno.

## Indisponibilidad y controles previos al cambio

Cambiar de familia/tamaño requiere normalmente stop/start de la instancia EBS:
se detienen POSNET y todos sus servicios. Estimación de planificación: **5–15
minutos de indisponibilidad**, reservar ventana de **20–30 minutos** para verificar
arranque, Docker, Caddy, POSNET y rollback. No es un SLA; capacidad de la AZ,
arranque y recuperación de servicios pueden prolongarlo. Sin Elastic IP, una IP
pública asignada automáticamente puede cambiar tras stop/start: revisar DNS,
allowlists, terminales y direcciones antes de autorizar el cambio. No crear una
Elastic IP ni modificar DNS ahora. Validar EBS/instance-store y protección de datos,
políticas de reinicio, backups existentes y compatibilidad del tipo antes de parar.

Servidor separado: sin parada planificada del POSNET por redimensionamiento;
configurar cualquier ruta/proxy compartido requeriría plan y validación propios.

Cualquier cambio depende de aprobación explícita del **importe** y ventana.
Tras disponer de capacidad: parar normalmente el worker del Mac, confirmar
persistencia y cierre, respetar retryAt/cooldowns, y sólo entonces activar un único
consumidor AWS según README. No consumir simultáneamente las mismas colas.
Mantener billetes/finanzas simulados; no mezclar con POSNET Lottery.

## Seguimiento: inventario Docker incompleto recibido

Captura 2026-10-18T23:08:36Z (20:08:36 de Brasilia): Docker 29.8.2,
cgroup v2/systemd; 12 containers ejecutándose y 2 detenidos. Consumo observado
agregado de containers ~580,85 MiB, sin representar picos ni memoria total del
host. Los primeros dos tienen Memory=0/NanoCpus=0 y restartPolicy=no.
Los nombres canary/rollback no autorizan su eliminación ni prueban que no
atiendan tráfico. El Caddy público es `deploy-caddy-production-1`, con puertos
80/443; existen además dos Caddys privados. No se conocen aún sus rutas activas.

La versión anterior abortaba ante el primer error (`|| exit 2`) y ocultaba la
causa de la plantilla. Falló al llegar al tercer container, un Caddy sin healthcheck
visible en la lista. El archivo no contiene el error original: no confirma si
faltaba Health, alguna opción de logs u otro campo. El colector nuevo elimina
esa plantilla, tolera campos ausentes/null y comunica etapa, ID y categoría
sanitizada por container. Continúa con los siguientes incluso si uno desaparece
o falla. Exit 2 + resumen `partial` conserva la señal de inventario incompleto.

Usar de nuevo el mismo comando SSH documentado, tras actualizar la branch.
La salida ahora es JSON por línea. La inspección/configuración completa sólo se
procesa en memoria privada: nunca se imprime ni se guarda. El reporte publica
únicamente campos seleccionados. No contiene env, healthcheck logs, headers,
claves ni argumentos ExecStart. Los mounts sí muestran rutas locales para que
el operador identifique los archivos de configuración; tratar el reporte como
información interna.

### Rutas e inicio tras stop/start: puertas de aprobación

- Consulta GET al admin local predeterminado de cada Caddy identificado por su
  imagen oficial, mediante `docker exec ... wget`; no reload ni requests al POSNET.
  Si el admin está deshabilitado, tiene otro puerto/socket o falta wget, se marca
  `unverified`. No se usa un archivo montado como prueba de configuración activa.
- Muestra match host/path/method, upstreams estáticos y candidatos por nombre,
  alias/IP y redes compartidas. Un candidato por puerto publicado es sólo una
  pista: localhost dentro del Caddy no es localhost del host. Upstreams dinámicos,
  hosts externos, namespaces especiales y rutas ambiguas requieren revisión.
- Lista servicios systemd habilitados, estado/dependencias, nombre del ejecutable
  y presencia de Docker/Compose, sin imprimir argumentos o scripts con secretos.
  Esto no sustituye revisar hooks, scripts, cron, cloud-init y servicios de usuario.
- Para **cada ruta pública vigente**, registrar Caddy → upstream → container →
  proyecto/servicio → mecanismo de inicio, orden, volúmenes y healthcheck. Toda
  ruta sin vínculo demostrado sigue bloqueando el cambio.
- `restartPolicy=no` no reinicia ese container automáticamente al arrancar Docker.
  Necesita un mecanismo externo confirmado, o un cambio explícitamente aprobado
  con procedimiento de rollback. No modificar políticas ni ejecutar compose up
  durante el diagnóstico. Una unidad habilitada por sí sola no prueba cobertura.
- No realizar stop/start hasta confirmar que todos los servicios actuales vuelven
  y definir comprobaciones de POSNET/SSO/demo/staging con su responsable.

### Confirmación de precios todavía pendiente

El colector intenta `aws pricing get-products` sólo si la CLI ya existe, usando
las credenciales/rol existentes sin imprimirlos. Filtra Linux/Shared/On-Demand,
Ohio y los tres tipos comparados; reporta tarifa, SKU y fecha efectiva de la API
oficial. No instala CLI ni solicita secretos. Falta de CLI/permisos queda explícita.

Si no funciona, confirmar tarifas y costos EBS/IPv4 en AWS Pricing Calculator o
consola antes del plan final. Los importes referenciales anteriores **no son precios
actuales confirmados**. No dar autorización económica basada en ellos. El informe
no ejecuta cambios ni confirma el arranque tras reinicio; ambas validaciones
siguen pendientes del inventario remoto y la revisión operativa.

Validación local del colector: `bash -n deploy/homologation/diagnose-docker.sh`
y `python3 deploy/homologation/test-diagnose-docker.py` (5 tests, Docker/AWS/systemd
simulados; ninguna operación remota). No se repitieron migraciones ni tests del
feed porque no cambió el código de aplicación.
