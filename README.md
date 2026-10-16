# LSports — sportsbook de demostración

Aplicación independiente con interfaz en español argentino, diseñada para iframe. **No acepta apuestas, pagos, depósitos ni retiros.** Todos los eventos, horarios y cuotas son ficticios. El importe del billete usa puntos sin valor monetario; la confirmación solo cambia el estado de la interfaz. Las selecciones se pierden al recargar.

## Requisitos e instalación

Node.js 22 o superior y npm 10 o superior (verificado con Node 24 y npm 11).

```sh
cd /workspace/LSports # o la ubicación del checkout local
npm ci --cache /workspace/.npm-cache # en local podés omitir --cache
cp .env.example .env
npm run dev
```

La copia de `.env` es opcional en modo demo. No sobrescribas un `.env` existente.

- Frontend: puerto 5173, ruta `/sportsbook` (también disponible en `/`).
- API: puerto 3001, enlazada a loopback por defecto.
- Worker: proceso continuo con heartbeat cada 30 segundos, sin conexión al proveedor.

Para ejecutar por separado, desde la raíz, en tres terminales:

```sh
npm run dev:api
npm run dev:web
npm run dev:worker
```

```sh
npm run build
npm test
# Vista del frontend compilado; mantener la API en otra terminal:
npm run preview -w @lsports/web
```

El build compila el frontend en `apps/web/dist` y verifica tipos de API/worker. Los servicios Node se ejecutan con `tsx` mediante sus comandos `start` o `dev`, no se generan bundles Node. El lockfile fija la instalación reproducible. `npm test` comprueba el feed demo, la unicidad de selecciones, cuotas y ausencia de endpoint para apuestas.

## Arquitectura

- `apps/web`: React + TypeScript + Vite, filtros de deportes, Prepartido/En vivo/Hípica, estados de carga y error, búsqueda, billete simple/combinado y diseño adaptable.
- `apps/api`: Express, `GET /api/health` y `GET /api/events`. Sin persistencia, usuarios, wallet ni endpoints de transacción.
- `apps/worker`: bucle persistente de integración con manejo de SIGINT/SIGTERM, ciclos secuenciales y recuperación de errores entre ciclos. En demo solo lee datos y escribe heartbeat; no alimenta la API ni persiste eventos. Para operación continua fuera del desarrollo, ejecutar bajo un supervisor con reinicio automático.
- `packages/contracts`: interfaz `EventSource` y tipos compartidos.
- `packages/demo`: fuente ficticia aislada, consumida por API y worker; el frontend recibe datos exclusivamente desde la API.

## Próxima integración: LSports TRADE

Configuración prevista: **Test**, **PreMatch 4511**, **InPlay 4510**. No existe conexión real en esta etapa. `DATA_MODE` distinto de `demo` aborta API y worker para evitar presentar datos ficticios como reales. El futuro adaptador debe implementar `EventSource`, conservar datos demo separados y definir transporte autorizado por el proveedor, autenticación, normalización, almacenamiento compartido API/worker, deduplicación, recuperación del stream y cuotas suspendidas. No se inventaron URLs ni protocolos del proveedor.

Las credenciales futuras deben configurarse en el servidor o gestor de secretos; nunca en código, Git, frontend ni variables `VITE_*`. `.env` y sus variantes están ignorados; `.env.example` solo contiene valores no sensibles.

## Incorporación por iframe

Ejemplo para un servidor publicado con HTTPS:

```html
<iframe
  src="https://sportsbook.example.com/sportsbook"
  title="LSports — demostración deportiva"
  width="100%"
  height="900"
  style="border:0"
  sandbox="allow-scripts allow-same-origin"
  loading="lazy"
></iframe>
```

No depende de cookies de terceros, login, navegación superior ni almacenamiento local. Usa altura fija con scroll y diseño responsive; no hay protocolo `postMessage` ni ajuste automático de altura en esta etapa. No pongas información sensible en query strings.

En desarrollo/preview, `FRAME_ANCESTORS` lista los orígenes exactos autorizados para el padre, separados por espacios. Reiniciá Vite después de cambiarlo. Para una prueba local con padre en puerto 8080, agregá `http://127.0.0.1:8080` y/o `http://localhost:8080`.

En producción, servir `apps/web/dist` con fallback SPA hacia `index.html` para `/sportsbook`, reenviar `/api` al servicio Node y configurar en el servidor HTTP el header `Content-Security-Policy: frame-ancestors 'self' https://tu-sitio-padre.example`. La variable de Vite no configura headers en un hosting estático. No enviar `X-Frame-Options: DENY` ni `SAMEORIGIN` si el padre es otro origen. Usar HTTPS en padre e iframe. La API permanece interna detrás del mismo origen, sin CORS abierto. Las fuentes de Google son opcionales y tienen fuentes de sistema como alternativa.

## Alcance de esta etapa

La simulación no valida cuotas reales ni elegibilidad y no guarda billetes. “En vivo” muestra fixtures estáticos identificados como demo. Hípica es un ejemplo de selección de ganador, no un sistema de apuestas mutuas. No habilitar operación con dinero real sin una implementación posterior de backend, cumplimiento regulatorio, identidad, límites, auditoría y liquidación.
