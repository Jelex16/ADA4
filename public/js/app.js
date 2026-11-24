import {
  deleteActivityLocal,
  enqueueSyncOp,
  getActivity,
  getAllActivities,
  getMeta,
  getSyncQueue,
  putActivity,
} from './db.js';
import { registerBackgroundSync, syncWithServer } from './sync.js';
import {
  getCurrentPushSubscription,
  getNotificationPermissionState,
  requestNotificationPermission,
  showAppNotification,
  subscribeToBackendPush,
  triggerServerTestPush,
  unsubscribeFromBackendPush,
} from './notifications.js';

const elements = {
  connectionBadge: document.getElementById('connection-badge'),
  connectionText: document.getElementById('connection-text'),
  syncBtn: document.getElementById('sync-btn'),
  syncBadgeText: document.getElementById('sync-badge-text'),
  installBtn: document.getElementById('install-btn'),

  statTotal: document.getElementById('stat-total'),
  statPending: document.getElementById('stat-pending'),
  statCompleted: document.getElementById('stat-completed'),
  statQueued: document.getElementById('stat-queued'),

  formHeading: document.getElementById('form-heading'),
  cancelEditBtn: document.getElementById('cancel-edit-btn'),
  form: document.getElementById('activity-form'),
  inputId: document.getElementById('activity-id'),
  inputTitle: document.getElementById('activity-title'),
  inputDescription: document.getElementById('activity-description'),
  inputDue: document.getElementById('activity-due'),
  inputReminder: document.getElementById('activity-reminder'),
  inputPriority: document.getElementById('activity-priority'),
  inputCategory: document.getElementById('activity-category'),
  submitBtn: document.getElementById('submit-btn'),

  searchInput: document.getElementById('search-input'),
  filterStatus: document.getElementById('filter-status'),
  filterPriority: document.getElementById('filter-priority'),
  activitiesList: document.getElementById('activities-list'),
  emptyState: document.getElementById('empty-state'),

  notifPermissionLabel: document.getElementById('notif-permission-label'),
  pushStatusLabel: document.getElementById('push-status-label'),
  enableNotifBtn: document.getElementById('enable-notif-btn'),
  subscribePushBtn: document.getElementById('subscribe-push-btn'),
  testLocalNotifBtn: document.getElementById('test-local-notif-btn'),
  testPushNotifBtn: document.getElementById('test-push-notif-btn'),

  diagSw: document.getElementById('diag-sw'),
  diagLastSync: document.getElementById('diag-last-sync'),
  eventLog: document.getElementById('event-log'),
  toastContainer: document.getElementById('toast-container'),
};

let deferredInstallPrompt = null;
let activitiesCache = [];
let isSyncing = false;

function addLog(message) {
  const time = new Date().toLocaleTimeString('es-MX', { hour12: false });
  const entry = document.createElement('div');
  entry.textContent = `[${time}] ${message}`;
  elements.eventLog.prepend(entry);
  while (elements.eventLog.children.length > 25) {
    elements.eventLog.removeChild(elements.eventLog.lastChild);
  }
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3800);
}

