/**
 * ShieldGuard Backend Server
 * ══════════════════════════
 * Node.js + Express + WebSocket
 *
 * Responsibilities:
 *  1. WebSocket relay — real-time bridge between Android device and dashboard
 *  2. REST API       — device registration, command queuing, log retrieval
 *  3. FCM relay      — push commands to device even when WS is offline
 *  4. Auth           — JWT-based authentication for dashboard sessions
 *
 * Run:  node src/server.js
 * Env:  copy .env.example → .env and fill in values
 */

'use strict';

const express       = require('express');
const http          = require('http');
const { WebSocketServer } = require('ws');
const cors          = require('cors');
const helmet        = require('helmet');
const jwt           = require('jsonwebtoken');
const admin         = require('firebase-admin');
const rateLimit     = require('express-rate-limit');
require('dotenv').config();

// ─── Firebase Admin init ──────────────────────────────────────────────────────
const serviceAccount = require('../config/firebase-service-account.json');
admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});
const db      = admin.firestore();
const storage = admin.storage();

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.DASHBOARD_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({ windowMs: 60_000, max: 100 });
app.use('/api/', limiter);

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

/**
 * Connection registry
 * devices:   { deviceId → WebSocket }  — protected phones
 * dashboards: { deviceId → Set<WebSocket> } — control panels watching that device
 */
const devices    = new Map();
const dashboards = new Map();

wss.on('connection', (ws, req) => {
  const url  = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role');   // 'device' | 'dashboard'
  const did  = url.searchParams.get('deviceId');

  if (!did) { ws.close(4000, 'Missing deviceId'); return; }

  ws.deviceId = did;
  ws.role     = role;
  ws.isAlive  = true;

  // ── Device connection ────────────────────────────────────────────────────
  if (role === 'device') {
    devices.set(did, ws);
    console.log(`[WS] Device connected: ${did}`);

    // Update Firestore presence
    db.collection('devices').doc(did).set(
      { online: true, lastSeen: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    // Flush any queued commands
    flushCommandQueue(did, ws);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        handleDeviceMessage(did, msg);
      } catch (e) { console.error('Invalid message from device:', e.message); }
    });

    ws.on('close', () => {
      devices.delete(did);
      db.collection('devices').doc(did).update({
        online: false,
        lastSeen: admin.firestore.FieldValue.serverTimestamp()
      });
      broadcastToDashboards(did, { type: 'device_offline', deviceId: did });
      console.log(`[WS] Device disconnected: ${did}`);
    });
  }

  // ── Dashboard connection ─────────────────────────────────────────────────
  else if (role === 'dashboard') {
    // Verify JWT
    const token = url.searchParams.get('token');
    if (!verifyToken(token, did)) {
      ws.close(4001, 'Unauthorized'); return;
    }

    if (!dashboards.has(did)) dashboards.set(did, new Set());
    dashboards.get(did).add(ws);
    console.log(`[WS] Dashboard connected for device: ${did}`);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        handleDashboardCommand(did, msg, ws);
      } catch (e) { console.error('Invalid command from dashboard:', e.message); }
    });

    ws.on('close', () => {
      dashboards.get(did)?.delete(ws);
      console.log(`[WS] Dashboard disconnected for device: ${did}`);
    });
  }

  // Heartbeat
  ws.on('pong', () => { ws.isAlive = true; });
});

// Heartbeat interval — kill dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

// ─── Message handlers ─────────────────────────────────────────────────────────

/**
 * handleDeviceMessage
 * Messages coming FROM the Android device → forward to watching dashboards
 */
function handleDeviceMessage(deviceId, msg) {
  // Log important events to Firestore
  if (['location', 'event', 'alert'].includes(msg.type)) {
    db.collection('devices').doc(deviceId)
      .collection('realtime_log')
      .add({ ...msg, serverTimestamp: admin.firestore.FieldValue.serverTimestamp() });
  }

  // Forward to all dashboards watching this device
  broadcastToDashboards(deviceId, msg);
}

/**
 * handleDashboardCommand
 * Commands FROM the dashboard → forward to device (or queue via FCM if offline)
 */
