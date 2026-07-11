'use strict';

let units = localStorage.getItem('units') === 'metric' ? 'metric' : 'imperial';

const el = (id) => document.getElementById(id);

const fToC = (f) => ((f - 32) * 5) / 9;
const mphToKmh = (m) => m * 1.60934;
const inhgToHpa = (v) => v * 33.86389;
const inToMm = (v) => v * 25.4;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r = (v, d = 1) => {
  const p = 10 ** d;
  return Math.round(v * p) / p;
};

function compass(deg) {
  if (!isNum(deg)) return '--';
  const dirs = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  return dirs[Math.round(deg / 22.5) % 16];
}

function temp(f) {
  if (!isNum(f)) return { value: '--', unit: units === 'metric' ? '°C' : '°F' };
  return units === 'metric'
    ? { value: r(fToC(f)), unit: '°C' }
    : { value: r(f), unit: '°F' };
}

function speed(mph) {
  if (!isNum(mph)) return { value: '--', unit: units === 'metric' ? 'km/h' : 'mph' };
  return units === 'metric'
    ? { value: r(mphToKmh(mph)), unit: 'km/h' }
    : { value: r(mph), unit: 'mph' };
}

function pressure(inhg) {
  if (!isNum(inhg)) return { value: '--', unit: units === 'metric' ? 'hPa' : 'inHg' };
  return units === 'metric'
    ? { value: r(inhgToHpa(inhg), 0), unit: 'hPa' }
    : { value: r(inhg, 2), unit: 'inHg' };
}

function rain(inch) {
  if (!isNum(inch)) return { value: '--', unit: units === 'metric' ? 'mm' : 'in' };
  return units === 'metric'
    ? { value: r(inToMm(inch)), unit: 'mm' }
    : { value: r(inch, 2), unit: 'in' };
}

function buildCards(d) {
  const cards = [];
  const add = (label, m, sub) =>
    cards.push({ label, value: m.value, unit: m.unit, sub });

  if (isNum(d.humidity)) add('Humidity', { value: r(d.humidity, 0), unit: '%' });
  if (isNum(d.windspeedmph)) {
    add('Wind', speed(d.windspeedmph), `${compass(d.winddir)} (${r(d.winddir, 0)}°)`);
  }
  if (isNum(d.windgustmph)) add('Gust', speed(d.windgustmph));
  if (isNum(d.dewPoint)) add('Dew Point', temp(d.dewPoint));
  if (isNum(d.baromrelin)) add('Pressure', pressure(d.baromrelin));
  if (isNum(d.hourlyrainin)) add('Rain (1h)', rain(d.hourlyrainin));
  if (isNum(d.dailyrainin)) add('Rain (today)', rain(d.dailyrainin));
  if (isNum(d.solarradiation))
    add('Solar', { value: r(d.solarradiation, 0), unit: 'W/m²' });
  if (isNum(d.uv)) add('UV Index', { value: r(d.uv, 0), unit: '' });
  if (isNum(d.tempinf)) add('Indoor Temp', temp(d.tempinf));
  if (isNum(d.humidityin))
    add('Indoor Hum.', { value: r(d.humidityin, 0), unit: '%' });
  if (isNum(d.maxdailygust)) add('Max Gust Today', speed(d.maxdailygust));
  return cards;
}