function formatDateTime(isoString) {
  if (!isoString) return 'Sin fecha límite';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'Fecha inválida';
  return date.toLocaleString('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function toLocalInputValue(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function updateConnectionUI() {
  const online = navigator.onLine;
  elements.connectionBadge.classList.toggle('status-online', online);
  elements.connectionBadge.classList.toggle('status-offline', !online);
  elements.connectionText.textContent = online ? 'En línea' : 'Sin conexión';
}

async function refreshSyncAndStatsUI() {
  const queue = await getSyncQueue();
  const lastSync = await getMeta('lastSyncAt');
  const total = activitiesCache.length;
  const completed = activitiesCache.filter((a) => a.status === 'completed').length;
  const pending = total - completed;

  elements.statTotal.textContent = String(total);
  elements.statPending.textContent = String(pending);
  elements.statCompleted.textContent = String(completed);
  elements.statQueued.textContent = String(queue.length);

  elements.syncBadgeText.textContent = queue.length > 0
    ? `Sincronizar (${queue.length})`
    : (navigator.onLine ? 'Sincronizado' : 'Modo offline');

  elements.diagLastSync.textContent = lastSync ? formatDateTime(lastSync) : 'Pendiente';
}

function getFilteredActivities() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const statusFilter = elements.filterStatus.value;
  const priorityFilter = elements.filterPriority.value;

  return activitiesCache.filter((item) => {
    if (statusFilter !== 'all' && item.status !== statusFilter) return false;
    if (priorityFilter !== 'all' && item.priority !== priorityFilter) return false;
    if (query) {
      const hay = `${item.title} ${item.description || ''} ${item.category || ''}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}

function renderActivities() {
  const list = getFilteredActivities();
  elements.activitiesList.replaceChildren();
  elements.emptyState.classList.toggle('hidden', list.length > 0);

  for (const item of list) {
    const card = document.createElement('article');
    card.className = `activity-card${item.status === 'completed' ? ' is-completed' : ''}`;
    card.setAttribute('role', 'listitem');

    const top = document.createElement('div');
    top.className = 'activity-top';

    const checkWrap = document.createElement('div');
    checkWrap.className = 'activity-check-wrap';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'activity-checkbox';
    checkbox.checked = item.status === 'completed';
    checkbox.setAttribute('aria-label', `Marcar "${item.title}" como completada`);
    checkbox.addEventListener('change', () => toggleActivityStatus(item.id));

    const textBlock = document.createElement('div');
    const title = document.createElement('h3');
    title.className = 'activity-title';
    title.textContent = item.title;
    textBlock.appendChild(title);

    if (item.description) {
      const desc = document.createElement('p');
      desc.className = 'activity-desc';
      desc.textContent = item.description;
      textBlock.appendChild(desc);
    }

    checkWrap.append(checkbox, textBlock);

    const badges = document.createElement('div');
    badges.className = 'activity-badges';

    const priorityBadge = document.createElement('span');
    priorityBadge.className = `badge badge-${item.priority}`;
    priorityBadge.textContent = item.priority.toUpperCase();
    badges.appendChild(priorityBadge);

    const categoryBadge = document.createElement('span');
    categoryBadge.className = 'badge';
    categoryBadge.textContent = item.category || 'Personal';
    badges.appendChild(categoryBadge);

    if (item.syncPending) {
      const syncBadge = document.createElement('span');
      syncBadge.className = 'badge badge-pending-sync';
      syncBadge.textContent = 'Pendiente de sync';
      badges.appendChild(syncBadge);
    }

    top.append(checkWrap, badges);

    const footer = document.createElement('div');
    footer.className = 'activity-footer';

    const meta = document.createElement('div');
    meta.className = 'activity-meta';
    const reminderTxt = item.dueAt
      ? `Vence: ${formatDateTime(item.dueAt)} · Aviso ${item.reminderMinutes ?? 0} min antes`
      : 'Sin fecha programada';
    meta.textContent = reminderTxt;

    const actions = document.createElement('div');
    actions.className = 'activity-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-ghost btn-sm';
    editBtn.textContent = 'Editar';
    editBtn.addEventListener('click', () => startEditing(item));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.textContent = 'Eliminar';
    delBtn.addEventListener('click', () => deleteActivity(item.id));

    actions.append(editBtn, delBtn);
    footer.append(meta, actions);

    card.append(top, footer);
    elements.activitiesList.appendChild(card);
  }
}

async function reloadFromIndexedDB() {
  activitiesCache = await getAllActivities();
  renderActivities();
  await refreshSyncAndStatsUI();
}

function resetForm() {
  elements.form.reset();
  elements.inputId.value = '';
  elements.inputPriority.value = 'media';
  elements.inputReminder.value = '15';
  elements.inputCategory.value = 'Personal';
  elements.formHeading.textContent = 'Nueva actividad';
  elements.submitBtn.textContent = 'Registrar actividad';
  elements.cancelEditBtn.classList.add('hidden');
}

function startEditing(item) {
  elements.inputId.value = item.id;
  elements.inputTitle.value = item.title;
  elements.inputDescription.value = item.description || '';
  elements.inputDue.value = toLocalInputValue(item.dueAt);
  elements.inputReminder.value = String(item.reminderMinutes ?? 15);
  elements.inputPriority.value = item.priority || 'media';
  elements.inputCategory.value = item.category || 'Personal';

  elements.formHeading.textContent = 'Editar actividad';
  elements.submitBtn.textContent = 'Guardar cambios';
  elements.cancelEditBtn.classList.remove('hidden');
  elements.inputTitle.focus();
}

async function performSync(silent = false) {
  if (isSyncing) return;
  if (!navigator.onLine) {
    await registerBackgroundSync();
    if (!silent) {
      showToast('Sin conexión. Los cambios se sincronizarán automáticamente al reconectar.');
    }
    return;
  }

  isSyncing = true;
  try {
    const result = await syncWithServer();
    await reloadFromIndexedDB();
    if (result.processedCount > 0) {
      addLog(`Sincronizados ${result.processedCount} cambio(s) con el servidor.`);
      if (!silent) showToast(`Sincronización completa (${result.processedCount} cambios).`);
    } else if (!silent) {
      addLog('Sincronización con servidor al día.');
    }
  } catch (err) {
    addLog(`Fallo de sincronización: ${err.message}`);
    await registerBackgroundSync();
    if (!silent) showToast('No se pudo contactar al servidor; cambios guardados localmente.');
  } finally {
    isSyncing = false;
  }
}

async function handleFormSubmit(event) {
  event.preventDefault();
  const title = elements.inputTitle.value.trim();
  if (!title) {
    showToast('Escribe un título para la actividad.');
    elements.inputTitle.focus();
    return;
  }

  const existingId = elements.inputId.value.trim();
  const existing = existingId ? await getActivity(existingId) : null;
  const now = new Date().toISOString();
  const dueInput = elements.inputDue.value;
  const dueIso = dueInput ? new Date(dueInput).toISOString() : null;

  const activity = {
    id: existing ? existing.id : `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    description: elements.inputDescription.value.trim(),
    dueAt: dueIso,
    reminderMinutes: Number(elements.inputReminder.value) || 0,
    priority: elements.inputPriority.value,
    category: elements.inputCategory.value,
    status: existing ? existing.status : 'pending',
    reminderSent: existing && existing.dueAt === dueIso ? Boolean(existing.reminderSent) : false,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    syncPending: true,
  };

  await putActivity(activity);
  await enqueueSyncOp(existing ? 'update' : 'create', activity.id, activity);
  await reloadFromIndexedDB();
  resetForm();

  addLog(`${existing ? 'Actualizada' : 'Registrada'} en IndexedDB: "${activity.title}"`);
  showToast(existing ? 'Actividad actualizada.' : 'Actividad registrada localmente.');

  await performSync(true);
}

async function toggleActivityStatus(id) {
  const existing = await getActivity(id);
  if (!existing) return;

  const updated = {
    ...existing,
    status: existing.status === 'completed' ? 'pending' : 'completed',
    updatedAt: new Date().toISOString(),
    syncPending: true,
  };

  await putActivity(updated);
  await enqueueSyncOp('update', updated.id, updated);
  await reloadFromIndexedDB();
  addLog(`Estado cambiado a ${updated.status}: "${updated.title}"`);
  await performSync(true);
}

async function deleteActivity(id) {
  const existing = await getActivity(id);
  await deleteActivityLocal(id);
  await enqueueSyncOp('delete', id, null);
  await reloadFromIndexedDB();

  if (elements.inputId.value === id) {
    resetForm();
  }

  addLog(`Eliminada de IndexedDB: "${existing?.title || id}"`);
  showToast('Actividad eliminada.');
  await performSync(true);
}

async function checkLocalReminders() {
  if (getNotificationPermissionState() !== 'granted') return;

  const nowMs = Date.now();
  let changed = false;

  for (const activity of activitiesCache) {
    if (activity.status !== 'pending' || activity.reminderSent || !activity.dueAt) continue;
    const dueMs = Date.parse(activity.dueAt);
    if (Number.isNaN(dueMs)) continue;

    const leadMs = (Number(activity.reminderMinutes) || 0) * 60 * 1000;
    if (nowMs >= dueMs - leadMs) {
      await showAppNotification(`Recordatorio: ${activity.title}`, {
        body: activity.description || `Programado para ${formatDateTime(activity.dueAt)}`,
        tag: `reminder-${activity.id}`,
        data: { activityId: activity.id, url: '/' },
        actions: [
          { action: 'complete', title: 'Marcar completada' },
          { action: 'open', title: 'Ver actividad' },
        ],
      });

      const updated = {
        ...activity,
        reminderSent: true,
        updatedAt: new Date().toISOString(),
        syncPending: true,
      };
      await putActivity(updated);
      await enqueueSyncOp('update', updated.id, updated);
      changed = true;
      addLog(`Recordatorio disparado: "${activity.title}"`);
    }
  }

  if (changed) {
    await reloadFromIndexedDB();
    await performSync(true);
  }
}

async function refreshNotificationUI() {
  const perm = getNotificationPermissionState();
  const labels = {
    granted: 'Concedido',
    denied: 'Bloqueado',
    default: 'Sin solicitar',
    unsupported: 'No soportado',
  };
  elements.notifPermissionLabel.textContent = labels[perm] || perm;

  try {
    const sub = await getCurrentPushSubscription();
    elements.pushStatusLabel.textContent = sub ? 'Suscripción activa' : 'Inactiva';
    elements.subscribePushBtn.textContent = sub
      ? 'Cancelar suscripción Push'
      : 'Suscribirse a Push Backend';
  } catch {
    elements.pushStatusLabel.textContent = 'No disponible';
  }
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    elements.diagSw.textContent = 'No soportado';
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    elements.diagSw.textContent = registration.active ? 'Activo y cacheando' : 'Registrado';
    addLog('Service Worker registrado correctamente.');

    registration.addEventListener('updatefound', () => {
      addLog('Nueva versión de Service Worker detectada.');
    });

    navigator.serviceWorker.addEventListener('message', async (event) => {
      if (event.data?.type === 'SYNC_COMPLETED') {
        addLog(`Background Sync completado (${event.data.count} operaciones).`);
        await reloadFromIndexedDB();
        showToast('Sincronización en segundo plano completada.');
      } else if (event.data?.type === 'ACTIVITY_UPDATED_FROM_NOTIF') {
        addLog('Actividad completada desde notificación.');
        await reloadFromIndexedDB();
        await performSync(true);
      }
    });
  } catch (err) {
    elements.diagSw.textContent = 'Error de registro';
    addLog(`Error Service Worker: ${err.message}`);
  }
}

function applyUrlShortcuts() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('action') === 'new') {
    elements.inputTitle.focus();
  }
  const filter = params.get('filter');
  if (filter === 'pending' || filter === 'completed') {
    elements.filterStatus.value = filter;
  }
}

