import {
  clearSyncQueueItems,
  getAllActivities,
  getSyncQueue,
  mergeServerActivities,
  putActivity,
  setMeta,
} from './db.js';

export async function registerBackgroundSync() {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    if ('sync' in registration) {
      await registration.sync.register('sync-activities');
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function syncWithServer() {
  if (!navigator.onLine) {
    return { synced: false, reason: 'offline', processedCount: 0 };
  }

  const queue = await getSyncQueue();

  if (queue.length > 0) {
    const response = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations: queue }),
    });

    if (!response.ok) {
      throw new Error(`Error HTTP ${response.status} al sincronizar`);
    }

    const data = await response.json();
    const processedIds = (data.processed || []).map((item) => item.queueId).filter(Boolean);
    await clearSyncQueueItems(processedIds.length ? processedIds : queue.map((q) => q.queueId));

    // Mark remaining local activities as synced and merge server state
    const locals = await getAllActivities();
    for (const item of locals) {
      if (item.syncPending) {
        await putActivity({ ...item, syncPending: false });
      }
    }

    if (Array.isArray(data.activities)) {
      await mergeServerActivities(data.activities);
    }

    const syncTime = data.serverTime || new Date().toISOString();
    await setMeta('lastSyncAt', syncTime);

    return {
      synced: true,
      processedCount: queue.length,
      serverTime: syncTime,
    };
  }

  // No pending outbound operations: pull latest state from backend
  const response = await fetch('/api/activities', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Error HTTP ${response.status} al consultar actividades`);
  }
  const data = await response.json();
  if (Array.isArray(data.activities)) {
    await mergeServerActivities(data.activities);
  }
  const syncTime = data.serverTime || new Date().toISOString();
  await setMeta('lastSyncAt', syncTime);

  return {
    synced: true,
    processedCount: 0,
    serverTime: syncTime,
  };
}
