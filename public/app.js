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

let latest = null;

function setUnits(next) {
  units = next;
  localStorage.setItem('units', units);
  el('unit-imperial').classList.toggle('is-active', units === 'imperial');
  el('unit-metric').classList.toggle('is-active', units === 'metric');
  if (latest) render(latest);
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
    // EventSource auto-reconnects; reflect the gap in the UI meanwhile.
    if (latest) {
      latest.realtimeConnected = false;
      render(latest);
    }
  };
}

connect();
