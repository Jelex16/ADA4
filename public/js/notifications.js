function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function getNotificationPermissionState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    throw new Error('Este navegador no soporta la Notifications API.');
  }
  const result = await Notification.requestPermission();
  return result;
}

export async function showAppNotification(title, options = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return false;
  }

  const payload = {
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    lang: 'es',
    ...options,
  };

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, payload);
      return true;
    } catch {
      // Fallback below
    }
  }

  new Notification(title, payload);
  return true;
}

export async function getCurrentPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return null;
  }
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function subscribeToBackendPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push API no está soportada en este navegador.');
  }

  const permission = await requestNotificationPermission();
  if (permission !== 'granted') {
    throw new Error('Se requiere permiso de notificaciones para activar Push API.');
  }

  const reg = await navigator.serviceWorker.ready;
  let subscription = await reg.pushManager.getSubscription();

  if (!subscription) {
    const keyRes = await fetch('/api/push/vapid-public-key');
    if (!keyRes.ok) throw new Error('No se pudo obtener la llave pública VAPID.');
    const { publicKey } = await keyRes.json();

    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const saveRes = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription }),
  });

  if (!saveRes.ok) {
    throw new Error('Error al registrar la suscripción Push en el servidor.');
  }

  return subscription;
}

export async function unsubscribeFromBackendPush() {
  const subscription = await getCurrentPushSubscription();
  if (!subscription) return false;

  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => {});

  await subscription.unsubscribe();
  return true;
}

export async function triggerServerTestPush() {
  const res = await fetch('/api/push/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'AgendaPulse Push',
      body: 'Notificación Push enviada desde el servicio backend con VAPID.',
    }),
  });
  if (!res.ok) throw new Error('El servidor no pudo enviar el Push de prueba.');
  return res.json();
}
