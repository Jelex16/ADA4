const DB_NAME = 'ada4-pwa-db';
const DB_VERSION = 1;

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transacción abortada'));
  });
}

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

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
        const queue = db.createObjectStore('syncQueue', {
          keyPath: 'queueId',
          autoIncrement: true,
        });
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

export async function getAllActivities() {
  const db = await openDatabase();
  const tx = db.transaction('activities', 'readonly');
  const items = await requestToPromise(tx.objectStore('activities').getAll());
  db.close();
  return items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getActivity(id) {
  const db = await openDatabase();
  const tx = db.transaction('activities', 'readonly');
  const item = await requestToPromise(tx.objectStore('activities').get(id));
  db.close();
  return item || null;
}

export async function putActivity(activity) {
  const db = await openDatabase();
  const tx = db.transaction('activities', 'readwrite');
  tx.objectStore('activities').put(activity);
  await transactionDone(tx);
  db.close();
  return activity;
}

export async function deleteActivityLocal(id) {
  const db = await openDatabase();
  const tx = db.transaction('activities', 'readwrite');
  tx.objectStore('activities').delete(id);
  await transactionDone(tx);
  db.close();
}

export async function mergeServerActivities(serverActivities) {
  const db = await openDatabase();
  const tx = db.transaction(['activities', 'syncQueue'], 'readwrite');
  const queueItems = await requestToPromise(tx.objectStore('syncQueue').getAll());
  const queuedIds = new Set(queueItems.map((q) => q.activityId));
  const store = tx.objectStore('activities');

  // Remove stale synced items not present on server and not queued locally
  const localItems = await requestToPromise(store.getAll());
  const serverMap = new Map(serverActivities.map((item) => [item.id, item]));

  for (const local of localItems) {
    if (!serverMap.has(local.id) && !queuedIds.has(local.id)) {
      store.delete(local.id);
    }
  }

  for (const serverItem of serverActivities) {
    if (!queuedIds.has(serverItem.id)) {
      store.put({ ...serverItem, syncPending: false });
    }
  }

  await transactionDone(tx);
  db.close();
}

export async function enqueueSyncOp(op, activityId, payload = null) {
  const db = await openDatabase();
  const tx = db.transaction('syncQueue', 'readwrite');
  const entry = {
    op,
    activityId,
    payload,
    createdAt: new Date().toISOString(),
  };
  const queueId = await requestToPromise(tx.objectStore('syncQueue').add(entry));
  await transactionDone(tx);
  db.close();
  return { ...entry, queueId };
}

export async function getSyncQueue() {
  const db = await openDatabase();
  const tx = db.transaction('syncQueue', 'readonly');
  const items = await requestToPromise(tx.objectStore('syncQueue').getAll());
  db.close();
  return items;
}

export async function clearSyncQueueItems(queueIds) {
  if (!queueIds.length) return;
  const db = await openDatabase();
  const tx = db.transaction('syncQueue', 'readwrite');
  const store = tx.objectStore('syncQueue');
  for (const qid of queueIds) {
    store.delete(qid);
  }
  await transactionDone(tx);
  db.close();
}

export async function getMeta(key) {
  const db = await openDatabase();
  const tx = db.transaction('meta', 'readonly');
  const row = await requestToPromise(tx.objectStore('meta').get(key));
  db.close();
  return row ? row.value : null;
}

export async function setMeta(key, value) {
  const db = await openDatabase();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await transactionDone(tx);
  db.close();
}
