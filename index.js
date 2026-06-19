/**
 * Trustpilot Widget Server — asuntosdigitales.com
 *
 * Variables de entorno (configurar en Railway → Variables):
 *   UPDATE_SECRET   → clave para el endpoint /update manual
 *   GITHUB_TOKEN    → Personal Access Token de GitHub (scope: contents)
 *   GITHUB_USER     → tu usuario de GitHub
 *   GITHUB_REPO     → nombre del repo (ej: trustpilot-widget)
 *   PORT            → Railway lo pone automáticamente, no tocar
 */

const express = require('express');
const cron    = require('node-cron');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.UPDATE_SECRET || 'cambiar-clave';

const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_USER  = process.env.GITHUB_USER  || '';
const GH_REPO  = process.env.GITHUB_REPO  || '';

const DOMAIN         = 'asuntosdigitales.com';
const BASE_TP_URL    = `https://www.trustpilot.com/review/${DOMAIN}`;
const CACHE_FILE     = path.join(__dirname, 'reviews-cache.json');
const PAGES_TO_FETCH = 4;   // 4 páginas × 20 = 80 reseñas candidatas
const MAX_REVIEWS    = 50;  // máximo a guardar (el widget usa solo 9)

// ─── Caché en memoria ────────────────────────────────────────────────────────
let cache = null;

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      console.log(`[cache] ${cache.count} reseñas (${cache.business?.fetchedAt?.slice(0,10)})`);
    }
  } catch { console.warn('[cache] Sin caché previo'); }
}

function saveCache(data) {
  cache = data;
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { console.warn('[cache] No se pudo guardar:', e.message); }
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept-Language': 'es-419,es;q=0.9',
        'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
        ...headers,
      },
    }, res => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location)
        return get(res.headers.location, headers).then(resolve).catch(reject);
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseReview(r) {
  const stars   = typeof r.rating === 'number' ? r.rating : (r.rating?.stars ?? 5);
  const rawDate = r.dates?.publishedDate || r.dates?.experiencedDate || null;
  const date    = rawDate
    ? new Date(rawDate).toLocaleDateString('es-ES', { month: 'short', year: 'numeric' })
    : '';
  const vLevel  = r.labels?.verification?.verificationLevel || '';
  return {
    id:       r.id || '',
    stars,
    title:    r.title || '',
    text:     r.text  || '',
    author:   r.consumer?.displayName || 'Anónimo',
    date,
    verified: ['confirmed', 'invited'].includes(vLevel),
    _ts:      rawDate || '',
  };
}

// ─── Scraper ─────────────────────────────────────────────────────────────────
async function scrapeReviews() {
  console.log(`\n[scraper] Iniciando ${new Date().toISOString()}`);

  // 1. Página 1 → cookies Cloudflare + buildId
  const r1 = await get(`${BASE_TP_URL}?languages=all&page=1`);
  if (r1.status !== 200) throw new Error(`Trustpilot respondió ${r1.status}`);

  const buildMatch = r1.body.match(/"buildId"\s*:\s*"([^"]+)"/);
  if (!buildMatch) throw new Error('buildId no encontrado');
  const buildId = buildMatch[1];

  const cookies = [].concat(r1.headers['set-cookie'] || [])
    .map(c => c.split(';')[0]).join('; ');

  // Metadata del negocio
  let business = { name: DOMAIN, score: 0, stars: 0, totalReviews: 0, url: BASE_TP_URL };
  const ndMatch = r1.body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (ndMatch) {
    const bu = JSON.parse(ndMatch[1])?.props?.pageProps?.businessUnit || {};
    business = {
      name:         bu.displayName  || DOMAIN,
      score:        bu.trustScore   || 0,
      stars:        bu.stars        || 0,
      totalReviews: typeof bu.numberOfReviews === 'number' ? bu.numberOfReviews : (bu.numberOfReviews?.total || 0),
      url:          BASE_TP_URL,
      fetchedAt:    new Date().toISOString(),
    };
  }
  console.log(`[scraper] ${business.name} | Score: ${business.score} | Total: ${business.totalReviews}`);

  // 2. Páginas vía /_next/data/ (usa cookies Cloudflare de paso 1)
  const base = `https://www.trustpilot.com/_next/data/${buildId}/review/${DOMAIN}.json`;
  let allReviews = [], totalPages = 1;

  for (let p = 1; p <= PAGES_TO_FETCH; p++) {
    if (p > 1) await sleep(1200 + Math.random() * 800);
    const url = `${base}?languages=all&page=${p}&businessUnit=${DOMAIN}`;
    const res = await get(url, {
      'x-nextjs-data': '1',
      'Accept':        'application/json',
      'Referer':       `${BASE_TP_URL}?languages=all&page=${p}`,
      ...(cookies ? { 'Cookie': cookies } : {}),
    });
    if (res.status !== 200) { console.warn(`[scraper] Página ${p}: ${res.status}`); break; }

    let json;
    try { json = JSON.parse(res.body); } catch { break; }

    if (p === 1) totalPages = json.pageProps?.filters?.pagination?.totalPages || 1;

    const reviews = (json.pageProps?.reviews || []).map(parseReview);
    allReviews.push(...reviews);
    console.log(`[scraper] Página ${p}/${Math.min(totalPages,PAGES_TO_FETCH)}: ${reviews.length} reseñas | total: ${allReviews.length}`);
    if (!reviews.length || p >= Math.min(totalPages, PAGES_TO_FETCH)) break;
  }

  if (!allReviews.length) throw new Error('Sin reseñas obtenidas');

  const fiveStars = allReviews
    .filter(r => r.stars === 5)
    .sort((a, b) => (b._ts > a._ts ? 1 : -1))
    .slice(0, MAX_REVIEWS)
    .map(({ _ts, ...r }) => r);

  console.log(`[scraper] ✓ ${fiveStars.length} reseñas de 5★`);
  return { business, count: fiveStars.length, reviews: fiveStars };
}

