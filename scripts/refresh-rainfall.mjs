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
const DAY_MS = 24 * 60 * 60 * 1000;

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

  const allReadings = new Map(); // dateutc -> reading
  const now = Date.now();
  let calls = 0;

  // Fetch 30 fixed 1-day windows so coverage is dense regardless of the
  // station's reporting frequency. On a 5-min-reporting station this gives
  // ~30 non-overlapping days at full resolution; on sparse stations it gives
  // heavy overlap that dedupes but keeps recent-day density high.
  for (let i = 0; i < 30; i++) {
    const endDate = new Date(now + DAY_MS - i * DAY_MS);
    let readings;
    try {
      readings = await fetchBatch(mac, endDate, 288);
    } catch (err) {
      console.error(`Batch ${i + 1} failed: ${err.message}`);
      break;
    }
    calls++;
    if (Array.isArray(readings)) {
      let added = 0;
      for (const r of readings) {
        const dt =
          typeof r.dateutc === 'number'
            ? r.dateutc
            : new Date(r.date).getTime();
        if (Number.isFinite(dt) && !allReadings.has(dt)) {
          allReadings.set(dt, r);
          added++;
        }
      }
      console.log(
        `Batch ${i + 1}/${30} endDate=${endDate.toISOString()}: ` +
          `${readings.length} readings, ${added} new (total ${allReadings.size})`
      );
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
    `Wrote data/rainfall.json (${days.length} days from ${allReadings.size} unique readings across ${calls} calls)`
  );
}

main().catch((err) => {
  console.error('refresh-rainfall failed:', err);
  process.exit(1);
});
