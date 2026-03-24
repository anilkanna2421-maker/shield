'use strict';

const express       = require('express');
const http          = require('http');
const { WebSocketServer } = require('ws');
const cors          = require('cors');
const helmet        = require('helmet');
const jwt           = require('jsonwebtoken');
const admin         = require('firebase-admin');
const rateLimit     = require('express-rate-limit');

// ─── HARDCODED CONFIG ─────────────────────────────────────────────────────────
const PORT = 3001;
const JWT_SECRET = "sdcfvhbhbhvh6t76gyugj[-=pjuhgguyfjt]684684gc&%$#@ercfg.,ghj";
const DASHBOARD_ORIGIN = "https://peach-noella-71.tiiny.site";
const FIREBASE_STORAGE_BUCKET = "shieldguard-9d7a2.firebasestorage.app";

// ─── Firebase Admin init ──────────────────────────────────────────────────────
const serviceAccount = require('../shieldguard-9d7a2-firebase-adminsdk-fbsvc-4c6db5a37c.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: FIREBASE_STORAGE_BUCKET
});

const db = admin.firestore();

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(helmet());
app.use(cors({ origin: DASHBOARD_ORIGIN }));
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({ windowMs: 60_000, max: 100 });
app.use('/api/', limiter);

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

const devices    = new Map();
const dashboards = new Map();

// ─── WS CONNECTION ────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const url  = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role');
  const did  = url.searchParams.get('deviceId');

  if (!did) { ws.close(4000, 'Missing deviceId'); return; }

  ws.deviceId = did;
  ws.role     = role;
  ws.isAlive  = true;

  // ── DEVICE ────────────────────────────────────────────────────────────────
  if (role === 'device') {
    devices.set(did, ws);
    console.log(`[WS] Device connected: ${did}`);

    db.collection('devices').doc(did).set({
      online: true,
      lastSeen: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    flushCommandQueue(did, ws);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        handleDeviceMessage(did, msg);
      } catch (e) {
        console.error('Invalid device message:', e.message);
      }
    });

    ws.on('close', () => {
      devices.delete(did);

      db.collection('devices').doc(did).update({
        online: false,
        lastSeen: admin.firestore.FieldValue.serverTimestamp()
      });

      broadcastToDashboards(did, { type: 'device_offline', deviceId: did });
    });
  }

  // ── DASHBOARD ─────────────────────────────────────────────────────────────
  else if (role === 'dashboard') {
    const token = url.searchParams.get('token');

    if (!verifyToken(token, did)) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    if (!dashboards.has(did)) dashboards.set(did, new Set());
    dashboards.get(did).add(ws);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        handleDashboardCommand(did, msg, ws);
      } catch (e) {
        console.error('Invalid dashboard message:', e.message);
      }
    });

    ws.on('close', () => {
      const set = dashboards.get(did);
      set?.delete(ws);
      if (set && set.size === 0) dashboards.delete(did);
    });
  }

  ws.on('pong', () => { ws.isAlive = true; });
});

// ─── HEARTBEAT ───────────────────────────────────────────────────────────────
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ─── MESSAGE HANDLERS ─────────────────────────────────────────────────────────
function handleDeviceMessage(deviceId, msg) {
  if (['location', 'event', 'alert'].includes(msg.type)) {
    db.collection('devices').doc(deviceId)
      .collection('realtime_log')
      .add({
        ...msg,
        serverTimestamp: admin.firestore.FieldValue.serverTimestamp()
      });
  }

  broadcastToDashboards(deviceId, msg);
}

async function handleDashboardCommand(deviceId, cmd, dashWs) {
  const ALLOWED_COMMANDS = [
    'lock','alarm','stop_alarm','wipe',
    'snapshot_front','snapshot_rear',
    'location_ping','message','tts',
    'airplane_on','screen_stream','cam_stream'
  ];

  if (!ALLOWED_COMMANDS.includes(cmd.command)) {
    dashWs.send(JSON.stringify({ type: 'error', message: 'Unknown command' }));
    return;
  }

  const deviceWs = devices.get(deviceId);

  await db.collection('devices').doc(deviceId)
    .collection('commands')
    .add({
      ...cmd,
      status: deviceWs ? 'sent' : 'queued',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

  if (deviceWs && deviceWs.readyState === 1) {
    deviceWs.send(JSON.stringify(cmd));
    dashWs.send(JSON.stringify({ type: 'command_sent', via: 'websocket' }));
  } else {
    await sendFcmCommand(deviceId, cmd);
    dashWs.send(JSON.stringify({ type: 'command_sent', via: 'fcm' }));
  }
}

function broadcastToDashboards(deviceId, msg) {
  const viewers = dashboards.get(deviceId);
  if (!viewers) return;

  const json = JSON.stringify(msg);
  viewers.forEach(ws => {
    if (ws.readyState === 1) ws.send(json);
  });
}

// ─── FCM ──────────────────────────────────────────────────────────────────────
async function sendFcmCommand(deviceId, cmd) {
  try {
    const doc = await db.collection('devices').doc(deviceId).get();
    const token = doc.data()?.fcmToken;

    if (!token) return;

    await admin.messaging().send({
      token,
      data: {
        command: cmd.command,
        text: cmd.text || ''
      },
      android: { priority: 'high', ttl: '3600s' }
    });

  } catch (e) {
    console.error('FCM error:', e.message);
  }
}

// ─── QUEUE ───────────────────────────────────────────────────────────────────
async function flushCommandQueue(deviceId, ws) {
  const snap = await db.collection('devices').doc(deviceId)
    .collection('commands')
    .where('status', '==', 'queued')
    .get();

  snap.forEach(doc => {
    ws.send(JSON.stringify(doc.data()));
    doc.ref.update({ status: 'delivered' });
  });
}

// ─── AUTH ────────────────────────────────────────────────────────────────────
function verifyToken(token, deviceId) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.deviceId === deviceId;
  } catch { return false; }
}

// ─── START ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
