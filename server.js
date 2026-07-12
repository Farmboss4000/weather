import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import ioClient from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_KEY = process.env.AMBIENT_APPLICATION_KEY?.trim();
const API_KEY = process.env.AMBIENT_API_KEY?.trim();
const DEVICE_MAC = process.env.AMBIENT_DEVICE_MAC?.trim() || null;
const STATION_TZ = process.env.AMBIENT_STATION_TZ?.trim() || 'UTC';
const PORT = Number(process.env.PORT) || 3000;

const REST_URL = 'https://rt.ambientweather.net/v1/devices';
const REALTIME_URL = 'https://rt2.ambientweather.net';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const RAINFALL_FILE = path.join(__dirname, 'data', 'rainfall.json');

const hasKeys = Boolean(APP_KEY && API_KEY);

const state = {
  configured: hasKeys,
  realtimeConnected: false,
  device: null,
  data: null,
  updatedAt: null,
  lastError: null,
};

const rainfall = {
  days: [],
  updatedAt: null,
  error: null,
  loading: false,
  timezone: STATION_TZ,
  source: null,
};

const forecast = {
  days: [],
  updatedAt: null,
  error: null,
  loading: false,
};

const sseClients = new Set();

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of sseClients) res.write(payload);
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

function extractCoords(info) {
  const geo = info?.coords?.geo;
  if (geo && Array.isArray(geo.coordinates) && geo.coordinates.length === 2) {
    const [lng, lat] = geo.coordinates;
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  const c = info?.coords?.coords;
  if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
    return { lat: c.lat, lng: c.lon };
  }
  return null;
}

function applyReading(mac, info, reading) {
  if (!reading) return;
  if (!matchesDevice(mac)) return;
  const coords = extractCoords(info);
  state.device = {
    macAddress: mac,
    name:
      info?.name ||
      (info?.coords && info.coords.location) ||
      'Kestrel Station',
    location:
      info?.coords?.address ||
      info?.coords?.location ||
      info?.location ||
      null,
    coords,
  };
  state.data = reading;
  state.updatedAt = new Date(
    typeof reading.dateutc === 'number' ? reading.dateutc : Date.now()
  ).toISOString();
  state.lastError = null;
  broadcast();
  maybeStartRainfallRefresh();
  maybeStartForecastRefresh();
}

