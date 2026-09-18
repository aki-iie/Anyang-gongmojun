/* 잠길까 — LLM 프록시
   브라우저에 API 키를 두지 않기 위한 최소 패스스루.
   클라이언트는 OpenAI 형식 body를 그대로 보내고, 이 함수가 서버에서 키를 붙여 대신 호출한다. */

const { onRequest } = require('firebase-functions/v2/https');
const { classify, inCoverage, shapesNear, classifyTrace, tracesNear, mergeDepth } = require('./flood');
const { geocode } = require('./geocode');
const { dongOf } = require('./dong');
const { saveDiagnosis, saveStats, BadRequest } = require('./save');
const { initializeApp, getApps } = require('firebase-admin/app');

/* Firestore 쓰기용. 함수 인스턴스당 한 번만 초기화한다. */
if (getApps().length === 0) initializeApp();

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
   침수심 조회 — 위경도 → 판정 엔진에 넣을 침수심(cm)
     채널 A 도시침수지도(예측)  50년 빈도 등급 → 대표 침수심
     채널 B 침수흔적도(실측)    2022년 등 실제로 잠겼던 깊이
   판정용 depthCm 은 둘 중 큰 값이다. 판정 자체는 프론트의 diagnose() 가 한다.
   두 채널은 일치하지 않는다. 석수동 충훈부는 A 에서 빠져 있지만 B 에 5건이 남아 있다.
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
      /* depthCm 이 null 이면 판정 엔진이 경로 A 를 "확인필요"로 둔다 — 모르는 곳을 0cm 로 속이지 않는다 */
      res.json({
        covered: false, inMap: false, seg: null, dong: null,
        predCm: null, traceCm: null, depthCm: null, basis: 'none',
        label: '안양시 밖으로 보여요. 침수지도는 안양시 만안구·동안구만 담고 있습니다',
        lat, lon,
        source: '안양시 도시침수지도 30년·50년 빈도 · 침수흔적도',
      });
      return;
    }

    /* 30년·50년 두 빈도를 모두 판정한다.
       판정은 보수적으로 50년(더 넓고 깊은 쪽) 기준을 쓰고, 화면에는 두 빈도를 함께 보여준다. */
    const r30 = classify(lon, lat, '030');
    const r50 = classify(lon, lat, '050');
    const main = r50.inMap ? r50 : r30;

    /* 채널 B — 실제 침수 기록 */
    const tr = classifyTrace(lon, lat);
    const { depthCm, basis } = mergeDepth(main.depthCm, tr.depthCm);

    /* shape=1 이면 지도에 그릴 주변 폴리곤도 함께 보낸다 (반경 최대 1km) */
    let shapes;
    if (String(src.shape) === '1') {
      const radius = Math.min(1000, Math.max(150, Number(src.radius) || 500));
      shapes = {
        freq30: shapesNear(lon, lat, '030', radius),
        freq50: shapesNear(lon, lat, '050', radius),
        trace: tracesNear(lon, lat, radius),
        radius,
      };
    }

    res.json({
      covered: true,
      inMap: main.inMap,
      seg: main.seg,
      /* 행정동 — 좌표로 바로 판정한다. 지오코더를 한 번 더 부르지 않아도 되고
         GPS 로 들어온 사용자(주소 없음)도 똑같이 채워진다. */
      dong: dongOf(lon, lat),
      predCm: main.depthCm,        // 채널 A 예측 (구역 밖이면 0)
      traceCm: tr.depthCm,         // 채널 B 실측 (기록 없으면 null)
      depthCm,                     // 판정용 = max(예측, 실측)
      basis,
      label: main.label,
      matched: main.matched,
      freq30: { inMap: r30.inMap, seg: r30.seg, depthCm: r30.depthCm, label: r30.label },
      freq50: { inMap: r50.inMap, seg: r50.seg, depthCm: r50.depthCm, label: r50.label },
      trace: tr,
      source: '안양시 도시침수지도 30년·50년 빈도 · 침수흔적도(2022년 등)',
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


/* ────────────────────────────────────────────────────────────
   지원 접수 저장 — 진단 결과를 Firestore(diagnoses)에 기록하고 접수번호를 돌려준다.
   저장 조건 검증은 save.js 가 한다(위험 판정 + 동의 2건 + 좌표 범위).
   사진은 받지 않는다 — 슬롯 답변과 판정 결과 텍스트만.
   Firestore 가 asia-northeast3 에 있어 같은 리전에서 돈다.
   POST /api/save
   ──────────────────────────────────────────────────────────── */
exports.save = onRequest(
  { region: 'asia-northeast3', memory: '256MiB', timeoutSeconds: 20, maxInstances: 10, cors: ALLOWED_ORIGINS },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) { res.status(403).json({ error: 'origin not allowed' }); return; }

    try {
      const { ticket, id } = await saveDiagnosis(req.body || {});
      console.log('접수 저장:', id, ticket);
      res.status(201).json({ saved: true, ticket });
    } catch (err) {
      /* 검증 실패는 사용자에게 보여줄 수 있는 문장이므로 그대로 내려보낸다. */
      if (err instanceof BadRequest) { res.status(400).json({ error: err.message }); return; }
      console.error('접수 저장 실패:', err);
      res.status(500).json({ error: '접수를 저장하지 못했습니다' });
    }
  }
);


