# EC2 Ohio: cambio y recuperación — preparado, NO autorizado/ejecutado

## Verificaciones ya concluidas

El operador confirmó que la rutina terminó `complete/ok/noRestartRequested=true`:
los dos originfix sirven las rutas públicas, tienen `unless-stopped` y conservaron
identidad/imagen/redes/aliases/almacenamiento/proceso. Caddy activo y archivo de
inicio resultaron iguales (`boot_gate=config_matches_now`). Docker está enabled;
Caddy público ya era `unless-stopped`. No repetir la corrección ni migraciones.
Conservar la ruta real del backup emitido por la rutina.

## Pendientes antes de aprobar costo y ventana

1. **Precio/IP/almacenamiento**: en AWS CloudShell de la cuenta correcta, subir
   solamente `deploy/homologation/diagnose-aws-resize.py` (archivo del checkout,
   sin claves/configs/backups) mediante Actions → Upload file. Ejecutar:

   ```bash
   python3 diagnose-aws-resize.py > diagnostico-redimensionamento-aws.jsonl
   ```

   Usa AWS CLI/rol existentes; consultas `Describe*` y `pricing:GetProducts`.
   No instala nada ni ejecuta stop/modify/start/allocate/associate/create.
   Encuentra la instancia por su IPv4 actual, sin inventar un InstanceId.
   Price List usa us-east-1 como endpoint, pero filtra productos de **Ohio**.
   Reporta precios/SKU/fecha efectiva, EBS y asociación de Elastic IP, sin secretos.
   Si carece de permiso, pedir a un operador autorizado esa consulta sólo lectura;
   no ampliar IAM ni solicitar access keys por chat.
2. El acceso público a precios AWS desde el workspace sigue devolviendo 403.
   AWS CLI tampoco estaba instalada en el servidor. **No hay precio actual
   confirmado**. Usar el informe de CloudShell o los campos ya documentados para
   AWS Pricing Calculator. No convertir referencias anteriores en una cotización.
3. El informe calcula subtotal EC2+gp3 estándar+IPv4 sólo con precios/unidades
   inequívocos y volúmenes encontrados; si hay IOPS/throughput extra u otro tipo
   de EBS, presupuestar aparte. Añadir snapshots, transferencia, otros servicios,
   impuestos y compromisos existentes. Base 730 h/mes, Linux Shared On-Demand,
   sin créditos/SP/reservas. Total propuesto menos actual = incremento.
4. El DNS `ec2-77-113-150-100...` **no prueba que exista Elastic IP**. Preservación
   del público sólo esperada si la EIP está asociada a la ENI de esta instancia y
   se mantiene esa asociación. IP automática puede cambiar tras stop/start junto
   al hostname DNS; en ese caso detener el plan hasta decidir DNS, allowlists,
   terminales y nuevo SSH. No crear una EIP (recurso/costo) sin aprobarlo.
5. Confirmar m7i.xlarge ofertada en us-east-2c, x86_64/HVM y root EBS compatible,
   sin dependencia instance-store. Oferta no garantiza capacidad inmediata.
6. **Otros servicios**: siete de los otros containers activos tenían restart=no
   en el inventario (dos Caddys privados, dos SSO anteriores, validated-canary,
   terminal-link y staging). No concluir que son prescindibles por no estar en
   las dos rutas públicas. Responsable debe identificar consumidores y mecanismo
   de inicio, o aprobar individualmente política/procedimiento de arranque.
   No cambiar sus políticas masivamente ni eliminarlos. Esta puerta sigue abierta.
7. Backups consistentes existentes del POSNET y dependencias externas: confirmar
   recuperación, ubicación y responsable; el backup de metadatos no respalda por
   sí solo la base del POSNET. No crear snapshots pagos ahora. Revisar automatismos
   Compose/cloud-init que puedan recrear containers o revertir políticas en el boot.

## Propuesta

Instancia compartida `m7i.xlarge`, 4 vCPU/16 GiB. Mantener discos, ENIs, grupos de
seguridad, perfil IAM y rutas actuales. No cambiar EBS, DNS, EIP ni servicios al
mismo tiempo. LSports sigue sin desplegar/consumir hasta validar POSNET/capacidad.
Presupuesto LSports previsto: worker 4 GiB/2 CPU y API 768 MiB/0,5 CPU, más host,
Caddy y picos POSNET. Precio y admisión final dependen de las consultas anteriores.

