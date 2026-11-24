# AgendaPulse — PWA de Actividades y Recordatorios Personales

Progressive Web App (PWA) **offline-first** para administrar actividades y recordatorios personales, desarrollada con HTML5, CSS3, JavaScript modular, **IndexedDB**, **Service Workers**, **Background Sync**, **Notifications API** y **Web Push API** con backend en Node.js + Express.

## Características implementadas

- **Operaciones CRUD completas:** Registrar, consultar (búsqueda por texto y filtros por estado y prioridad), modificar (edición completa y marcado rápido de completado) y eliminar actividades.
- **Almacenamiento local con IndexedDB (`ada4-pwa-db`):**
  - Object Store `activities`: conserva todas las actividades localmente.
  - Object Store `syncQueue`: cola persistente de mutaciones realizadas sin conexión (`create`, `update`, `delete`).
  - Object Store `meta`: fecha de última sincronización y metadatos.
- **Estrategias de caché con Service Worker (`public/sw.js`):**
  - **Precache del App Shell** en evento `install`.
  - **Cache First con revalidación** para recursos estáticos (`styles.css`, módulos JS, iconos, `manifest.webmanifest`).
  - **Network First con fallback a caché** para navegación HTML (`/index.html`) y consultas `GET /api/activities`.
- **Sincronización al recuperar conexión:**
  - Registro en Background Sync (`sync-activities`) dentro del Service Worker.
  - Escucha automática del evento `online` del navegador y botón manual de sincronización.
  - Endpoint `POST /api/sync` en el servidor que procesa las operaciones pendientes de forma idempotente.
- **Notificaciones y Web Push API:**
  - Notificaciones locales con la **Notifications API** (`Notification.requestPermission()` + `ServiceWorkerRegistration.showNotification()`) y recordatorios programados antes de la fecha límite.
  - Ampliación con **Push API + backend VAPID** (`web-push`): generación automática de llaves VAPID, suscripción (`POST /api/push/subscribe`), envío manual de prueba (`POST /api/push/test`) y worker en servidor que envía Push al vencer recordatorios.

## Estructura del proyecto

- `server.js`: Servidor Express, API REST CRUD, endpoint `/api/sync`, servidor Web Push con `web-push` y worker de recordatorios.
- `public/index.html`: Interfaz accesible y responsiva.
- `public/styles.css`: Estilos con alto contraste y diseño adaptable.
- `public/manifest.webmanifest`: Manifiesto PWA con iconos `192x192`, `512x512`, `maskable` y accesos directos (`shortcuts`).
- `public/sw.js`: Service Worker con estrategias de caché, `sync`, `push` y `notificationclick`.
- `public/js/db.js`: Capa de persistencia en IndexedDB.
- `public/js/sync.js`: Motor de sincronización cliente-servidor.
- `public/js/notifications.js`: Gestión de permisos, Notifications API y suscripción Push API.
- `public/js/app.js`: Controlador principal de la interfaz.
- `tests/app.test.js`: Pruebas automatizadas de API, sincronización y Push.

## Ejecución local

```bash
npm install
npm test
npm start
```

Abrir en el navegador: `http://localhost:3000`

## Despliegue con HTTPS

El repositorio incluye configuración lista para desplegar en servicios con HTTPS automático:

1. **Render (`render.yaml`):**
   - Sube el repositorio a GitHub.
   - En Render, selecciona **New + > Blueprint** (o **Web Service**) y conecta tu repositorio.
   - Render ejecutará `npm install` y `npm start` exponiendo la app bajo `https://<tu-app>.onrender.com`.
2. **Vercel (`vercel.json`):**
   - Conecta el repositorio en Vercel o usa `vercel --prod`.
   - Recomendado configurar `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY` como variables de entorno para persistencia entre despliegues serverless.

## Verificación offline y Lighthouse

- **Lighthouse:** Ejecuta Lighthouse sobre la URL publicada o `http://localhost:3000` (en modo incógnito de Chrome/Edge DevTools > Lighthouse).
- **Prueba Offline:**
  1. Abre la aplicación con conexión y verifica en DevTools > Application > Service Workers que el SW está activo y en Cache Storage están los archivos del App Shell.
  2. Activa **Offline** en DevTools > Network.
  3. Recarga la página (seguirá cargando desde caché).
  4. Crea, edita o elimina actividades; verás la insignia **Sin conexión** y el contador en **Cola de sincronización** e **IndexedDB**.
  5. Desactiva **Offline**: la app detectará el regreso de la red y sincronizará automáticamente con el servidor.
