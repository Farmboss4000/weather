#!/usr/bin/env node
// Fetch a 30-day rainfall history from the Ambient Weather Network and write
// it to data/rainfall.json. Intended to be run from the daily GitHub Actions
// workflow so the site has fresh baseline data across service restarts.

import { mkdir, writeFile } from 'node:fs/promises';

const APP_KEY = process.env.AMBIENT_APPLICATION_KEY?.trim();
const API_KEY = process.env.AMBIENT_API_KEY?.trim();
const DEVICE_MAC = process.env.AMBIENT_DEVICE_MAC?.trim() || null;
const STATION_TZ = process.env.AMBIENT_STATION_TZ?.trim() || 'UTC';

if (!APP_KEY || !API_KEY) {
  console.error(
    'Missing AMBIENT_APPLICATION_KEY or AMBIENT_API_KEY environment variables.'
  );
  process.exit(1);
}

const REST = 'https://rt.ambientweather.net/v1/devices';

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: STATION_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const localDay = (ms) => dayFmt.format(new Date(ms));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findDevice() {
  const url = `${REST}?applicationKey=${encodeURIComponent(APP_KEY)}&apiKey=${encodeURIComponent(API_KEY)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`/devices returned ${resp.status}`);
  const devices = await resp.json();
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error('No devices on this Ambient Weather account');
  }
  if (DEVICE_MAC) {
    const match = devices.find(
      (d) => String(d.macAddress).toLowerCase() === DEVICE_MAC.toLowerCase()
    );
    if (match) return match;
  }
  return devices[0];
}

async function fetchBatch(mac, endDate, limit = 288) {
  const url =
    `${REST}/${encodeURIComponent(mac)}` +
    `?applicationKey=${encodeURIComponent(APP_KEY)}` +
    `&apiKey=${encodeURIComponent(API_KEY)}` +
    `&endDate=${encodeURIComponent(endDate.toISOString())}` +
    `&limit=${limit}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch(url);
    if (resp.ok) return resp.json();
    if (resp.status === 429 && attempt < 3) {
      const wait = 5000 * Math.pow(2, attempt);
      console.warn(`  429 from Ambient, backing off ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`history endpoint returned ${resp.status}`);
  }
  throw new Error('retries exhausted');
}

async function main() {
  const device = await findDevice();
  const mac = device.macAddress;
  console.log(`Using device: ${mac} (${device.info?.name || 'unnamed'})`);
  await sleep(1500);

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const dayMax = new Map();
  let endDate = new Date();
  let calls = 0;

  while (calls < 40) {
    let readings;
    try {
      readings = await fetchBatch(mac, endDate, 288);
    } catch (err) {
      console.error(`Batch ${calls + 1} failed: ${err.message}`);
      break;
    }
    calls++;
    if (!Array.isArray(readings) || readings.length === 0) break;

    let earliest = Infinity;
    for (const r of readings) {
      const dt =
        typeof r.dateutc === 'number'
          ? r.dateutc
          : new Date(r.date).getTime();
      if (!Number.isFinite(dt)) continue;
      if (dt < earliest) earliest = dt;
      if (typeof r.dailyrainin !== 'number') continue;
      const day = localDay(dt);
      const prev = dayMax.get(day) ?? 0;
      if (r.dailyrainin > prev) dayMax.set(day, r.dailyrainin);
    }
    console.log(
      `Batch ${calls}: ${readings.length} readings, earliest ${new Date(earliest).toISOString()}`
    );
    if (!Number.isFinite(earliest) || earliest <= cutoff) break;
    endDate = new Date(earliest - 1000);
    await sleep(1300);
  }

  const days = [];
  const now = Date.now();
  for (let i = 0; i < 30; i++) {
    const day = localDay(now - i * 24 * 60 * 60 * 1000);
    const val = dayMax.get(day) ?? 0;
    days.push({ date: day, rainfall_in: Number(val.toFixed(3)) });
  }

  const payload = {
    days,
    updatedAt: new Date().toISOString(),
    timezone: STATION_TZ,
    source: 'github-actions:refresh-rainfall',
  };

  await mkdir('data', { recursive: true });
  await writeFile(
    'data/rainfall.json',
    JSON.stringify(payload, null, 2) + '\n',
    'utf-8'
  );
  console.log(
    `Wrote data/rainfall.json (${days.length} days from ${calls} API call(s))`
  );
}

main().catch((err) => {
  console.error('refresh-rainfall failed:', err);
  process.exit(1);
});
