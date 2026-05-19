# Kestrel Weather Dashboard

A real-time web dashboard for a Kestrel weather station, fed live by the
[Ambient Weather Network](https://ambientweather.net) API.

A small Node.js server holds your API credentials, maintains a persistent
realtime socket to the Ambient Weather Network, and relays updates to the
browser over Server-Sent Events. Your keys never reach the client.

## Setup

1. **Get your keys** at <https://ambientweather.net> → *Account*:
   - **Application Key** — created under the developer section; identifies
     this app.
   - **API Key** — grants access to your station's data.

   Your Kestrel must already be uploading to the Ambient Weather Network
   (configured in the Kestrel app / via the WeatherFlow/Ambient bridge for
   your model).

2. **Configure credentials:**

   ```bash
   cp .env.example .env
   # edit .env and paste your real Application Key and API Key
   ```

   `.env` is gitignored and never committed.

3. **Install and run:**

   ```bash
   npm install
   npm start
   ```

4. Open <http://localhost:3000>.

## Configuration (`.env`)

| Variable                  | Required | Description                                              |
| ------------------------- | -------- | -------------------------------------------------------- |
| `AMBIENT_APPLICATION_KEY` | yes      | Ambient Weather application key                          |
| `AMBIENT_API_KEY`         | yes      | Ambient Weather API key                                  |
| `AMBIENT_DEVICE_MAC`      | no       | Pin to one station by MAC; blank = first/only station    |
| `PORT`                    | no       | HTTP port (default `3000`)                               |

## How it works

- `server.js` — Express server. Connects to `rt2.ambientweather.net` via
  Socket.IO, subscribes with your API key, and pushes every reading to
  connected browsers through `/api/stream` (SSE). A REST poll every 5
  minutes acts as a safety net if the socket goes quiet.
- `public/` — zero-dependency dashboard: live tiles for temperature, wind,
  humidity, pressure, rain, solar/UV, and more, with an imperial/metric
  toggle and a live-connection indicator.

## Notes

- Update frequency is governed by your Kestrel's reporting interval to the
  Ambient Weather Network.
- The Ambient REST API is rate-limited (~1 request/second); the realtime
  socket carries the live data so polling stays minimal.
