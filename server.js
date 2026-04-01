const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const NASA_API_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';

// Simple in-memory cache
const cache = {};
function getCached(key, ttlMs = 300000) {
  const e = cache[key];
  if (e && Date.now() - e.ts < ttlMs) return e.data;
  return null;
}
function setCache(key, data) { cache[key] = { data, ts: Date.now() }; }

function proxyFetch(targetUrl, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, { timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Try multiple URLs in order, return first success
async function tryUrls(urls) {
  for (const u of urls) {
    try {
      const r = await proxyFetch(u);
      if (r.status === 200) return r;
      console.log(`  [${r.status}] ${u.substring(0, 70)}`);
    } catch (e) {
      console.log(`  [ERR] ${u.substring(0, 70)}: ${e.message}`);
    }
  }
  return null;
}

// ─── ROUTE HANDLERS ───

async function handleLaunch(pathname) {
  const cached = getCached('launch', 30000); // 30s cache — launch status changes fast
  if (cached) { console.log('[CACHE] launch'); return { status: 200, data: cached }; }

  // Try multiple LL2 endpoints
  const search = pathname.includes('upcoming') ? 'upcoming/' : pathname.includes('previous') ? 'previous/' : '';
  const urls = [
    `https://ll.thespacedevs.com/2.3.0/launches/${search}?search=artemis+ii&limit=5&mode=detailed`,
    `https://ll.thespacedevs.com/2.3.0/launches/${search}?search=artemis+ii&limit=5`,
    `https://ll.thespacedevs.com/2.3.0/launches/${search}?search=artemis&limit=10`,
    `https://lldev.thespacedevs.com/2.3.0/launches/${search}?search=artemis+ii&limit=5`,
  ];

  console.log(`[PROXY] ${pathname} -> LL2 (trying ${urls.length} endpoints)`);
  const r = await tryUrls(urls);
  if (r) { setCache('launch', r.data); return { status: 200, data: r.data }; }
  return { status: 502, data: JSON.stringify({ error: 'All LL2 endpoints unavailable', count: 0, results: [] }) };
}

async function handleApod() {
  const cached = getCached('apod', 3600000); // 1 hour cache
  if (cached) { console.log('[CACHE] apod'); return { status: 200, data: cached }; }

  console.log('[PROXY] /api/apod -> NASA APOD');
  const r = await tryUrls([`https://api.nasa.gov/planetary/apod?api_key=${NASA_API_KEY}`]);
  if (r) { setCache('apod', r.data); return { status: 200, data: r.data }; }
  return { status: 502, data: JSON.stringify({ error: 'APOD unavailable (rate limit?)' }) };
}

async function handleNeo(query) {
  const params = new URLSearchParams(query);
  const startDate = params.get('start_date') || new Date().toISOString().split('T')[0];
  const endDate = params.get('end_date') || startDate;
  const cacheKey = `neo_${startDate}`;

  const cached = getCached(cacheKey, 3600000);
  if (cached) { console.log('[CACHE] neo'); return { status: 200, data: cached }; }

  console.log('[PROXY] /api/neo -> NASA NeoWs');
  const r = await tryUrls([`https://api.nasa.gov/neo/rest/v1/feed?start_date=${startDate}&end_date=${endDate}&api_key=${NASA_API_KEY}`]);
  if (r) { setCache(cacheKey, r.data); return { status: 200, data: r.data }; }
  return { status: 502, data: JSON.stringify({ error: 'NeoWs unavailable' }) };
}

async function handleDonki(type) {
  const cached = getCached(`donki_${type}`, 600000);
  if (cached) { console.log(`[CACHE] donki/${type}`); return { status: 200, data: cached }; }

  const end = new Date().toISOString().split('T')[0];
  const start = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const endpoint = type === 'cme' ? 'CME' : 'FLR';

  console.log(`[PROXY] /api/donki/${type} -> DONKI ${endpoint}`);
  const r = await tryUrls([`https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/${endpoint}?startDate=${start}&endDate=${end}`]);
  if (r) { setCache(`donki_${type}`, r.data); return { status: 200, data: r.data }; }
  return { status: 502, data: JSON.stringify([]) };
}

async function handleHorizons() {
  const cached = getCached('horizons', 3600000);
  if (cached) { console.log('[CACHE] horizons'); return { status: 200, data: cached }; }

  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const url = `https://ssd.jpl.nasa.gov/api/horizons.api?format=json&COMMAND='301'&OBJ_DATA='NO'&MAKE_EPHEM='YES'&EPHEM_TYPE='OBSERVER'&CENTER='500@399'&START_TIME='${today}'&STOP_TIME='${tomorrow}'&STEP_SIZE='1 h'&QUANTITIES='4,20'`;

  console.log('[PROXY] /api/horizons -> JPL Horizons');
  const r = await tryUrls([url]);
  if (r) { setCache('horizons', r.data); return { status: 200, data: r.data }; }
  return { status: 502, data: JSON.stringify({ error: 'Horizons unavailable' }) };
}

// Live Orion telemetry from JPL Horizons (spacecraft -1024)
async function handleOrionTelemetry() {
  const cached = getCached('orion', 30000); // 30s cache
  if (cached) { console.log('[CACHE] orion'); return { status: 200, data: cached }; }

  // Query latest available position
  // JPL uploads trajectory solutions with a delay — start time shifts as new data arrives
  const now = new Date();
  const fmt = d => d.toISOString().replace('T',' ').substring(0, 19);

  // Try querying around "now" first, then progressively earlier windows
  // This handles both the case where data is near-real-time and where it's delayed
  const windows = [];
  // Window 1: latest 20 minutes
  windows.push([new Date(now.getTime() - 1200000), new Date(now.getTime() + 60000)]);
  // Window 2: 1-2 hours ago
  windows.push([new Date(now.getTime() - 7200000), new Date(now.getTime() - 3600000)]);
  // Window 3: 2-4 hours ago
  windows.push([new Date(now.getTime() - 14400000), new Date(now.getTime() - 7200000)]);
  // Window 4: from known earliest possible start
  windows.push([new Date('2026-04-02T02:00:00Z'), new Date('2026-04-02T03:00:00Z')]);

  console.log('[PROXY] /api/orion -> JPL Horizons (Artemis II spacecraft -1024)');

  try {
    let result = '';
    // Try each time window until we get data
    for (const [wStart, wEnd] of windows) {
      const url = `https://ssd.jpl.nasa.gov/api/horizons.api?format=json`
        + `&COMMAND='-1024'&OBJ_DATA='NO'&MAKE_EPHEM='YES'`
        + `&EPHEM_TYPE='VECTORS'&CENTER='500@399'`
        + `&START_TIME='${fmt(wStart)}'&STOP_TIME='${fmt(wEnd)}'&STEP_SIZE='1 m'`;

      console.log(`  trying window: ${fmt(wStart)} -> ${fmt(wEnd)}`);
      const r = await proxyFetch(url);
      if (r.status !== 200) {
        console.log(`  [${r.status}] Horizons`);
        continue;
      }
      const raw = JSON.parse(r.data);
      if (raw.error && raw.error.includes('No ephemeris')) {
        console.log(`  no data in this window`);
        continue;
      }
      result = raw.result || '';
      if (result.includes('$$SOE')) {
        console.log(`  found data in window ${fmt(wStart)}`);
        break;
      }
    }

    if (!result || !result.includes('$$SOE')) {
      return { status: 404, data: JSON.stringify({ error: 'No ephemeris data available yet — JPL may still be uploading trajectory solutions' }) };
    }

    // Parse the latest vector data
    const lines = result.split('\n');
    let inData = false;
    let latest = null;

    for (const line of lines) {
      if (line.includes('$$SOE')) { inData = true; continue; }
      if (line.includes('$$EOE')) break;
      if (!inData) continue;

      // Date line: "2461132.583... = A.D. 2026-Apr-02 02:00:00.0000 TDB"
      const dateMatch = line.match(/A\.D\.\s+(\S+\s+\S+)/);
      if (dateMatch) {
        latest = { timestamp: dateMatch[1] };
        continue;
      }

      if (!latest) continue;

      // Position: " X = ... Y = ... Z = ..."
      const posMatch = line.match(/X\s*=\s*([-\dE.+]+)\s+Y\s*=\s*([-\dE.+]+)\s+Z\s*=\s*([-\dE.+]+)/);
      if (posMatch) {
        latest.x = parseFloat(posMatch[1]);
        latest.y = parseFloat(posMatch[2]);
        latest.z = parseFloat(posMatch[3]);
        continue;
      }

      // Velocity: " VX= ... VY= ... VZ= ..."
      const velMatch = line.match(/VX\s*=\s*([-\dE.+]+)\s+VY\s*=\s*([-\dE.+]+)\s+VZ\s*=\s*([-\dE.+]+)/);
      if (velMatch) {
        latest.vx = parseFloat(velMatch[1]);
        latest.vy = parseFloat(velMatch[2]);
        latest.vz = parseFloat(velMatch[3]);
        continue;
      }

      // Range/range-rate: " LT= ... RG= ... RR= ..."
      const rrMatch = line.match(/LT\s*=\s*([-\dE.+]+)\s+RG\s*=\s*([-\dE.+]+)\s+RR\s*=\s*([-\dE.+]+)/);
      if (rrMatch) {
        latest.lightTime = parseFloat(rrMatch[1]);
        latest.range = parseFloat(rrMatch[2]);     // km from Earth center
        latest.rangeRate = parseFloat(rrMatch[3]);  // km/s
      }
    }

    if (latest && latest.x !== undefined) {
      // Compute derived values
      const earthRadius = 6371; // km
      const speed = Math.sqrt(latest.vx**2 + latest.vy**2 + latest.vz**2); // km/s
      const distFromCenter = Math.sqrt(latest.x**2 + latest.y**2 + latest.z**2);
      const altitude = distFromCenter - earthRadius;

      // Moon distance (approximate — Moon is ~384400 km from Earth)
      const moonDist = 384400 - distFromCenter; // rough approximation

      const telemetry = {
        source: 'JPL Horizons (live)',
        spacecraft: 'Artemis II / Orion MPCV',
        horizonsId: -1024,
        timestamp: latest.timestamp,
        position: { x: latest.x, y: latest.y, z: latest.z, unit: 'km' },
        velocity: { vx: latest.vx, vy: latest.vy, vz: latest.vz, unit: 'km/s' },
        altitude_km: Math.round(altitude),
        speed_km_s: Math.round(speed * 1000) / 1000,
        speed_m_s: Math.round(speed * 1000),
        range_from_earth_km: Math.round(distFromCenter),
        range_from_moon_km: Math.round(Math.abs(moonDist)),
        range_rate_km_s: latest.rangeRate,
      };

      const out = JSON.stringify(telemetry);
      setCache('orion', out);
      console.log(`  [OK] ALT: ${telemetry.altitude_km} km | VEL: ${telemetry.speed_m_s} m/s | RANGE: ${telemetry.range_from_earth_km} km`);
      return { status: 200, data: out };
    }

    return { status: 404, data: JSON.stringify({ error: 'No ephemeris data available yet', raw: result.substring(0, 500) }) };
  } catch (err) {
    console.error(`  [ERR] orion: ${err.message}`);
    return { status: 502, data: JSON.stringify({ error: err.message }) };
  }
}

// ─── STATIC FILE SERVING ───
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  let pathname, query;
  try {
    const parsed = new URL(req.url, `http://localhost:${PORT}`);
    pathname = parsed.pathname;
    query = parsed.search ? parsed.search.substring(1) : '';
  } catch {
    // Fallback URL parsing for older Node versions
    const qIdx = req.url.indexOf('?');
    pathname = qIdx >= 0 ? req.url.substring(0, qIdx) : req.url;
    query = qIdx >= 0 ? req.url.substring(qIdx + 1) : '';
  }

  console.log(`[${req.method}] ${pathname}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  // API routes
  if (pathname.startsWith('/api/')) {
    let result;
    try {
      if (pathname.startsWith('/api/launch')) result = await handleLaunch(pathname);
      else if (pathname === '/api/apod') result = await handleApod();
      else if (pathname === '/api/neo') result = await handleNeo(query);
      else if (pathname === '/api/donki/cme') result = await handleDonki('cme');
      else if (pathname === '/api/donki/flr') result = await handleDonki('flr');
      else if (pathname === '/api/horizons') result = await handleHorizons();
      else if (pathname === '/api/orion') result = await handleOrionTelemetry();
      else { res.writeHead(404); res.end(JSON.stringify({ error: 'unknown route', pathname })); return; }
    } catch (err) {
      console.error(`[ERROR] ${pathname}: ${err.message}`);
      res.writeHead(502);
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.data);
    return;
  }

  // Static files
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  try {
    if (!fs.existsSync(filePath)) {
      console.log(`[404] File not found: ${filePath}`);
      res.writeHead(404); res.end('Not found');
      return;
    }
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    console.error(`[ERR] Static file: ${err.message}`);
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║  ARTEMIS II MISSION CONTROL DASHBOARD        ║`);
  console.log(`  ║  http://localhost:${PORT}                        ║`);
  console.log(`  ║  API proxy active — no CORS issues            ║`);
  console.log(`  ╚══════════════════════════════════════════════╝\n`);
  console.log(`  Live API Feeds:`);
  console.log(`    /api/launch      Launch Library 2 (status + NET)`);
  console.log(`    /api/apod        NASA Astronomy Photo of the Day`);
  console.log(`    /api/neo         NASA Near-Earth Object tracking`);
  console.log(`    /api/donki/cme   DONKI Coronal Mass Ejections`);
  console.log(`    /api/donki/flr   DONKI Solar Flare alerts`);
  console.log(`    /api/horizons    JPL Horizons Moon ephemeris
    /api/orion       JPL Horizons Artemis II LIVE telemetry (-1024)`);
  console.log(`\n  API Key: ${NASA_API_KEY === 'DEMO_KEY' ? 'DEMO_KEY (set NASA_API_KEY for higher limits)' : 'custom key'}\n`);
});