Ventana estimada: 20–30 min; parada percibida 5–15 min si arranque normal. No SLA:
capacidad AZ, DNS o fallos de servicios pueden prolongarla. Suspender nuevas
operaciones POSNET según su procedimiento operacional para evitar solicitudes
interrumpidas; no inventar endpoints o editar transacciones manualmente.

## Procedimiento futuro, únicamente tras aprobación expresa de importe y ventana

No ejecutar esta sección durante el diagnóstico. Usar InstanceId confirmado,
no IP/hostname para controlar EC2. Tener consola/SSM de recuperación probada y
credenciales administrativas existentes; no depender sólo de SSH público.

1. Avisar ventana y responsable, registrar tipo original c7i-flex.large, EIP/ENI,
   discos, rutas, hashes Caddy y salud de todos los servicios que deben volver.
   Verificar nuevamente políticas y datos sin repetir migraciones.
2. Confirmar worker LSports del Mac en su estado previsto: AWS aún no lo inicia.
   Stop/start de EC2 no autoriza transferencia del consumidor ni dos consumidores.
3. Concluir/quiescer operaciones POSNET y persistencia conforme al sistema actual.
   No ejecutar `docker compose down`, `docker system prune`, `docker rm`,
   `network disconnect` ni recreación de containers. No `terminate-instances`.
4. Desde consola/CloudShell **después de aprobación**:

   ```bash
   aws ec2 stop-instances --region us-east-2 --instance-ids INSTANCE_ID_CONFIRMADO
   aws ec2 wait instance-stopped --region us-east-2 --instance-ids INSTANCE_ID_CONFIRMADO
   aws ec2 modify-instance-attribute --region us-east-2 --instance-id INSTANCE_ID_CONFIRMADO --instance-type '{"Value":"m7i.xlarge"}'
   aws ec2 start-instances --region us-east-2 --instance-ids INSTANCE_ID_CONFIRMADO
   aws ec2 wait instance-status-ok --region us-east-2 --instance-ids INSTANCE_ID_CONFIRMADO
   ```

   Ejecutar/verificar cada resultado antes del siguiente. Los status checks EC2
   no prueban salud de la aplicación. Si falla la modificación/arranque, pasar a
   recuperación; no lanzar instancias nuevas, cambiar AZ ni reasociar IP a ciegas.
5. Verificar tipo/RAM/CPU/discos/IP desde AWS y host; comprobar Docker, Caddy,
   dos originfix healthy, aliases/volúmenes persistentes y los otros servicios
   aprobados. Repetir colector sólo lectura y comparación Caddy. Probar ambas
   URLs/SSO/demo y los canales POSNET identificados con su procedimiento normal,
   sin crear apuestas reales de prueba. No dar por recuperado sólo porque abre SSH.
6. Si hay fallo, revisar estado/diagnóstico sanitizado; no sustituir imágenes ni
   borrar volúmenes/backups. Conservar la evidencia y aplicar recuperación acordada.
7. Cerrar ventana sólo con POSNET validado. Después reevaluar MemAvailable y
   admisión del snapshot LSports, sin reducir protecciones. Deploy/consumer AWS
   es una aprobación/etapa separada, después de parar Mac y respetar retryAt.

## Recuperación si falla la ampliación

Mantener los datos y políticas de inicio corregidas; **no revertir restart=no**
para intentar arreglar un problema de EC2. La reversión de política es independiente.
Si la nueva instancia no arranca o presenta incompatibilidad, con aprobación del
responsable y tras preservar diagnóstico: stop de la misma instancia, esperar
stopped, cambiar InstanceType otra vez a c7i-flex.large, iniciar y validar. Son los
mismos comandos anteriores con tipo original; implica otra parada y el mismo
riesgo de cambio de IP automática. Puede haber limitación de capacidad también
para el tipo original: no garantizar rollback instantáneo.

Si EC2 está sano pero un backend está detenido, revisar su identidad/política y
causa antes de un arranque dirigido autorizado. No `compose up` que pierda aliases.
Si hay corrupción de datos, detenerse y usar el plan de restore probado del POSNET;
este runbook no autoriza restaurar/reescribir una base ni reemplazar discos.
Ninguna recuperación debe encender automáticamente el worker LSports.
