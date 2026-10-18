# POSNET: preparación de inicio persistente — NO APLICADO

No parar la instancia, reiniciar Docker/Caddy, recrear containers, cambiar rutas,
redes, imágenes o volúmenes. Los comandos de modificación de este documento
requieren aprobación separada. No es un deploy del LSports ni mezcla sus datos.

## Evidencia del inventario

- `demo.loteriaargentina.lat` → `demo-canary-release-20261009:3000` →
  `posnet-sso-originfix-demo-sso-canary-1`.
- `www.loteriaargentina.lat` → `production-canary-release-20261009:3000` →
  `posnet-sso-originfix-production-sso-canary-1`.
- Ambos comparten `posnet-sso-canary_default` con el Caddy público. Además
  pertenecen a `posnet-sso-originfix_default`. No desconectar ninguna red.
- Docker: enabled/active; Caddy público: `unless-stopped`; ambos backends: `no`.
- Caddy público usa bind de `/home/ubuntu/pixel-lottery-hub/deploy/Caddyfile.production`
  a `/etc/caddy/Caddyfile`. El inventario no registró sus argumentos de arranque
  ni comparó ese archivo con la configuración activa: equivalencia todavía pendiente.
- El proyecto originfix referencia un override en `/tmp/posnet-sso-originfix.override.yml`.
  No depender de ese archivo temporal para recrear servicios después de un reboot.

## 1. Verificación Caddy solamente lectura

Desde el Mac, tras actualizar la branch:

```bash
ssh USUARIO@HOST_AWS 'sudo -n bash -s' < deploy/homologation/check-posnet-caddy-boot.sh > comprobacion-caddy-boot.jsonl
```

Comprueba identidad del Caddy, comando de arranque estándar, ausencia de `--resume`,
bind esperado, bytes del archivo del host vs el archivo dentro del container y
JSON activo vs `caddy adapt` del archivo de inicio. Sólo imprime hashes/status.
No reload, validación con provisioning, escritura ni salida de configuraciones.

Exit 0 requiere mismos bytes y JSON equivalente. Exit 2 significa bloqueo o
verificación incompleta: revisar, no corregir automáticamente ni asumir que la
configuración en disco es la correcta. Con `--resume`, revisar explícitamente el
autosave antes de decidir qué fuente se usará. Diferencias de defaults también
pueden producir discrepancia: requieren revisión; no suprimir diferencias a ciegas.
Igualdad ahora no garantiza que imports, archivos de secretos/certificados o redes
estén presentes tras reboot; confirmar su persistencia y no modificar esos archivos
entre la comprobación y la ventana. El chequeo cubre el Caddy público; los dos
Caddys privados siguen sin admin accesible y no deben eliminarse ni considerarse
prescindibles sin revisión de sus consumidores.

## 2. Corrección propuesta, sin recreación ni parada

Usar `docker update --restart=unless-stopped` sólo sobre estos dos IDs verificados.
La política queda guardada en el daemon y sobrevive al reinicio de la instancia;
no requiere Compose para arrancar containers ya existentes. `unless-stopped`
respeta una parada manual intencional, a diferencia de forzar su arranque siempre.
No impone orden de healthchecks: Caddy puede dar 502 transitorio durante el inicio
de los backends. Revisar salud y acceso público antes de cerrar la ventana.

**Comandos para revisar, NO ejecutados.** Ejecutar en una sesión SSH existente;
verificar cada comando antes de continuar. No pegar esta sección como un deploy
automático. Si cambia un ID, abortar y repetir inventario; no sustituir por nombre
sin comprobar identidad, imagen, volumen y aliases.

```bash
sudo docker inspect --format '{{.Id}} {{.Name}} {{.Image}} {{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}} {{.HostConfig.RestartPolicy.Name}}' \
  3b61ea33cd2212bcf26f9cc54a9740eb05e40913e19f921e190942ff6978a70b \
  e2ed00f069290108331e7a8c568f337e0b423eb9df9de4a8f199f8fc8146d9d7
```

Esperar los nombres originfix correctos, running=true, healthy y política no.
Antes de cambiar, guardar inventario seleccionado (sin env) en backup protegido:

