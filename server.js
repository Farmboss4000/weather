import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ioClient from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_KEY = process.env.AMBIENT_APPLICATION_KEY?.trim();
const API_KEY = process.env.AMBIENT_API_KEY?.trim();
const DEVICE_MAC = process.env.AMBIENT_DEVICE_MAC?.trim() || null;
const PORT = Number(process.env.PORT) || 3000;

const REST_URL = 'https://rt.ambientweather.net/v1/devices';
const REALTIME_URL = 'https://rt2.ambientweather.net';

const hasKeys = Boolean(APP_KEY && API_KEY);

/** In-memory view of the latest known state. */
const state = {
  configured: hasKeys,
  realtimeConnected: false,
  device: null, // { macAddress, name, location }
  data: null, // latest weather reading object from Ambient
  updatedAt: null, // ISO timestamp of last data update
  lastError: null,
};

/** Server-Sent Events subscribers. */
const sseClients = new Set();

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

function publicState() {
  return {
    configured: state.configured,
    realtimeConnected: state.realtimeConnected,
    device: state.device,
    data: state.data,
    updatedAt: state.updatedAt,
    lastError: state.lastError,
  };
}

function matchesDevice(mac) {
  if (!DEVICE_MAC) return true;
  return String(mac).toLowerCase() === DEVICE_MAC.toLowerCase();
}

function applyReading(mac, info, reading) {
  if (!reading) return;
  if (!matchesDevice(mac)) return;
  state.device = {
    macAddress: mac,
    name: info?.name || (info?.coords && info.coords.location) || 'Kestrel Station',
    location:
      info?.coords?.address ||
      info?.coords?.location ||
      info?.location ||
      null,
  };
  state.data = reading;
  state.updatedAt = new Date(
    typeof reading.dateutc === 'number' ? reading.dateutc : Date.now()
  ).toISOString();
  state.lastError = null;
  broadcast();
}

/** One-shot REST fetch — used for the initial snapshot and as a fallback. */
async function fetchRest() {
  if (!hasKeys) return;
  try {
    const url = `${REST_URL}?applicationKey=${encodeURIComponent(
      APP_KEY
    )}&apiKey=${encodeURIComponent(API_KEY)}`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) {
      throw new Error(`Ambient REST API responded ${resp.status}`);
    }
    const devices = await resp.json();
    if (!Array.isArray(devices) || devices.length === 0) {
      state.lastError =
        'No devices found on this Ambient Weather account. Is the Kestrel reporting?';
      broadcast();
      return;
    }
    const device =
      (DEVICE_MAC &&
        devices.find(
          (d) =>
            String(d.macAddress).toLowerCase() === DEVICE_MAC.toLowerCase()
        )) ||
      devices[0];
    applyReading(device.macAddress, device.info, device.lastData);
  } catch (err) {
    state.lastError = err.message;
    broadcast();
    console.error('[rest] fetch failed:', err.message);
  }
}

/** Persistent realtime subscription to the Ambient Weather socket. */
function startRealtime() {
  if (!hasKeys) {
    console.warn(
      '[realtime] AMBIENT_APPLICATION_KEY / AMBIENT_API_KEY not set — skipping realtime connection.'
    );
    return;
  }

  const socket = ioClient(REALTIME_URL, {
    query: { api: 1, applicationKey: APP_KEY },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
  });

  socket.on('connect', () => {
    console.log('[realtime] connected, subscribing...');
    socket.emit('subscribe', { apiKeys: [API_KEY] });
  });

  socket.on('subscribed', (msg) => {
    state.realtimeConnected = true;
    const devices = msg?.devices || [];
    for (const d of devices) {
      applyReading(d.macAddress, d.info, d.lastData);
    }
    if (devices.length === 0) {
      // Subscribed but no cached data yet — wait for the next 'data' event.
      broadcast();
    }
    console.log(`[realtime] subscribed (${devices.length} device(s))`);
  });

  socket.on('data', (reading) => {
    applyReading(reading.macAddress, reading.info, reading);
  });

  socket.on('disconnect', (reason) => {
    state.realtimeConnected = false;
    broadcast();
    console.warn(`[realtime] disconnected: ${reason}`);
  });

  socket.on('connect_error', (err) => {
    state.realtimeConnected = false;
    state.lastError = `Realtime connection error: ${err.message}`;
    broadcast();
    console.error('[realtime] connect_error:', err.message);
  });
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/current', (req, res) => {
  res.json(publicState());
});

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify(publicState())}\n\n`);

  sseClients.add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, configured: hasKeys });
});

app.listen(PORT, () => {
  console.log(`Kestrel weather dashboard running on http://localhost:${PORT}`);
  if (!hasKeys) {
    console.warn(
      'WARNING: Ambient Weather keys missing. Copy .env.example to .env and add your keys.'
    );
  }
  fetchRest();
  // Periodic REST refresh as a safety net if the socket goes quiet.
  setInterval(fetchRest, 5 * 60 * 1000);
  startRealtime();
});