function render(stateData) {
  const errEl = el('error');

  if (!stateData.configured) {
    errEl.hidden = false;
    errEl.textContent =
      'Server is not configured: add AMBIENT_APPLICATION_KEY and AMBIENT_API_KEY to your .env file and restart.';
  } else if (stateData.lastError) {
    errEl.hidden = false;
    errEl.textContent = stateData.lastError;
  } else {
    errEl.hidden = true;
  }

  const statusEl = el('status');
  const statusText = el('status-text');
  if (stateData.realtimeConnected) {
    statusEl.className = 'status status--live';
    statusText.textContent = 'Live';
  } else if (stateData.configured) {
    statusEl.className = 'status status--down';
    statusText.textContent = 'Reconnecting';
  } else {
    statusEl.className = 'status status--pending';
    statusText.textContent = 'Not configured';
  }

  if (stateData.device) {
    const { name, location } = stateData.device;
    el('station-meta').textContent = location ? `${name} · ${location}` : name;
  }

  const d = stateData.data;
  if (!d) {
    el('hero-temp').textContent = '--';
    return;
  }

  const t = temp(d.tempf);
  el('hero-temp').textContent = t.value;
  el('hero-temp-unit').textContent = t.unit;
  const fl = temp(isNum(d.feelsLike) ? d.feelsLike : d.tempf);
  el('hero-feels').textContent = `${fl.value}${fl.unit}`;

  if (stateData.updatedAt) {
    const dt = new Date(stateData.updatedAt);
    el('hero-updated').textContent = `Updated ${dt.toLocaleTimeString()} · ${dt.toLocaleDateString()}`;
  }

  const container = el('cards');
  container.innerHTML = '';
  for (const c of buildCards(d)) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <div class="card__label">${c.label}</div>
      <div class="card__value">${c.value}<span class="card__unit">${c.unit}</span></div>
      ${c.sub ? `<div class="card__sub">${c.sub}</div>` : ''}`;
    container.appendChild(div);
  }
}

function formatRainDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

let rainfallData = null;

function renderRainfall(data) {
  rainfallData = data;
  const statusEl = el('rainfall-status');
  const body = el('rainfall-body');
  if (!statusEl || !body) return;

  if (data.error) {
    statusEl.textContent = `Error: ${data.error}`;
  } else if (data.loading && (!data.days || data.days.length === 0)) {
    statusEl.textContent = 'Loading last 30 days…';
  } else if (data.updatedAt) {
    const dt = new Date(data.updatedAt);
    statusEl.textContent = `Timezone ${data.timezone} · updated ${dt.toLocaleTimeString()}`;
  } else {
    statusEl.textContent = '';
  }

  if (!data.days || data.days.length === 0) {
    body.innerHTML = `<tr><td colspan="2" class="rainfall-empty">${
      data.loading ? 'Loading history…' : 'No history available'
    }</td></tr>`;
    return;
  }

  const metric = units === 'metric';
  const unitLabel = metric ? 'mm' : 'in';
  const rows = data.days
    .map((d) => {
      const val = metric ? inToMm(d.rainfall_in) : d.rainfall_in;
      const display = d.rainfall_in > 0 ? r(val, 2) : '0';
      const cls = d.rainfall_in > 0 ? 'rainfall-row--wet' : 'rainfall-row--dry';
      return `<tr class="${cls}"><td>${formatRainDate(d.date)}</td><td class="rain-value">${display} ${unitLabel}</td></tr>`;
    })
    .join('');
  body.innerHTML = rows;
}

async function fetchRainfall() {
  try {
    const resp = await fetch('/api/rainfall');
    if (!resp.ok) throw new Error(resp.statusText || `HTTP ${resp.status}`);
    const data = await resp.json();
    renderRainfall(data);
  } catch (err) {
    console.error('Failed to fetch rainfall history', err);
    const body = el('rainfall-body');
    if (body) {
      body.innerHTML = `<tr><td colspan="2" class="rainfall-empty">Failed to load: ${err.message}</td></tr>`;
    }
  }
}

let latest = null;

function setUnits(next) {
  units = next;
  localStorage.setItem('units', units);
  el('unit-imperial').classList.toggle('is-active', units === 'imperial');
  el('unit-metric').classList.toggle('is-active', units === 'metric');
  if (latest) render(latest);
  if (rainfallData) renderRainfall(rainfallData);
}

el('unit-imperial').addEventListener('click', () => setUnits('imperial'));
el('unit-metric').addEventListener('click', () => setUnits('metric'));
setUnits(units);

function connect() {
  const source = new EventSource('/api/stream');
  source.onmessage = (e) => {
    try {
      latest = JSON.parse(e.data);
      render(latest);
    } catch (err) {
      console.error('Bad SSE payload', err);
    }
  };
  source.onerror = () => {
    if (latest) {
      latest.realtimeConnected = false;
      render(latest);
    }
  };
}

connect();
fetchRainfall();
setInterval(fetchRainfall, 30 * 1000);
