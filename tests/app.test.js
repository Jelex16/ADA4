const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { createApp } = require('../server');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

function startTestServer() {
  const { app } = createApp();
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('CRUD, Sync offline batch y endpoints Web Push funcionan correctamente', async (t) => {
  const backup = fs.existsSync(STORE_PATH) ? fs.readFileSync(STORE_PATH, 'utf8') : null;
  if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);

  const { server, baseUrl } = await startTestServer();
  t.after(() => {
    server.close();
    if (backup !== null) {
      fs.writeFileSync(STORE_PATH, backup, 'utf8');
    } else if (fs.existsSync(STORE_PATH)) {
      fs.unlinkSync(STORE_PATH);
    }
  });

  // 1. Health check
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.ok, true);

  // 2. Create activity
  const createRes = await fetch(`${baseUrl}/api/activities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'act_test_1',
      title: 'Preparar presentación PWA',
      description: 'Incluir capturas offline y reporte Lighthouse',
      priority: 'alta',
      category: 'Estudio',
      reminderMinutes: 15,
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.activity.id, 'act_test_1');
  assert.equal(created.activity.status, 'pending');

  // 3. Read activities
  const listRes = await fetch(`${baseUrl}/api/activities`);
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.equal(listData.activities.length, 1);

  // 4. Update activity
  const updateRes = await fetch(`${baseUrl}/api/activities/act_test_1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'completed', priority: 'media' }),
  });
  assert.equal(updateRes.status, 200);
  const updated = await updateRes.json();
  assert.equal(updated.activity.status, 'completed');
  assert.equal(updated.activity.priority, 'media');

  // 5. Batch sync endpoint (offline queue replay)
  const syncRes = await fetch(`${baseUrl}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operations: [
        {
          queueId: 1,
          op: 'create',
          activityId: 'act_offline_2',
          payload: {
            id: 'act_offline_2',
            title: 'Actividad creada sin conexión',
            priority: 'alta',
            category: 'Personal',
            status: 'pending',
          },
        },
        {
          queueId: 2,
          op: 'delete',
          activityId: 'act_test_1',
          payload: null,
        },
      ],
    }),
  });
  assert.equal(syncRes.status, 200);
  const syncData = await syncRes.json();
  assert.equal(syncData.ok, true);
  assert.equal(syncData.activities.length, 1);
  assert.equal(syncData.activities[0].id, 'act_offline_2');

  // 6. VAPID public key + push test
  const vapidRes = await fetch(`${baseUrl}/api/push/vapid-public-key`);
  assert.equal(vapidRes.status, 200);
  const vapidData = await vapidRes.json();
  assert.ok(typeof vapidData.publicKey === 'string' && vapidData.publicKey.length > 20);

  const pushTestRes = await fetch(`${baseUrl}/api/push/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Test', body: 'Push check' }),
  });
  assert.equal(pushTestRes.status, 200);

  // 7. Delete remaining activity
  const delRes = await fetch(`${baseUrl}/api/activities/act_offline_2`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  const finalList = await (await fetch(`${baseUrl}/api/activities`)).json();
  assert.equal(finalList.activities.length, 0);
});
