require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const webpush = require('web-push');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const VAPID_PATH = path.join(DATA_DIR, 'vapid.json');

/**
 * Ensures the data directory exists and reads JSON safely.
 */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function loadOrCreateVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY.trim(),
      privateKey: process.env.VAPID_PRIVATE_KEY.trim(),
    };
  }
  const saved = readJsonSafe(VAPID_PATH, null);
  if (saved && saved.publicKey && saved.privateKey) {
    return saved;
  }
  const generated = webpush.generateVAPIDKeys();
  writeJsonSafe(VAPID_PATH, generated);
  return generated;
}

function loadStore() {
  const initial = { activities: [], subscriptions: [] };
  const store = readJsonSafe(STORE_PATH, initial);
  return {
    activities: Array.isArray(store.activities) ? store.activities : [],
    subscriptions: Array.isArray(store.subscriptions) ? store.subscriptions : [],
  };
}

function saveStore(store) {
  writeJsonSafe(STORE_PATH, store);
}

/**
 * Validates and normalizes an activity payload.
 */
function normalizeActivity(input, existing = null) {
  const now = new Date().toISOString();
  const title = typeof input.title === 'string' ? input.title.trim() : existing?.title || '';
  if (!title) {
    return { error: 'El título de la actividad es obligatorio.' };
  }

  const validPriorities = new Set(['alta', 'media', 'baja']);
  const validStatuses = new Set(['pending', 'completed']);

  return {
    activity: {
      id: String(input.id || existing?.id || `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      title: title.slice(0, 140),
      description: typeof input.description === 'string'
        ? input.description.trim().slice(0, 600)
        : (existing?.description || ''),
      category: typeof input.category === 'string' && input.category.trim()
        ? input.category.trim().slice(0, 40)
        : (existing?.category || 'Personal'),
      priority: validPriorities.has(input.priority)
        ? input.priority
        : (existing?.priority || 'media'),
      status: validStatuses.has(input.status)
        ? input.status
        : (existing?.status || 'pending'),
      dueAt: input.dueAt ? String(input.dueAt) : (existing?.dueAt || null),
      reminderMinutes: Number.isFinite(Number(input.reminderMinutes))
        ? Number(input.reminderMinutes)
        : (existing?.reminderMinutes ?? 0),
      reminderSent: typeof input.reminderSent === 'boolean'
        ? input.reminderSent
        : (existing?.reminderSent || false),
      createdAt: existing?.createdAt || input.createdAt || now,
      updatedAt: input.updatedAt || now,
    },
  };
}

function createApp() {
  const app = express();
  const vapidKeys = loadOrCreateVapidKeys();
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:soporte@agendapulse.local';

  webpush.setVapidDetails(vapidSubject, vapidKeys.publicKey, vapidKeys.privateKey);

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Basic security and caching headers suitable for Lighthouse Best Practices
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.path === '/sw.js') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/');
    }
    next();
  });

  app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('sw.js') || filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  // --- CRUD Endpoints ---
  app.get('/api/activities', (_req, res) => {
    const store = loadStore();
    res.json({ activities: store.activities, serverTime: new Date().toISOString() });
  });

  app.post('/api/activities', (req, res) => {
    const store = loadStore();
    const { activity, error } = normalizeActivity(req.body || {});
    if (error) return res.status(400).json({ error });

    const idx = store.activities.findIndex((item) => item.id === activity.id);
    if (idx >= 0) {
      store.activities[idx] = activity;
    } else {
      store.activities.unshift(activity);
    }
    saveStore(store);
    return res.status(201).json({ activity });
  });

  app.put('/api/activities/:id', (req, res) => {
    const store = loadStore();
    const { id } = req.params;
    const idx = store.activities.findIndex((item) => item.id === id);
    const existing = idx >= 0 ? store.activities[idx] : null;
    const { activity, error } = normalizeActivity({ ...(req.body || {}), id }, existing);
    if (error) return res.status(400).json({ error });

    if (idx >= 0) {
      store.activities[idx] = activity;
    } else {
      store.activities.unshift(activity);
    }
    saveStore(store);
    return res.json({ activity });
  });

  app.delete('/api/activities/:id', (req, res) => {
    const store = loadStore();
    const { id } = req.params;
    const before = store.activities.length;
    store.activities = store.activities.filter((item) => item.id !== id);
    if (store.activities.length !== before) {
      saveStore(store);
    }
    return res.json({ deleted: true, id });
  });

  // --- Batch Synchronization Endpoint ---
  app.post('/api/sync', (req, res) => {
    const operations = Array.isArray(req.body?.operations) ? req.body.operations : [];
    const store = loadStore();
    const processed = [];

    for (const opItem of operations) {
      const op = opItem?.op;
      const activityId = String(opItem?.activityId || opItem?.payload?.id || '');
      if (!activityId) continue;

      if (op === 'delete') {
        store.activities = store.activities.filter((a) => a.id !== activityId);
        processed.push({ queueId: opItem.queueId, activityId, status: 'deleted' });
      } else if (op === 'create' || op === 'update') {
        const idx = store.activities.findIndex((a) => a.id === activityId);
        const existing = idx >= 0 ? store.activities[idx] : null;

        // Last-write-wins using updatedAt timestamp
        if (existing && opItem.payload?.updatedAt && existing.updatedAt > opItem.payload.updatedAt) {
          processed.push({ queueId: opItem.queueId, activityId, status: 'skipped_older' });
          continue;
        }

        const { activity, error } = normalizeActivity({ ...(opItem.payload || {}), id: activityId }, existing);
        if (error) {
          processed.push({ queueId: opItem.queueId, activityId, status: 'invalid', error });
          continue;
        }

        if (idx >= 0) {
          store.activities[idx] = activity;
        } else {
          store.activities.unshift(activity);
        }
        processed.push({ queueId: opItem.queueId, activityId, status: 'synced' });
      }
    }

    saveStore(store);
    return res.json({
      ok: true,
      processed,
      activities: store.activities,
      serverTime: new Date().toISOString(),
    });
  });

  // --- Web Push API Endpoints ---
  app.get('/api/push/vapid-public-key', (_req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
  });

  app.post('/api/push/subscribe', (req, res) => {
    const subscription = req.body?.subscription || req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Suscripción Push inválida.' });
    }
    const store = loadStore();
    const exists = store.subscriptions.some((sub) => sub.endpoint === subscription.endpoint);
    if (!exists) {
      store.subscriptions.push(subscription);
      saveStore(store);
    }
    return res.status(201).json({ subscribed: true, totalSubscriptions: store.subscriptions.length });
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    const endpoint = req.body?.endpoint;
    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint requerido.' });
    }
    const store = loadStore();
    store.subscriptions = store.subscriptions.filter((sub) => sub.endpoint !== endpoint);
    saveStore(store);
    return res.json({ unsubscribed: true });
  });

  async function broadcastPush(payloadObj) {
    const store = loadStore();
    if (store.subscriptions.length === 0) {
      return { sent: 0, failed: 0 };
    }
    const payload = JSON.stringify(payloadObj);
    const activeSubs = [];
    let sent = 0;
    let failed = 0;

    await Promise.all(
      store.subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload);
          activeSubs.push(sub);
          sent += 1;
        } catch (err) {
          failed += 1;
          // Keep subscription unless it's permanently gone (404/410)
          if (err?.statusCode !== 404 && err?.statusCode !== 410) {
            activeSubs.push(sub);
          }
        }
      })
    );

    if (activeSubs.length !== store.subscriptions.length) {
      store.subscriptions = activeSubs;
      saveStore(store);
    }

    return { sent, failed };
  }

  app.post('/api/push/test', async (req, res) => {
    const title = req.body?.title || 'AgendaPulse: Push de prueba';
    const body = req.body?.body || 'Las notificaciones Push del servidor backend están funcionando correctamente.';
    const result = await broadcastPush({
      title,
      body,
      tag: 'agendapulse-test',
      url: './',
    });
    return res.json({ ok: true, ...result });
  });

  // Fallback to index.html for SPA routes
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Ruta API no encontrada.' });
    }
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  return { app, broadcastPush };
}

/**
 * Checks due reminders every 30 seconds and triggers Web Push notifications.
 */
function startReminderWorker(broadcastPush) {
  return setInterval(async () => {
    const store = loadStore();
    if (store.subscriptions.length === 0 || store.activities.length === 0) return;

    const nowMs = Date.now();
    let changed = false;

    for (const activity of store.activities) {
      if (activity.status !== 'pending' || activity.reminderSent || !activity.dueAt) continue;
      const dueMs = Date.parse(activity.dueAt);
      if (Number.isNaN(dueMs)) continue;

      const leadMs = (Number(activity.reminderMinutes) || 0) * 60 * 1000;
      const triggerAt = dueMs - leadMs;

      if (nowMs >= triggerAt) {
        activity.reminderSent = true;
        changed = true;
        await broadcastPush({
          title: `Recordatorio: ${activity.title}`,
          body: activity.description || `Programado para ${new Date(dueMs).toLocaleString('es-MX')}`,
          tag: `reminder-${activity.id}`,
          activityId: activity.id,
          url: './',
        });
      }
    }

    if (changed) {
      saveStore(store);
    }
  }, 30000);
}

if (require.main === module) {
  const { app, broadcastPush } = createApp();
  const server = app.listen(PORT, () => {
    console.log(`AgendaPulse PWA escuchando en http://localhost:${PORT}`);
  });
  const timer = startReminderWorker(broadcastPush);
  timer.unref();

  process.on('SIGINT', () => {
    server.close(() => process.exit(0));
  });
}

module.exports = { createApp };