async function fetchRest() {
  if (!hasKeys) return;
  try {
    const url = `${REST_URL}?applicationKey=${encodeURIComponent(APP_KEY)}&apiKey=${encodeURIComponent(API_KEY)}`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`Ambient REST API responded ${resp.status}`);
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

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: STATION_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function localDay(msEpoch) {
  return dayFmt.format(new Date(msEpoch));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchDeviceHistory(mac, endDate, limit = 288) {
  const url =
    `${REST_URL}/${encodeURIComponent(mac)}` +
    `?applicationKey=${encodeURIComponent(APP_KEY)}` +
    `&apiKey=${encodeURIComponent(API_KEY)}` +
    `&endDate=${encodeURIComponent(endDate.toISOString())}` +
    `&limit=${limit}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (resp.ok) return resp.json();
    if (resp.status === 429 && attempt < 3) {
      const wait = 5000 * Math.pow(2, attempt);
      console.warn(`[rainfall] 429 from Ambient, backing off ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Ambient history endpoint returned ${resp.status}`);
  }
  throw new Error('Ambient history: retries exhausted after repeated 429s');
}

async function loadPersistedRainfall() {
  try {
    const content = await readFile(RAINFALL_FILE, 'utf-8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed.days) && parsed.days.length > 0) {
      rainfall.days = parsed.days;
      rainfall.updatedAt = parsed.updatedAt || null;
      rainfall.timezone = parsed.timezone || STATION_TZ;
      rainfall.source = parsed.source || 'file';
      rainfall.error = null;
      console.log(
        `[rainfall] seeded ${parsed.days.length} days from data/rainfall.json (updated ${parsed.updatedAt || 'unknown'})`
      );
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[rainfall] could not load persisted file:', err.message);
    } else {
      console.log('[rainfall] no persisted file yet; will populate from Ambient');
    }
  }
}

async function refreshRainfallHistory() {
  if (rainfall.loading) return;
  if (!hasKeys) return;
  const mac = state.device?.macAddress || DEVICE_MAC;
  if (!mac) return;

  rainfall.loading = true;
  const allReadings = new Map(); // dateutc -> reading
  let batchError = null;
  let calls = 0;
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  try {
    // Fetch 30 fixed 1-day windows. Each batch returns the most recent 288
    // readings before endDate. This guarantees dense coverage across 30 days
    // regardless of station reporting frequency.
    for (let i = 0; i < 30; i++) {
      const endDate = new Date(now + DAY_MS - i * DAY_MS);
      let readings;
      try {
        readings = await fetchDeviceHistory(mac, endDate, 288);
      } catch (err) {
        batchError = err.message;
        console.error(`[rainfall] batch ${i + 1} failed:`, err.message);
        break;
      }
      calls++;
      if (Array.isArray(readings)) {
        for (const r of readings) {
          const dt =
            typeof r.dateutc === 'number'
              ? r.dateutc
              : new Date(r.date).getTime();
          if (Number.isFinite(dt) && !allReadings.has(dt)) {
            allReadings.set(dt, r);
          }
        }
      }
      if (i < 29) await sleep(1300);
    }

    // Aggregate max(dailyrainin) per station-local day.
    const dayMax = new Map();
    for (const r of allReadings.values()) {
      if (typeof r.dailyrainin !== 'number') continue;
      const dt =
        typeof r.dateutc === 'number'
          ? r.dateutc
          : new Date(r.date).getTime();
      const day = localDay(dt);
      const prev = dayMax.get(day) ?? 0;
      if (r.dailyrainin > prev) dayMax.set(day, r.dailyrainin);
    }

    const days = [];
    for (let i = 0; i < 30; i++) {
      const day = localDay(now - i * DAY_MS);
      const val = dayMax.get(day) ?? 0;
      days.push({ date: day, rainfall_in: Number(val.toFixed(3)) });
    }
    rainfall.days = days;
    rainfall.updatedAt = new Date().toISOString();
    rainfall.error = batchError ? `Partial result: ${batchError}` : null;
    rainfall.source = 'runtime';
    console.log(
      `[rainfall] refreshed ${days.length} days from ${allReadings.size} unique readings across ${calls} call(s)` +
        (batchError ? ` (partial: ${batchError})` : '')
    );
  } catch (err) {
    rainfall.error = err.message;
    console.error('[rainfall] refresh failed:', err.message);
  } finally {
    rainfall.loading = false;
  }
}

let rainfallInitialized = false;
function maybeStartRainfallRefresh() {
  if (rainfallInitialized) return;
  const mac = state.device?.macAddress || DEVICE_MAC;
  if (!mac || !hasKeys) return;
  rainfallInitialized = true;
  setTimeout(refreshRainfallHistory, 3000);
  setInterval(refreshRainfallHistory, 60 * 60 * 1000);
}

async function fetchForecast(lat, lng) {
  if (forecast.loading) return;
  forecast.loading = true;
  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      daily:
        'weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum',
      timezone: 'auto',
      forecast_days: '7',
      temperature_unit: 'fahrenheit',
      precipitation_unit: 'inch',
      windspeed_unit: 'mph',
    });
    const resp = await fetch(`${FORECAST_URL}?${params.toString()}`);
    if (!resp.ok) throw new Error(`Forecast endpoint responded ${resp.status}`);
    const data = await resp.json();
    const d = data.daily || {};
    const n = d.time?.length ?? 0;
    const days = [];
    for (let i = 0; i < n; i++) {
      days.push({
        date: d.time[i],
        code: d.weathercode?.[i] ?? null,
        tempMaxF: d.temperature_2m_max?.[i] ?? null,
        tempMinF: d.temperature_2m_min?.[i] ?? null,
        precipIn: d.precipitation_sum?.[i] ?? 0,
      });
    }
    forecast.days = days;
    forecast.updatedAt = new Date().toISOString();
    forecast.error = null;
    console.log(`[forecast] refreshed ${days.length} day(s)`);
  } catch (err) {
    forecast.error = err.message;
    console.error('[forecast] fetch failed:', err.message);
  } finally {
    forecast.loading = false;
  }
}

let forecastInitialized = false;
function maybeStartForecastRefresh() {
  if (forecastInitialized) return;
  const coords = state.device?.coords;
  if (!coords) return;
  forecastInitialized = true;
  fetchForecast(coords.lat, coords.lng);
  setInterval(() => fetchForecast(coords.lat, coords.lng), 30 * 60 * 1000);
}

function startRealtime() {
  if (!hasKeys) {
    console.warn(
      '[realtime] AMBIENT_APPLICATION_KEY / AMBIENT_API_KEY not set - skipping realtime connection.'
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
    for (const d of devices) applyReading(d.macAddress, d.info, d.lastData);
    if (devices.length === 0) broadcast();
    console.log(`[realtime] subscribed (${devices.length} device(s))`);
  });
  socket.on('data', (reading) =>
    applyReading(reading.macAddress, reading.info, reading)
  );
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

app.get('/api/current', (req, res) => res.json(publicState()));

app.get('/api/rainfall', (req, res) => {
  res.json({
    days: rainfall.days,
    updatedAt: rainfall.updatedAt,
    loading: rainfall.loading,
    timezone: rainfall.timezone,
    error: rainfall.error,
    source: rainfall.source,
  });
});

app.get('/api/forecast', (req, res) => {
  res.json({
    days: forecast.days,
    updatedAt: forecast.updatedAt,
    loading: forecast.loading,
    error: forecast.error,
    hasCoords: Boolean(state.device?.coords),
  });
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

app.get('/api/health', (req, res) => res.json({ ok: true, configured: hasKeys }));

app.listen(PORT, async () => {
  console.log(`Kestrel weather dashboard running on http://localhost:${PORT}`);
  if (!hasKeys) {
    console.warn(
      'WARNING: Ambient Weather keys missing. Copy .env.example to .env and add your keys.'
    );
  }
  console.log(`[rainfall] station timezone: ${STATION_TZ}`);
  await loadPersistedRainfall();
  fetchRest();
  setInterval(fetchRest, 5 * 60 * 1000);
  startRealtime();
});
