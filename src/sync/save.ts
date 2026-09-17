/* 지원 접수 — 진단 결과를 서버(/api/save)로 보내 Firestore 에 남기고 접수번호를 받는다.
   사진은 보내지 않는다. 슬롯 답변과 판정 결과 텍스트, 좌표·주소만 보낸다.
   저장 여부는 서버가 다시 판단한다(위험 판정 + 동의 2건 + 좌표 범위) — functions/save.js 참고. */

import type { FloodResult } from './flood';
import type { Slots, DiagnoseResult } from '../utils/diagnose';

export type SavePayload = {
  location: { lat: number; lon: number; address: string | null; detail: string | null };
  flood: Pick<FloodResult, 'covered' | 'inMap' | 'seg' | 'predCm' | 'traceCm' | 'depthCm' | 'basis'> | null;
  slots: Partial<Slots>;
  diagnosis: {
    surface: DiagnoseResult['surface'];
    backflow: Omit<DiagnoseResult['backflow'], 'unknownItems' | 'signalCount'>;
    warnings: string[];
    quality: DiagnoseResult['quality'];
  };
  consent: { provide: true; priority: true };
};

/** 접수 실패 사유를 화면에 그대로 보여주기 위해 메시지를 담아 던진다. */
export class SaveError extends Error {}

export async function saveDiagnosis(payload: SavePayload): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('[Save] 네트워크 오류:', err);
    throw new SaveError('네트워크 연결을 확인해 주세요.');
  }

  let data: { saved?: boolean; ticket?: string; error?: string } = {};
  try { data = await res.json(); } catch { /* 본문이 비어 있을 수 있다 */ }

  if (!res.ok || !data.ticket) {
    console.error('[Save] 실패:', res.status, data);
    throw new SaveError(data.error || '접수를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
  return data.ticket;
}

/** 화면 상태에서 전송할 형태를 만든다. 좌표가 없으면 접수할 수 없으므로 null. */
export function buildPayload(args: {
  lat: number | null;
  lon: number | null;
  address: string;
  detail: string;
  flood: FloodResult | null;
  slots: Partial<Slots>;
  dx: DiagnoseResult;
}): SavePayload | null {
  const { lat, lon, address, detail, flood, slots, dx } = args;
  if (lat === null || lon === null) return null;

  return {
    location: {
      lat, lon,
      address: address.trim() || null,
      detail: detail.trim() || null,
    },
    flood: flood
      ? {
          covered: flood.covered, inMap: flood.inMap, seg: flood.seg,
          predCm: flood.predCm, traceCm: flood.traceCm, depthCm: flood.depthCm,
          basis: flood.basis,
        }
      : null,
    slots,
    diagnosis: {
      surface: dx.surface,
      /* unknownItems 는 화면 안내용이라 저장하지 않는다 */
      backflow: {
        status: dx.backflow.status,
        signals: dx.backflow.signals,
        /* signalCount 는 보내지 않는다 — signals.length 이고 서버도 저장하지 않는다 */
        experienced: dx.backflow.experienced,
      },
      warnings: dx.warnings,
      /* actions 는 보내지 않는다 — status·weakestPoint·slots 에서 재생성되며 서버도
         저장하지 않는다. 화면 표시는 엔진 출력(dx.actions)을 그대로 쓴다 */
      quality: dx.quality,
    },
    consent: { provide: true, priority: true },
  };
}

/* ────────────────────────────────────────────────────────────
   통계 기록 — 진단을 끝낸 모든 건을 익명으로 남긴다(동의 불필요).
   서버가 좌표를 100m 격자로 바꾼 뒤 원좌표를 버리고, 주소는 저장하지 않는다.
   "안전"으로 나온 집의 분포가 있어야 판정이 실제로 갈라지는지 확인할 수 있다.
   실패해도 사용자 화면을 막지 않는다 — 통계는 서비스 동작의 전제가 아니다.
   ──────────────────────────────────────────────────────────── */
export async function sendStats(payload: SavePayload): Promise<boolean> {
  try {
    const res = await fetch('/api/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      /* 동의 항목은 통계와 무관하므로 보내지 않는다 */
      body: JSON.stringify({
        location: { lat: payload.location.lat, lon: payload.location.lon, address: payload.location.address },
        flood: payload.flood,
        slots: payload.slots,
        diagnosis: payload.diagnosis,
      }),
    });
    if (!res.ok) { console.warn('[Stats] 기록 실패:', res.status); return false; }
    return true;
  } catch (err) {
    console.warn('[Stats] 기록 예외:', err);
    return false;
  }
}