/* ────────────────────────────────────────────────────────────
   통계 기록 — 진단을 끝낸 모든 건을 익명으로 남긴다(동의 불필요).
   주소도 정확한 좌표도 받지 않고 넘어온 좌표는 100m 격자로 바꿔 저장한다.
   접수(diagnoses)와 목적·보관 내용이 다르므로 컬렉션을 분리했다 — docs/schema.md 참고.
   POST /api/stats
   ──────────────────────────────────────────────────────────── */
exports.stats = onRequest(
  { region: 'asia-northeast3', memory: '256MiB', timeoutSeconds: 20, maxInstances: 10, cors: ALLOWED_ORIGINS },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) { res.status(403).json({ error: 'origin not allowed' }); return; }

    try {
      const { level } = await saveStats(req.body || {});
      res.status(201).json({ recorded: true, level });
    } catch (err) {
      if (err instanceof BadRequest) { res.status(400).json({ error: err.message }); return; }
      /* 통계 실패가 사용자 화면을 막으면 안 된다. 로그만 남기고 조용히 끝낸다. */
      console.error('통계 기록 실패:', err);
      res.status(500).json({ error: '통계를 기록하지 못했습니다' });
    }
  }
);


/* ────────────────────────────────────────────────────────────
   어드민 수출 API — 접수된 모든 진단을 JSON이나 CSV로 반환한다.
   관리자 비밀번호가 있어야만 작동한다.
   GET /api/admin/export?password=...&format=csv
   ──────────────────────────────────────────────────────────── */
const { exportDiagnoses, updateDiagnosisFloodStatus } = require('./admin');

exports.adminExport = onRequest(
  { region: 'asia-northeast3', memory: '256MiB', timeoutSeconds: 30, maxInstances: 5, cors: ALLOWED_ORIGINS },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }

    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) { res.status(403).json({ error: 'origin not allowed' }); return; }

    try {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      const result = await exportDiagnoses(req.query.password, req.query.format);
      if (result.type === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="diagnoses.csv"');
        res.status(200).send(result.data);
      } else {
        res.status(200).json(result.data);
      }
    } catch (err) {
      if (err.status === 401) {
        res.status(401).json({ error: 'Unauthorized' });
      } else {
        console.error('어드민 내보내기 실패:', err);
        res.status(500).json({ error: '어드민 내보내기 중 오류가 발생했습니다' });
      }
    }
  }
);

/* ────────────────────────────────────────────────────────────
   어드민 침수 여부 수정 API — 공무원이 실제 침수 여부를 갱신한다.
   POST /api/admin/update
   Body: { password: "...", id: "...", actualFlooded: "flooded"|"safe"|"unconfirmed", floodNote: "..." }
   ──────────────────────────────────────────────────────────── */
exports.adminUpdate = onRequest(
  { region: 'asia-northeast3', memory: '256MiB', timeoutSeconds: 30, maxInstances: 5, cors: ALLOWED_ORIGINS },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) { res.status(403).json({ error: 'origin not allowed' }); return; }

    try {
      const { password, id, actualFlooded, floodNote } = req.body || {};
      const result = await updateDiagnosisFloodStatus(password, { id, actualFlooded, floodNote });
      res.status(200).json(result);
    } catch (err) {
      if (err.status === 401) {
        res.status(401).json({ error: 'Unauthorized' });
      } else if (err.status === 400) {
        res.status(400).json({ error: err.message });
      } else {
        console.error('침수 상태 업데이트 실패:', err);
        res.status(500).json({ error: '업데이트 중 오류가 발생했습니다' });
      }
    }
  }
);
