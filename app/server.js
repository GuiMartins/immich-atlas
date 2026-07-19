// immich-atlas — storage & library analytics for your Immich server
// Zero-dependency Node.js app (runs on node:22-alpine).
//
// Configuration (either via UI on first run, or environment variables):
//   IMMICH_URL      Immich server URL (e.g. http://192.168.1.10:2283)
//   IMMICH_API_KEY  Immich API key
//   UPLOAD_DIR      Immich upload folder mounted read-only (optional; enables disk usage section)
//   DATA_DIR        Where config + cached report are stored (default /appdata)
//   PORT            HTTP port (default 8080)
//   REFRESH_HOURS   Auto-refresh interval in hours (default 24)

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const VERSION = '0.1.0';
const DATA_DIR = process.env.DATA_DIR || '/appdata';
const PORT = parseInt(process.env.PORT || '8080', 10);
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/upload';
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CACHE_FILE = path.join(DATA_DIR, 'report.json');

// env vars take precedence over the config file
const ENV = {
  url: process.env.IMMICH_URL ? process.env.IMMICH_URL.replace(/\/+$/, '') : null,
  key: process.env.IMMICH_API_KEY || null,
  refreshHours: process.env.REFRESH_HOURS ? parseFloat(process.env.REFRESH_HOURS) : null,
};

let fileConfig = {};
try { fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}

const config = () => ({
  url: ENV.url || fileConfig.immichUrl || null,
  key: ENV.key || fileConfig.apiKey || null,
  refreshHours: ENV.refreshHours || fileConfig.refreshHours || 24,
});
const configured = () => { const c = config(); return !!(c.url && c.key); };

let report = null; // { generatedAt, data }
const status = { running: false, phase: '', detail: '', startedAt: null, lastError: null };

// ---------------- Immich API ----------------
async function apiWith(url, key, p, body) {
  const opts = { headers: { 'x-api-key': key, Accept: 'application/json' } };
  if (body !== undefined) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${url}/api${p}`, opts);
  if (!res.ok) {
    const err = new Error(`Immich API ${p} -> HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
const api = (p, body) => { const c = config(); return apiWith(c.url, c.key, p, body); };

async function* allAssets(extraFilters = {}) {
  let page = 1;
  for (;;) {
    const r = await api('/search/metadata', { page, size: 1000, withExif: true, ...extraFilters });
    for (const a of r.assets.items) yield a;
    if (!r.assets.nextPage) break;
    page = parseInt(r.assets.nextPage, 10);
  }
}

function assetDate(a) {
  const c = (a.exifInfo && a.exifInfo.dateTimeOriginal) || a.localDateTime || a.fileCreatedAt;
  if (!c) return null;
  const d = new Date(c);
  return isNaN(d) ? null : d;
}

function durationSec(a) {
  const d = a.duration;
  if (d == null) return 0;
  if (typeof d === 'string' && d.includes(':')) {
    const m = d.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)/);
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
  }
  const n = Number(d);
  return isFinite(n) ? n / 1000 : 0; // Immich v3+: milliseconds
}

// ---------------- disk ----------------
async function dirStats(dir) {
  let bytes = 0, files = 0;
  async function walk(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        try { const st = await fsp.stat(full); bytes += st.size; files++; } catch {}
      }
    }
  }
  await walk(dir);
  return { bytes, files };
}

