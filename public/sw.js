const CACHE_VERSION = 'v1.0.0';
const STATIC_CACHE = `agendapulse-static-${CACHE_VERSION}`;
const API_CACHE = `agendapulse-api-${CACHE_VERSION}`;

const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/manifest.webmanifest',
  '/js/db.js',
  '/js/sync.js',
  '/js/notifications.js',
  '/js/app.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(APP_SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== API_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/**
 * Caching strategies:
 * 1. API GET (/api/activities): Network First with Cache fallback.
 * 2. HTML Navigation: Network First with App Shell Cache fallback.
 * 3. Static Assets: Cache First with background update (Stale-While-Revalidate style).
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/api/activities') {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put('/index.html', clone));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(cacheFirstWithRevalidate(request, STATIC_CACHE));
});

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ activities: [], offline: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function cacheFirstWithRevalidate(request, cacheName) {
  const cached = await caches.match(request);
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(cacheName).then((cache) => cache.put(request, clone));
      }
      return response;
    })
    .catch(() => null);

  return cached || (await fetchPromise) || new Response('Recurso no disponible sin conexión', { status: 503 });
}

// --- IndexedDB helpers inside Service Worker for Background Sync & Notifications ---
function openDbInSw() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ada4-pwa-db', 1);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('activities')) {
        const activities = db.createObjectStore('activities', { keyPath: 'id' });
        activities.createIndex('status', 'status', { unique: false });
        activities.createIndex('dueAt', 'dueAt', { unique: false });
        activities.createIndex('updatedAt', 'updatedAt', { unique: false });
        activities.createIndex('category', 'category', { unique: false });
      }
      if (!db.objectStoreNames.contains('syncQueue')) {
        const queue = db.createObjectStore('syncQueue', { keyPath: 'queueId', autoIncrement: true });
        queue.createIndex('activityId', 'activityId', { unique: false });
        queue.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-activities') {
    event.waitUntil(flushQueueInBackground());
  }
});

async function flushQueueInBackground() {
  const db = await openDbInSw();
  const readTx = db.transaction('syncQueue', 'readonly');
  const queue = await idbReq(readTx.objectStore('syncQueue').getAll());

  if (!queue.length) {
    db.close();
    return;
  }

  const response = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operations: queue }),
  });

  if (!response.ok) {
    db.close();
    throw new Error(`Sync falló con código ${response.status}`);
  }

  const data = await response.json();
  const writeTx = db.transaction(['syncQueue', 'activities', 'meta'], 'readwrite');
  const queueStore = writeTx.objectStore('syncQueue');
  for (const item of queue) {
    queueStore.delete(item.queueId);
  }

  const actStore = writeTx.objectStore('activities');
  if (Array.isArray(data.activities)) {
    for (const act of data.activities) {
      actStore.put({ ...act, syncPending: false });
    }
  }

  writeTx.objectStore('meta').put({
    key: 'lastSyncAt',
    value: data.serverTime || new Date().toISOString(),
  });

  await new Promise((resolve, reject) => {
    writeTx.oncomplete = resolve;
    writeTx.onerror = () => reject(writeTx.error);
  });
  db.close();

  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({
      type: 'SYNC_COMPLETED',
      count: queue.length,
      serverTime: data.serverTime,
    });
  }
}

// --- Web Push API Events ---
self.addEventListener('push', (event) => {
  let payload = {
    title: 'AgendaPulse',
    body: 'Tienes un recordatorio pendiente.',
    tag: 'agendapulse-push',
    url: '/',
  };

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }

  const options = {
    body: payload.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag,
    data: {
      url: payload.url || '/',
      activityId: payload.activityId || null,
    },
    actions: payload.activityId
      ? [
          { action: 'complete', title: 'Marcar completada' },
          { action: 'open', title: 'Abrir' },
        ]
      : [{ action: 'open', title: 'Abrir' }],
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { activityId, url } = event.notification.data || {};

  if (event.action === 'complete' && activityId) {
    event.waitUntil(markActivityCompletedFromNotification(activityId));
    return;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(url || '/');
    })
  );
});

async function markActivityCompletedFromNotification(activityId) {
  try {
    const db = await openDbInSw();
    const tx = db.transaction(['activities', 'syncQueue'], 'readwrite');
    const actStore = tx.objectStore('activities');
    const activity = await idbReq(actStore.get(activityId));

    if (activity) {
      const updated = {
        ...activity,
        status: 'completed',
        updatedAt: new Date().toISOString(),
        syncPending: true,
      };
      actStore.put(updated);
      tx.objectStore('syncQueue').add({
        op: 'update',
        activityId,
        payload: updated,
        createdAt: new Date().toISOString(),
      });
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: 'ACTIVITY_UPDATED_FROM_NOTIF', activityId });
    }
  } catch {
    // Ignore errors when DB is unavailable
  }
}