// ─── GitHub Pages push ───────────────────────────────────────────────────────
async function pushToGitHub(content) {
  if (!GH_TOKEN || !GH_USER || !GH_REPO) {
    console.log('[github] Variables no configuradas — solo guardado local');
    return;
  }
  const encoded = Buffer.from(content).toString('base64');
  const apiBase = `https://api.github.com/repos/${GH_USER}/${GH_REPO}/contents/reviews.json`;
  const headers = {
    'Authorization': `token ${GH_TOKEN}`,
    'User-Agent':    'trustpilot-widget-bot',
    'Content-Type':  'application/json',
  };

  // Obtener SHA actual del archivo (necesario para actualizarlo)
  let sha;
  try {
    const getRes = await new Promise((resolve, reject) => {
      https.get(apiBase, { headers }, res => {
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }).on('error', reject);
    });
    if (getRes.status === 200) sha = JSON.parse(getRes.body).sha;
  } catch { /* archivo nuevo, sin SHA */ }

  // PUT para crear o actualizar
  await new Promise((resolve, reject) => {
    const body = JSON.stringify({
      message: `chore: update reviews ${new Date().toISOString().slice(0,10)}`,
      content: encoded,
      ...(sha ? { sha } : {}),
    });
    const req = https.request(apiBase, {
      method: 'PUT',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        if ([200, 201].includes(res.statusCode)) {
          console.log(`[github] ✓ reviews.json publicado en GitHub Pages`);
          resolve();
        } else {
          console.error(`[github] Error ${res.statusCode}: ${b.slice(0,200)}`);
          resolve();
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Tarea completa: scraping + guardado + push ──────────────────────────────
async function runUpdate() {
  const data = await scrapeReviews();
  saveCache(data);
  await pushToGitHub(JSON.stringify(data, null, 2));
  return data;
}

// ─── Express routes ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '2mb' }));

// Widget → GitHub Pages (recomendado)
// Este endpoint es de respaldo; lo normal es que el widget use GitHub Pages directamente
app.get('/reviews.json', (req, res) => {
  if (!cache) return res.status(503).json({ error: 'Iniciando, espera un momento...' });
  res.set('Cache-Control', 'public, max-age=3600, s-maxage=604800');
  res.json(cache);
});

app.get('/health', (req, res) => {
  res.json({
    ok:        true,
    count:     cache?.count || 0,
    updatedAt: cache?.business?.fetchedAt || null,
    github:    GH_USER && GH_REPO ? `https://${GH_USER}.github.io/${GH_REPO}/reviews.json` : 'no configurado',
    nextRun:   'Lunes 7:00 AM (America/Bogota)',
  });
});

// Trigger manual (útil para forzar una actualización)
app.post('/update', async (req, res) => {
  const key = req.headers['x-api-key'] || req.body?.secret;
  if (key !== SECRET) return res.status(401).json({ error: 'Clave inválida' });
  res.json({ ok: true, message: 'Actualización iniciada, revisa /health en 1 minuto' });
  try { await runUpdate(); } catch (e) { console.error('[update] Error:', e.message); }
});

// ─── Cron: cada lunes 7 AM hora Bogotá ───────────────────────────────────────
cron.schedule('0 7 * * 1', async () => {
  console.log('[cron] Actualización semanal...');
  try { await runUpdate(); }
  catch (e) {
    console.error('[cron] Error:', e.message);
    if (cache) console.log('[cron] Manteniendo datos anteriores');
  }
}, { timezone: 'America/Bogota' });

// ─── Arranque ─────────────────────────────────────────────────────────────────
loadCache();
app.listen(PORT, () => {
  console.log(`\n✓ Servidor en puerto ${PORT}`);
  console.log(`  GET  /reviews.json  → JSON para widget (fallback)`);
  console.log(`  GET  /health        → estado y URL de GitHub Pages`);
  console.log(`  POST /update        → forzar actualización\n`);

  if (!cache) {
    console.log('[start] Ejecutando primer scraping...');
    runUpdate()
      .then(d => console.log(`[start] ✓ ${d.count} reseñas obtenidas y publicadas`))
      .catch(e => console.error('[start] Error:', e.message));
  }
});