// ---------------- collection ----------------
async function collect() {
  const setPhase = (phase, detail = '') => { status.phase = phase; status.detail = detail; };

  setPhase('Querying server');
  const about = await api('/server/about');
  const stats = await api('/server/statistics');
  let storage = null;
  try { storage = await api('/server/storage'); } catch {}

  setPhase('Fetching assets', '0');
  const byExt = new Map(), byCamera = new Map(), byMonth = new Map(), byYear = new Map();
  const videos = [];
  let photoCount = 0, videoCount = 0, photoBytes = 0, videoBytes = 0;
  let favCount = 0, videoSeconds = 0, noDateCount = 0, seen = 0;

  const bump = (map, key, size, isVideo) => {
    let v = map.get(key);
    if (!v) { v = { count: 0, bytes: 0, photos: 0, videos: 0 }; map.set(key, v); }
    v.count++; v.bytes += size;
    if (isVideo) v.videos++; else v.photos++;
  };

  for await (const a of allAssets()) {
    seen++;
    if (seen % 1000 === 0) setPhase('Fetching assets', String(seen));
    const size = (a.exifInfo && a.exifInfo.fileSizeInByte) ? Number(a.exifInfo.fileSizeInByte) : 0;
    const isVideo = a.type === 'VIDEO';
    if (isVideo) { videoCount++; videoBytes += size; } else { photoCount++; photoBytes += size; }
    if (a.isFavorite) favCount++;

    const ext = (path.extname(a.originalFileName || '') || '(no ext)').toLowerCase();
    bump(byExt, ext, size, isVideo);

    if (a.exifInfo && a.exifInfo.model) {
      const make = a.exifInfo.make || '';
      const model = a.exifInfo.model;
      const cam = make && !model.toLowerCase().startsWith(make.toLowerCase()) ? `${make} ${model}` : model;
      bump(byCamera, cam, size, isVideo);
    }

    const dt = assetDate(a);
    if (dt) {
      const mk = dt.toISOString().slice(0, 7);
      bump(byMonth, mk, size, isVideo);
      bump(byYear, mk.slice(0, 4), size, isVideo);
    } else noDateCount++;

    if (isVideo) {
      const dur = durationSec(a);
      videoSeconds += dur;
      videos.push({ name: a.originalFileName, size, durationSec: dur, date: dt ? dt.toISOString() : null });
    }
  }
  const topVideos = videos.sort((a, b) => b.size - a.size).slice(0, 30);

  setPhase('Scanning albums');
  const albums = [];
  try {
    const list = await api('/albums');
    for (let i = 0; i < list.length; i++) {
      const al = list[i];
      setPhase('Scanning albums', `${i + 1}/${list.length}: ${al.albumName}`);
      let bytes = 0, photos = 0, videosN = 0;
      try {
        for await (const a of allAssets({ albumIds: [al.id] })) {
          if (a.exifInfo && a.exifInfo.fileSizeInByte) bytes += Number(a.exifInfo.fileSizeInByte);
          if (a.type === 'VIDEO') videosN++; else photos++;
        }
      } catch {}
      albums.push({ name: al.albumName, count: al.assetCount, photos, videos: videosN, bytes, shared: !!al.shared });
    }
  } catch {}
  albums.sort((a, b) => b.bytes - a.bytes);

  setPhase('Scanning people');
  const people = [];
  let peopleTotal = 0;
  try {
    let pg = 1;
    for (;;) {
      const r = await api(`/people?size=1000&page=${pg}&withHidden=false`);
      for (const p of r.people) people.push(p);
      peopleTotal = r.total;
      if (!r.hasNextPage) break;
      pg++;
    }
  } catch {}
  const personRows = [];
  for (const p of people) {
    let count = 0;
    try { count = (await api(`/people/${p.id}/statistics`)).assets; } catch {}
    personRows.push({ id: p.id, name: p.name || '(unnamed)', count, bytes: -1 });
  }
  personRows.sort((a, b) => b.count - a.count);
  const topN = Math.min(15, personRows.length);
  for (let i = 0; i < topN; i++) {
    const pr = personRows[i];
    setPhase('Sizing people', `${i + 1}/${topN}: ${pr.name}`);
    let bytes = 0;
    try {
      for await (const a of allAssets({ personIds: [pr.id] })) {
        if (a.exifInfo && a.exifInfo.fileSizeInByte) bytes += Number(a.exifInfo.fileSizeInByte);
      }
      pr.bytes = bytes;
    } catch {}
  }

  const diskFolders = [];
  if (fs.existsSync(UPLOAD_DIR)) {
    const folderDefs = [
      ['upload', 'Originals (upload)', 'Original photos and videos'],
      ['library', 'Originals (library)', 'Storage-template library'],
      ['encoded-video', 'Transcoded videos', 'Re-encoded versions for streaming'],
      ['thumbs', 'Thumbnails', 'Generated thumbnails and previews'],
      ['backups', 'Database backups', 'Automatic PostgreSQL dumps'],
      ['profile', 'Profile pictures', 'User avatars'],
    ];
    for (const [key, label, desc] of folderDefs) {
      setPhase('Measuring disk', key);
      const p = path.join(UPLOAD_DIR, key);
      if (fs.existsSync(p)) {
        const st = await dirStats(p);
        diskFolders.push({ key, label, desc, bytes: st.bytes, files: st.files });
      }
    }
    diskFolders.sort((a, b) => b.bytes - a.bytes);
  }

  return {
    server: { url: config().url, version: about.version, atlasVersion: VERSION },
    totals: {
      photoCount, videoCount, photoBytes, videoBytes,
      favCount, videoSeconds, noDateCount,
      albumCount: albums.length, peopleTotal,
    },
    usageByUser: (stats.usageByUser || []).map(u => ({
      name: u.userName, photos: u.photos, videos: u.videos,
      usage: u.usage, quota: u.quotaSizeInBytes,
    })),
    storage,
    byMonth: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({ key: k, ...v })),
    byYear: [...byYear.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({ key: k, ...v })),
    byExt: [...byExt.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.bytes - a.bytes),
    byCamera: [...byCamera.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.count - a.count).slice(0, 15),
    albums,
    people: personRows.slice(0, 25),
    topVideos,
    diskFolders,
  };
}