async function init() {
  updateConnectionUI();
  applyUrlShortcuts();

  window.addEventListener('online', async () => {
    updateConnectionUI();
    addLog('Conexión restablecida. Ejecutando sincronización...');
    showToast('Conexión recuperada. Sincronizando cambios...');
    await performSync(false);
  });

  window.addEventListener('offline', () => {
    updateConnectionUI();
    addLog('Sin conexión. Operando con IndexedDB y caché del Service Worker.');
    showToast('Modo sin conexión activo. Tus cambios se guardarán en IndexedDB.');
    refreshSyncAndStatsUI();
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    elements.installBtn.classList.remove('hidden');
  });

  elements.installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    addLog(`Instalación PWA: ${outcome}`);
    deferredInstallPrompt = null;
    elements.installBtn.classList.add('hidden');
  });

  elements.form.addEventListener('submit', handleFormSubmit);
  elements.cancelEditBtn.addEventListener('click', resetForm);
  elements.syncBtn.addEventListener('click', () => performSync(false));

  elements.searchInput.addEventListener('input', renderActivities);
  elements.filterStatus.addEventListener('change', renderActivities);
  elements.filterPriority.addEventListener('change', renderActivities);

  elements.enableNotifBtn.addEventListener('click', async () => {
    try {
      const perm = await requestNotificationPermission();
      await refreshNotificationUI();
      addLog(`Permiso de notificaciones: ${perm}`);
      if (perm === 'granted') {
        await showAppNotification('Notificaciones activadas', {
          body: 'AgendaPulse te avisará cuando tus recordatorios estén próximos.',
        });
      }
    } catch (err) {
      showToast(err.message);
    }
  });

  elements.subscribePushBtn.addEventListener('click', async () => {
    try {
      const current = await getCurrentPushSubscription();
      if (current) {
        await unsubscribeFromBackendPush();
        addLog('Suscripción Web Push cancelada.');
        showToast('Suscripción Push desactivada.');
      } else {
        await subscribeToBackendPush();
        addLog('Suscripción Web Push registrada en el servidor.');
        showToast('Suscripción Push activada.');
      }
      await refreshNotificationUI();
    } catch (err) {
      showToast(err.message);
      addLog(`Error Push: ${err.message}`);
    }
  });

  elements.testLocalNotifBtn.addEventListener('click', async () => {
    if (getNotificationPermissionState() !== 'granted') {
      await requestNotificationPermission();
      await refreshNotificationUI();
    }
    const ok = await showAppNotification('Recordatorio local de prueba', {
      body: 'Ejemplo generado mediante la Notifications API del navegador.',
      tag: 'local-test',
    });
    if (!ok) showToast('Permiso de notificaciones requerido.');
  });

  elements.testPushNotifBtn.addEventListener('click', async () => {
    try {
      const result = await triggerServerTestPush();
      addLog(`Push servidor enviado (${result.sent} exitosos, ${result.failed} fallidos).`);
      showToast(`Push enviado a ${result.sent} suscripción(es).`);
    } catch (err) {
      showToast(err.message);
    }
  });

  await registerServiceWorker();
  await reloadFromIndexedDB();
  await refreshNotificationUI();
  await performSync(true);

  // Check local reminders every 15 seconds while the app is open
  setInterval(checkLocalReminders, 15000);
  checkLocalReminders();
}

init();
