/* 잠길까 — LLM 프록시
   브라우저에 API 키를 두지 않기 위한 최소 패스스루.
   클라이언트는 OpenAI 형식 body를 그대로 보내고, 이 함수가 서버에서 키를 붙여 대신 호출한다. */

const { onRequest } = require('firebase-functions/v2/https');
const { classify, inCoverage, shapesNear } = require('./flood');
const { geocode } = require('./geocode');

/* 허용 모델 화이트리스트 — 열린 프록시가 되어 임의 모델을 태우지 못하게 막는다. */
const ALLOWED_MODELS = new Set(['gpt-4o-mini', 'openai/gpt-4o-mini']);

const isOpenRouter = (key) => key.startsWith('sk-or-');
const endpointFor = (key) =>
  isOpenRouter(key)
    ? 'https://openrouter.ai/api/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';
const modelFor = (key) => (isOpenRouter(key) ? 'openai/gpt-4o-mini' : 'gpt-4o-mini');

/* 자기 사이트에서만 부르게 한다. origin 없는 요청(서버간 호출)은 통과. */
const ALLOWED_ORIGINS = [
  'https://jamgilkka.web.app',
  'https://jamgilkka.firebaseapp.com',
  'http://localhost:5173',
  'http://localhost:5200',
];

exports.llm = onRequest(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 120, maxInstances: 10, cors: ALLOWED_ORIGINS },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      res.status(403).json({ error: 'origin not allowed' });
      return;
    }

    const key = process.env.OPENAI_API_KEY;
    if (!key || key.startsWith('your_')) {
      console.error('OPENAI_API_KEY 가 설정되지 않았습니다.');
      res.status(500).json({ error: 'server key not configured' });
      return;
    }

    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || messages.length === 0 || messages.length > 40) {
      res.status(400).json({ error: 'invalid messages' });
      return;
    }
    if (body.model && !ALLOWED_MODELS.has(body.model)) {
      res.status(400).json({ error: 'model not allowed' });
      return;
    }

    const payload = {
      model: modelFor(key),
      messages,
      temperature: typeof body.temperature === 'number' ? body.temperature : 0.4,
      max_tokens: 1200,
    };
    if (body.response_format) payload.response_format = body.response_format;

    try {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
      if (isOpenRouter(key)) {
        headers['HTTP-Referer'] = 'https://jamgilkka.web.app';
        headers['X-Title'] = 'Jamgilkka';
      }
      const upstream = await fetch(endpointFor(key), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const text = await upstream.text();
      if (!upstream.ok) console.error('upstream error:', upstream.status, text.slice(0, 500));
      res.status(upstream.status).type('application/json').send(text);
    } catch (err) {
      console.error('proxy exception:', err);
      res.status(502).json({ error: 'upstream failed' });
    }
  }
);


/* ────────────────────────────────────────────────────────────
   침수지도 조회 — 위경도 → 30년 빈도 예상 침수 등급 + 배점
   GET/POST /api/flood?lat=37.3943&lon=126.9568
   ──────────────────────────────────────────────────────────── */
exports.flood = onRequest(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 30, maxInstances: 10, cors: ALLOWED_ORIGINS },
  (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      res.status(403).json({ error: 'origin not allowed' });
      return;
    }

    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const lat = Number(src.lat);
    const lon = Number(src.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      res.status(400).json({ error: 'lat/lon required' });
      return;
    }

    if (!inCoverage(lon, lat)) {
      res.json({
        covered: false, inMap: false, seg: null, pts: 0,
        label: '안양시 밖으로 보여요. 도시침수지도는 안양시 만안구·동안구만 담고 있습니다',
        lat, lon,
        source: '안양시 도시침수지도 30년·50년 빈도',
      });
      return;
    }

    /* 30년·50년 두 빈도를 모두 판정한다.
       점수는 보수적으로 50년(더 넓은 쪽) 기준을 쓴다. */
    const r30 = classify(lon, lat, '030');
    const r50 = classify(lon, lat, '050');
    const main = r50.inMap ? r50 : r30;

    /* shape=1 이면 지도에 그릴 주변 폴리곤도 함께 보낸다 (반경 최대 1km) */
    let shapes;
    if (String(src.shape) === '1') {
      const radius = Math.min(1000, Math.max(150, Number(src.radius) || 500));
      shapes = { freq30: shapesNear(lon, lat, '030', radius), freq50: shapesNear(lon, lat, '050', radius), radius };
    }

    res.json({
      covered: true,
      inMap: main.inMap,
      seg: main.seg,
      pts: main.pts,
      label: main.label,
      matched: main.matched,
      freq30: { inMap: r30.inMap, seg: r30.seg, pts: r30.pts, label: r30.label },
      freq50: { inMap: r50.inMap, seg: r50.seg, pts: r50.pts, label: r50.label },
      source: '안양시 도시침수지도 30년·50년 빈도',
      lat, lon,
      ...(shapes ? { shapes } : {}),
    });
  }
);


/* ────────────────────────────────────────────────────────────
   주소 → 좌표
   GET /api/geocode?address=경기도 안양시 동안구 시민대로 235
   ──────────────────────────────────────────────────────────── */
/* 서울 리전에서 돈다 — VWorld 지오코더가 해외 IP 연결을 끊는다(UND_ERR_SOCKET).
   국내 리전이면 정상 응답하고, 한국 사용자 지연도 줄어든다. */
exports.geocode = onRequest(
  { region: 'asia-northeast3', memory: '256MiB', timeoutSeconds: 20, maxInstances: 10, cors: ALLOWED_ORIGINS },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) { res.status(403).json({ error: 'origin not allowed' }); return; }

    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const address = String(src.address || '').trim();
    if (!address) { res.status(400).json({ error: 'address required' }); return; }

    try {
      const r = await geocode(address);
      if (!r) { res.json({ found: false, address }); return; }
      res.json({ found: true, ...r });
    } catch (err) {
      console.error('geocode 실패:', err);
      res.status(502).json({ error: 'geocode failed' });
    }
  }
);