```bash
sudo bash -s <<'BACKUP'
set -eu
umask 077
posnet_boot_backup=$(mktemp -d /var/backups/posnet-boot.XXXXXXXX)
docker inspect --format '{{.Id}} {{.Name}} {{.Image}} {{json .Mounts}} {{json .NetworkSettings.Networks}} {{json .HostConfig.PortBindings}} {{json .HostConfig.RestartPolicy}}' \
  3b61ea33cd2212bcf26f9cc54a9740eb05e40913e19f921e190942ff6978a70b \
  e2ed00f069290108331e7a8c568f337e0b423eb9df9de4a8f199f8fc8146d9d7 \
  > "$posnet_boot_backup/containers.before.txt"
# Private backups only; do not print configs or commit them to Git.
cp --preserve=mode,timestamps /home/ubuntu/pixel-lottery-hub/deploy/Caddyfile.production "$posnet_boot_backup/Caddyfile.production"
cp --preserve=mode,timestamps /tmp/posnet-sso-originfix.override.yml "$posnet_boot_backup/originfix.override.yml"
chmod 600 "$posnet_boot_backup/"*
printf 'backup=%s\n' "$posnet_boot_backup"
BACKUP
```

Si falta un archivo o falla el backup, no continuar. El backup de metadatos no
sustituye un backup consistente de datos del POSNET; conservar los backups existentes.
Los archivos privados pueden contener secretos: no adjuntarlos al chat.

Tras aprobación explícita de esta corrección (independiente del cambio EC2):

```bash
sudo docker update --restart=unless-stopped \
  3b61ea33cd2212bcf26f9cc54a9740eb05e40913e19f921e190942ff6978a70b \
  e2ed00f069290108331e7a8c568f337e0b423eb9df9de4a8f199f8fc8146d9d7
```

Inspeccionar de nuevo ambos, guardar un `containers.after.txt` en el mismo backup
con el formato anterior y comparar: sólo RestartPolicy puede cambiar. Un error
puede producir aplicación parcial: inspeccionar ambos y no asumir atomicidad.
No probar con restart/stop/start en esta etapa. Verificar las dos páginas mediante
el procedimiento normal del operador, sin transacciones financieras de prueba.

## 3. Reversión de la política

Si es necesario revertir, restaurar exactamente `no` en los mismos IDs:

```bash
sudo docker update --restart=no \
  3b61ea33cd2212bcf26f9cc54a9740eb05e40913e19f921e190942ff6978a70b \
  e2ed00f069290108331e7a8c568f337e0b423eb9df9de4a8f199f8fc8146d9d7
```

Verificar ambos. No reinicia containers ni toca datos/rutas. Esa reversión restaura
también el riesgo de falta de arranque automático: cancela cualquier stop/start EC2
hasta disponer de otro plan aprobado. Mantener backups; no borrarlos tras revertir.

## 4. Declaración para futuras recreaciones (otra revisión, no ejecutar up)

`posnet-originfix.restart-policy.yaml` expresa solamente la política propuesta.
No es un Compose autónomo. Antes de usarlo en una futura entrega:

1. Preservar override y base Compose en ubicación duradera, protegida y versionada
   apropiadamente (sin subir secretos); no depender de `/tmp`.
2. Revisar en privado el modelo Compose combinado con los archivos **reales**.
   No imprimir `docker compose config` sin sanitizar: puede expandir secretos.
3. Declarar las dos redes actuales y los aliases de producción/demo ya identificados,
   mantener exactamente las imágenes/digests y el volumen replay del demo. Una
   conexión manual puede no existir en el Compose original: `docker update` la
   conserva; `compose up --force-recreate` podría perderla.
4. Sólo tras comparar el modelo completo y revisar rollback se autoriza recreación.
   No intentar representar ahora el proyecto POSNET entero desde este inventario.

## 5. Presupuesto y puerta EC2

Ver CAPACITY-REVIEW.md. La API pública de precios sigue bloqueada por 403 desde
este workspace y AWS CLI no está instalada en el servidor. No instalarla para
el diagnóstico ni presentar los precios previos como confirmados. Completar AWS
Pricing Calculator y aprobar importe/ventana antes de cambiar EC2.
