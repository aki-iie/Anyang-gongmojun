const { getFirestore, FieldValue } = require('firebase-admin/firestore');

/* 12문항 슬롯 — prompt.ts 의 SLOT_SPEC 과 동일한 순서.
   CSV 헤더에 사람이 읽는 이름을 쓴다. */
const SLOT_COLUMNS = [
  { id: 'entrance_sill',   label: '현관 턱' },
  { id: 'stair_count',     label: '계단 수' },
  { id: 'water_panel',     label: '물막이판' },
  { id: 'window_base',     label: '창문 높이' },
  { id: 'window_barrier',  label: '창문 차수막' },
  { id: 'backflow_valve',  label: '역류방지밸브' },
  { id: 'rainy_symptom',   label: '우천 시 증상' },
  { id: 'gurgling',        label: '꿀럭 소리' },
  { id: 'floor_backup',    label: '바닥 역류' },
  { id: 'road_slope',      label: '골목 경사' },
  { id: 'drain_status',    label: '빗물받이' },
  { id: 'canopy',          label: '현관 차양' },
];

function formatFloodStatus(status) {
  if (status === 'flooded') return '침수 발생';
  if (status === 'safe') return '이상 없음';
  return '미확인';
}

async function exportDiagnoses(password, format) {
  if (!password || password !== process.env.ADMIN_SECRET) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }

  const db = getFirestore();
  const snapshot = await db.collection('diagnoses').orderBy('createdAt', 'desc').get();
  
  const docs = snapshot.docs.map(d => {
    const data = d.data();
    const slots = data.slots || {};
    const row = {
      id: d.id,
      ticket: data.ticket || '',
      dong: data.dong || '',
      address: (data.location && data.location.address) || '',
      actualFlooded: data.actualFlooded || 'unconfirmed',
      floodNote: data.floodNote || '',
      createdAt: data.createdAt ? data.createdAt.toDate().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '',
    };
    /* 12문항 응답을 개별 키로 펼친다 */
    for (const col of SLOT_COLUMNS) {
      row[col.id] = slots[col.id] || '';
    }
    return row;
  });

  if (format === 'csv') {
    const yearColumns = ['2026년 침수', '2027년 침수', '2028년 침수', '2029년 침수', '2030년 침수'];
    const header = [
      '접수번호', '행정동', '주소', '접수일시',
      ...SLOT_COLUMNS.map(c => c.label),
      '실제침수여부', '침수메모',
      ...yearColumns
    ].join(',');
    const rows = docs.map(d => {
      const slotValues = SLOT_COLUMNS.map(c => {
        let val = String(d[c.id] || '');
        // 엑셀에서 '1-2'나 '3-4'가 '1월 2일' 등 날짜로 자동 변환되는 것을 막기 위해 '~'로 치환
        if (/^\d+-\d+$/.test(val)) {
          val = val.replace('-', '~');
        }
        return val;
      });
      const cells = [
        d.ticket, d.dong, d.address, d.createdAt,
        ...slotValues,
        formatFloodStatus(d.actualFlooded), d.floodNote,
        ...yearColumns.map(() => '') // 연도별 빈 열 추가
      ];
      return cells.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });
    return { type: 'csv', data: '\uFEFF' + header + '\n' + rows.join('\n') };
  }
  
  return { type: 'json', data: docs };
}

async function updateDiagnosisFloodStatus(password, { id, actualFlooded, floodNote }) {
  if (!password || password !== process.env.ADMIN_SECRET) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }

  if (!id) {
    const err = new Error('ID is required');
    err.status = 400;
    throw err;
  }

  const validStatuses = ['unconfirmed', 'flooded', 'safe'];
  const status = validStatuses.includes(actualFlooded) ? actualFlooded : 'unconfirmed';

  const db = getFirestore();
  const docRef = db.collection('diagnoses').doc(id);
  
  const updateData = {
    actualFlooded: status,
    floodedUpdatedAt: FieldValue.serverTimestamp(),
  };
  if (floodNote !== undefined) {
    updateData.floodNote = String(floodNote);
  }

  await docRef.update(updateData);

  return { success: true, id, actualFlooded: status };
}

module.exports = { exportDiagnoses, updateDiagnosisFloodStatus };
