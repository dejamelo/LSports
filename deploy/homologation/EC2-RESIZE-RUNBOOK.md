# EC2 Ohio: cambio y recuperación — preparado, NO autorizado/ejecutado

## Verificaciones ya concluidas

El operador confirmó que la rutina terminó `complete/ok/noRestartRequested=true`:
los dos originfix sirven las rutas públicas, tienen `unless-stopped` y conservaron
identidad/imagen/redes/aliases/almacenamiento/proceso. Caddy activo y archivo de
inicio resultaron iguales (`boot_gate=config_matches_now`). Docker está enabled;
Caddy público ya era `unless-stopped`. No repetir la corrección ni migraciones.
Conservar la ruta real del backup emitido por la rutina.

## Confirmaciones recibidas — no repetir consultas

El operador informó `pricingComplete=true` de AWS Price List API: subtotal actual
USD **68,7467/mes**, propuesto USD **154,018/mes**, diferencia USD **85,2713/mes**.
Redondeo comercial: **68,75 → 154,02**, incremento **85,27 USD/mes**. Base 730 h,
Linux Shared On-Demand, sin créditos/descuentos. Es subtotal de los componentes
consultados, no toda la factura: transferencia, backups/snapshots, otros servicios,
impuestos y compromisos existentes siguen fuera si no figuraban en la consulta.

También confirmó Elastic IP asociado y `offeredInAz=true`. Mantener la misma
instancia/ENI y asociación EIP: no liberar ni reasociar el IP, no crear otro.
Oferta en AZ no garantiza capacidad inmediata. No repetir comprobaciones
Caddy/originfix ni consulta de precios/IP para la preparación documental.

## Pendientes reales

- Backup privado de configuración duradero: `prepare-posnet-resize-backup.sh`.
  Guarda Compose/Caddy/overrides temporales, inventario privado y manifest con
  hashes/lectura de verificación. No toca políticas, servicios o datos de aplicación.
- Supabase `posnet-lottery-production`: operador confirmó backups diarios
  11–18/10/2026, último 18/10 a las 12:47:58 UTC (09:47:58 Brasilia), PITR
  deshabilitado y buckets vacíos. Restore no probado/confirmado; no repetir consulta.
  No confundir backup de inspect/config con backup de base. No inventar comandos
  SQL ni copiar SQLite/volúmenes activos como si fueran consistentes. Revisar
  datos locales con la rutina preparada; no crear snapshots pagos.
- Retorno de los otros siete containers activos: procedimiento dirigido manual
  documentado en RESIZE-APPROVAL.md; no borrar ninguno ni arrancar los dos que
  ya estaban detenidos. No es necesario cambiar sus políticas en esta etapa.
- Compatibilidad EBS/HVM/x86_64 y dependencias de almacenamiento externo deben
  estar anotadas por el operador desde los detalles de la instancia. Precio,
  EIP/oferta y hashes ya confirmados no necesitan volver a consultarse ahora.

## Propuesta

Instancia compartida `m7i.xlarge`, 4 vCPU/16 GiB. Mantener discos, ENIs, grupos de
seguridad, perfil IAM y rutas actuales. No cambiar EBS, DNS, EIP ni servicios al
mismo tiempo. LSports sigue sin desplegar/consumir hasta validar POSNET/capacidad.
Presupuesto LSports previsto: worker 4 GiB/2 CPU y API 768 MiB/0,5 CPU, más host,
Caddy y picos POSNET. Costo confirmado según el informe; admisión del worker se comprobará tras ampliar, sin bajar protecciones.

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