async function refresh() {
  if (status.running || !configured()) return false;
  status.running = true;
  status.startedAt = new Date().toISOString();
  status.lastError = null;
  try {
    const data = await collect();
    report = { generatedAt: new Date().toISOString(), data };
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(CACHE_FILE, JSON.stringify(report));
    console.log(`[refresh] report generated at ${report.generatedAt}`);
  } catch (e) {
    status.lastError = String((e && e.message) || e);
    console.error('[refresh] error:', e);
  } finally {
    status.running = false;
    status.phase = '';
    status.detail = '';
  }
  return true;
}

// ---------------- http ----------------
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 65536) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);

    } else if (req.method === 'GET' && url.pathname === '/api/report') {
      if (!report) return json(res, 404, { error: 'no report yet' });
      json(res, 200, report);

    } else if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, 200, {
        ...status,
        configured: configured(),
        generatedAt: report ? report.generatedAt : null,
        version: VERSION,
      });

    } else if (req.method === 'GET' && url.pathname === '/api/config') {
      const c = config();
      json(res, 200, {
        immichUrl: c.url,
        apiKeySet: !!c.key,
        refreshHours: c.refreshHours,
        uploadDirMounted: fs.existsSync(UPLOAD_DIR),
        envLocked: { url: !!ENV.url, key: !!ENV.key, refreshHours: !!ENV.refreshHours },
      });

    } else if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = JSON.parse(await readBody(req) || '{}');
      const newUrl = ENV.url || String(body.immichUrl || '').replace(/\/+$/, '');
      const newKey = ENV.key || (body.apiKey ? String(body.apiKey) : (fileConfig.apiKey || ''));
      if (!newUrl || !newKey) return json(res, 400, { error: 'immichUrl and apiKey are required' });
      // validate against the Immich server before saving
      try {
        const about = await apiWith(newUrl, newKey, '/server/about');
        fileConfig = {
          immichUrl: newUrl,
          apiKey: newKey,
          refreshHours: body.refreshHours ? parseFloat(body.refreshHours) : (fileConfig.refreshHours || 24),
        };
        await fsp.mkdir(DATA_DIR, { recursive: true });
        await fsp.writeFile(CONFIG_FILE, JSON.stringify(fileConfig, null, 2));
        json(res, 200, { ok: true, immichVersion: about.version });
        if (!report) refresh();
      } catch (e) {
        let msg;
        if (e && (e.status === 401 || e.status === 403)) {
          msg = 'Invalid API key — check that you copied it correctly and that it has not been revoked.';
        } else if (e && e.status) {
          msg = `Immich server responded with HTTP ${e.status}. Double-check the server URL.`;
        } else {
          msg = `Could not reach ${newUrl} — check the server URL and that Atlas can access it on the network. (${String((e && e.message) || e)})`;
        }
        json(res, 400, { error: msg });
      }

    } else if (req.method === 'POST' && url.pathname === '/api/refresh') {
      if (!configured()) return json(res, 400, { error: 'not configured' });
      const started = !status.running;
      if (started) refresh();
      json(res, 202, { started });

    } else {
      res.writeHead(404); res.end('not found');
    }
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500); res.end('internal error'); }
  }
});

(async () => {
  try { report = JSON.parse(await fsp.readFile(CACHE_FILE, 'utf8')); console.log(`[boot] cache loaded (${report.generatedAt})`); } catch {}
  server.listen(PORT, () => console.log(`[boot] immich-atlas v${VERSION} on http://0.0.0.0:${PORT} — configured: ${configured()}`));
  const age = () => (report ? (Date.now() - new Date(report.generatedAt)) / 3.6e6 : Infinity);
  if (configured() && age() > config().refreshHours) refresh();
  setInterval(() => {
    if (configured() && !status.running && age() > config().refreshHours) refresh();
  }, 15 * 60 * 1000);
})();