async function handleDashboardCommand(deviceId, cmd, dashWs) {
  // Validate command
  const ALLOWED_COMMANDS = [
    'lock', 'alarm', 'stop_alarm', 'wipe',
    'snapshot_front', 'snapshot_rear',
    'location_ping', 'message', 'tts',
    'airplane_on', 'screen_stream', 'cam_stream'
  ];

  if (!ALLOWED_COMMANDS.includes(cmd.command)) {
    dashWs.send(JSON.stringify({ type: 'error', message: 'Unknown command' }));
    return;
  }

  // Log command
  await db.collection('devices').doc(deviceId)
    .collection('commands')
    .add({
      ...cmd,
      status:    'sent',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

  const deviceWs = devices.get(deviceId);

  if (deviceWs && deviceWs.readyState === 1 /* OPEN */) {
    // Device is online — send directly via WebSocket
    deviceWs.send(JSON.stringify(cmd));
    dashWs.send(JSON.stringify({ type: 'command_sent', via: 'websocket', command: cmd.command }));
  } else {
    // Device offline — push via FCM
    await sendFcmCommand(deviceId, cmd);
    dashWs.send(JSON.stringify({ type: 'command_sent', via: 'fcm', command: cmd.command }));
  }
}

/**
 * broadcastToDashboards — send a message to all dashboards watching a device
 */
function broadcastToDashboards(deviceId, msg) {
  const viewers = dashboards.get(deviceId);
  if (!viewers) return;
  const json = JSON.stringify(msg);
  viewers.forEach((ws) => {
    if (ws.readyState === 1) ws.send(json);
  });
}

/**
 * sendFcmCommand — deliver command via Firebase Cloud Messaging
 */
async function sendFcmCommand(deviceId, cmd) {
  const doc = await db.collection('devices').doc(deviceId).get();
  const fcmToken = doc.data()?.fcmToken;
  if (!fcmToken) { console.warn(`No FCM token for device ${deviceId}`); return; }

  const message = {
    token: fcmToken,
    data:  {
      command: cmd.command,
      text:    cmd.text || ''
    },
    android: {
      priority: 'high',
      ttl:      '3600s'     // Command valid for 1 hour
    }
  };

  try {
    const response = await admin.messaging().send(message);
    console.log(`[FCM] Command sent to ${deviceId}:`, response);
  } catch (e) {
    console.error(`[FCM] Failed to send to ${deviceId}:`, e.message);
  }
}

/**
 * flushCommandQueue — deliver queued commands when device reconnects
 */
async function flushCommandQueue(deviceId, ws) {
  const snapshot = await db.collection('devices').doc(deviceId)
    .collection('commands')
    .where('status', '==', 'queued')
    .get();

  snapshot.forEach((doc) => {
    ws.send(JSON.stringify(doc.data()));
    doc.ref.update({ status: 'delivered' });
  });
}

// ─── REST API ─────────────────────────────────────────────────────────────────

// ── Auth middleware ────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function verifyToken(token, deviceId) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload.deviceId === deviceId;
  } catch { return false; }
}

// ── POST /api/auth/login ───────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password, deviceId } = req.body;
  if (!email || !password || !deviceId)
    return res.status(400).json({ error: 'Missing fields' });

  // Verify against Firestore (hashed passwords in production)
  const ownerDoc = await db.collection('owners').doc(email).get();
  if (!ownerDoc.exists)
    return res.status(401).json({ error: 'Invalid credentials' });

  const owner = ownerDoc.data();
  const bcrypt = require('bcrypt');
  const valid  = await bcrypt.compare(password, owner.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  if (!owner.devices.includes(deviceId))
    return res.status(403).json({ error: 'Device not registered to this account' });

  const token = jwt.sign(
    { email, deviceId, role: 'owner' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({ token, deviceId });
});

// ── POST /api/devices/register ─────────────────────────────────────────────────
app.post('/api/devices/register', async (req, res) => {
  const { deviceId, ownerEmail, deviceName, fcmToken } = req.body;
  if (!deviceId || !ownerEmail)
    return res.status(400).json({ error: 'Missing fields' });

  await db.collection('devices').doc(deviceId).set({
    deviceId, ownerEmail, deviceName: deviceName || 'My Phone',
    fcmToken: fcmToken || '',
    online:   false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // Add device to owner's list
  await db.collection('owners').doc(ownerEmail).set({
    devices: admin.firestore.FieldValue.arrayUnion(deviceId)
  }, { merge: true });

  res.json({ success: true, deviceId });
});

// ── GET /api/devices/:deviceId/status ─────────────────────────────────────────
app.get('/api/devices/:deviceId/status', authMiddleware, async (req, res) => {
  const doc = await db.collection('devices').doc(req.params.deviceId).get();
  if (!doc.exists) return res.status(404).json({ error: 'Device not found' });
  res.json({ ...doc.data(), onlineWs: devices.has(req.params.deviceId) });
});

// ── GET /api/devices/:deviceId/locations ──────────────────────────────────────
app.get('/api/devices/:deviceId/locations', authMiddleware, async (req, res) => {
  const { limit = 100, from } = req.query;
  let query = db.collection('devices').doc(req.params.deviceId)
    .collection('locations')
    .orderBy('timestamp', 'desc')
    .limit(Number(limit));

  if (from) query = query.where('timestamp', '>=', Number(from));

  const snap = await query.get();
  const locations = snap.docs.map(d => d.data());
  res.json({ locations });
});

// ── GET /api/devices/:deviceId/events ─────────────────────────────────────────
app.get('/api/devices/:deviceId/events', authMiddleware, async (req, res) => {
  const snap = await db.collection('devices').doc(req.params.deviceId)
    .collection('events')
    .orderBy('timestamp', 'desc')
    .limit(200)
    .get();
  res.json({ events: snap.docs.map(d => d.data()) });
});

// ── GET /api/devices/:deviceId/photos ─────────────────────────────────────────
app.get('/api/devices/:deviceId/photos', authMiddleware, async (req, res) => {
  const snap = await db.collection('devices').doc(req.params.deviceId)
    .collection('photos')
    .orderBy('timestamp', 'desc')
    .limit(50)
    .get();
  res.json({ photos: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

// ── POST /api/devices/:deviceId/command ───────────────────────────────────────
app.post('/api/devices/:deviceId/command', authMiddleware, async (req, res) => {
  const { command, text } = req.body;
  const deviceId = req.params.deviceId;

  const cmd = { command, text: text || '', timestamp: Date.now() };
  await handleDashboardCommand(deviceId, cmd, {
    send: () => {},       // no WS to reply to for REST callers
    readyState: -1
  });
  res.json({ success: true, command });
});

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:         'ok',
    connectedDevices:   devices.size,
    activeDashboards:   [...dashboards.values()].reduce((a, s) => a + s.size, 0),
    uptime:         process.uptime()
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`ShieldGuard Server running on port ${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
});

module.exports = { app, server };
