# -*- coding: utf-8 -*-
"""
잠길까 — 이중 경로 침수 위험 판정 엔진

설계 원칙
---------
1. 외부 라이브러리를 사용하지 않는 순수 함수다. 동일 입력 -> 동일 출력.
2. LLM은 슬롯 값 추출까지만 담당하고, 위험 판정은 이 파일이 전담한다.
3. 임의 배점표를 만들지 않는다.
   - 경로 A(지표 유입)는 '예상침수심 - 개구부 방어높이' 라는 물리적 뺄셈이다.
   - 경로 B(역류)는 확률을 산출하지 않고 '대비 장치와 전조 징후'를 카운팅한다.
4. 값이 unknown 이면 추측하지 않고 판정 보류(확인필요)로 내린다.

경로 A / B 를 분리하는 이유
---------------------------
물막이판은 역류를 막지 못하고, 역류방지밸브는 지표 유입을 막지 못한다.
두 경로는 원인도 대비 설비도 다르므로 하나의 점수로 합치지 않는다.

작성: 차동현
"""

from typing import Dict, Any, Optional, List

# ─────────────────────────────────────────────────────────────
# 슬롯 정의 — 챗봇 12문항과 1:1 대응 (functions/src/prompt.ts 와 동일)
# ─────────────────────────────────────────────────────────────
SLOT_IDS: List[str] = [
    "entrance_sill",    # 1  현관 턱 높이
    "stair_count",      # 2  하향 계단 칸수
    "water_panel",      # 3  현관 물막이판          [사진 확인 지원]
    "window_base",      # 4  창문 하단 지면 대비 위치
    "window_barrier",   # 5  창문 차수막
    "backflow_valve",   # 6  역류방지밸브            [사진 확인 지원]
    "rainy_symptom",    # 7  강우 시 배수 지연·악취
    "gurgling",         # 8  배수 시 이상음
    "floor_backup",     # 9  바닥 배수구 역류 경험
    "road_slope",       # 10 골목 경사
    "drain_status",     # 11 빗물받이 상태
    "canopy",           # 12 현관 차양·지붕
]

ALLOWED: Dict[str, List[str]] = {
    "entrance_sill":  ["없음", "카드1개", "카드2개", "카드3개이상", "unknown"],
    "stair_count":    ["0", "1-2", "3-4", "5이상", "unknown"],
    "water_panel":    ["설치", "미설치", "unknown"],
    "window_base":    ["땅보다낮음", "비슷", "카드1개", "카드2개", "카드3개이상", "unknown"],
    "window_barrier": ["설치", "미설치", "unknown"],
    "backflow_valve": ["있음", "없음", "unknown"],
    "rainy_symptom":  ["있음", "없음", "unknown"],
    "gurgling":       ["있음", "없음", "unknown"],
    "floor_backup":   ["있음", "없음", "unknown"],
    "road_slope":     ["내리막", "평지", "오르막", "unknown"],
    "drain_status":   ["양호", "막힘의심", "없음", "unknown"],
    "canopy":         ["있음", "없음", "unknown"],
}

# ─────────────────────────────────────────────────────────────
# 등급 -> cm 환산
#   생활 기준물 비교 응답을 보수적으로 환산한다.
#   신용카드 긴 변 = 85.6mm 이므로 '카드와비슷'을 9cm 로 둔다.
#   구간의 하한값을 택해 위험을 과소평가하지 않는다.
# ─────────────────────────────────────────────────────────────
# 카드 "개수" 로 묻는다. 높다/낮다로 물었을 때 충훈동 실측 34가구가
# 아래 두 칸(없음·카드보다낮음)에 0가구, 위 한 칸에 20가구(62%)로 몰렸다.
# 실측 현관턱은 8.5 / 17 / 25.5 / 32cm — 전부 카드(8.56cm)의 정수배로 관찰됐다.
SILL_CM = {
    "없음": 0,
    "카드1개": 8.5,        # 신용카드 긴 변 8.56cm
    "카드2개": 17,
    "카드3개이상": 25.5,   # 실측 상한 32cm 이나 하한값을 택해 과소평가를 막는다
    # ── 구버전 값. 이미 저장된 데이터를 읽기 위해 남긴다(ALLOWED 에는 없음) ──
    "카드보다낮음": 5,
    "카드와비슷": 9,
    "카드보다높음": 15,
}

# 창문은 지면보다 낮게 박힌 사례가 실재하므로 '땅보다낮음' 을 유지하고,
# 지면 위쪽만 카드 개수로 나눈다.
WINDOW_BASE_CM = {
    "땅보다낮음": 0,       # 지면보다 낮으면 방어 높이 0. 별도 경고로 표기
    "비슷": 3,
    "카드1개": 8.5,
    "카드2개": 17,
    "카드3개이상": 25.5,
    "땅보다높음": 20,      # 구버전 값 — 저장된 데이터 읽기용
}

# 가정용 물막이판 일반 규격. 사업계획서에 제품 규격 출처를 각주로 명시할 것.
PANEL_CM = 30
BARRIER_CM = 30        # 창문 차수막 (안양시 지원 품목)

STAIR_DEPTH_CM = {     # 계단 한 칸 약 16cm. 실내 바닥 깊이 추정에만 사용.
    "0": 0,
    "1-2": 16,
    "3-4": 48,
    "5이상": 80,
}


def _is_unknown(v: Optional[str]) -> bool:
    return v is None or v == "unknown" or v == ""


def validate_slots(slots: Dict[str, Any]) -> List[str]:
    """허용 Enum 을 벗어난 값을 찾아 반환한다. 비어 있으면 정상."""
    errors = []
    for sid in SLOT_IDS:
        v = slots.get(sid)
        if v is None:
            continue
        if v not in ALLOWED[sid]:
            errors.append(f"{sid}: 허용되지 않은 값 '{v}'")
    return errors


# ─────────────────────────────────────────────────────────────
# 경로 A — 지표 유입
# ─────────────────────────────────────────────────────────────
def _diagnose_surface(slots: Dict[str, Any],
                      flood_depth_cm: Optional[float]) -> Dict[str, Any]:
    """
    개구부별 방어 높이를 각각 구하고 '가장 낮은 지점'을 실효 방어높이로 삼는다.
    현관에 물막이판이 있어도 창문이 지면보다 낮으면 그쪽으로 물이 들어온다.

    비대칭 판정 원칙
    ----------------
    - 아는 개구부 하나만으로도 침수심보다 낮으면 -> '유입가능' 확정.
      (모르는 개구부가 더 낮더라도 결론은 같다)
    - 아는 개구부는 방어되지만 다른 개구부를 모르면 -> '확인필요'.
      모르는 쪽이 최약점일 수 있으므로 '방어가능'이라 결론지을 수 없다.
    - 둘 다 알고 둘 다 방어될 때만 -> '방어가능'.

    "위험하다"는 한쪽만 알아도 말할 수 있지만,
    "안전하다"는 전부 알아야 말할 수 있다.
    """
    sill = slots.get("entrance_sill")
    panel = slots.get("water_panel")
    wbase = slots.get("window_base")
    wbar = slots.get("window_barrier")

    entrance_def = None
    if not _is_unknown(sill):
        entrance_def = SILL_CM[sill]
        if panel == "설치":
            entrance_def += PANEL_CM

    window_def = None
    if not _is_unknown(wbase):
        window_def = WINDOW_BASE_CM[wbase]
        if wbar == "설치":
            window_def += BARRIER_CM

    known = {}
    if entrance_def is not None:
        known["현관"] = entrance_def
    if window_def is not None:
        known["창문"] = window_def
    unknown_openings = [n for n in ("현관", "창문") if n not in known]

    base = {
        "effective_defense_cm": None,
        "weakest_point": None,
        "inflow_cm": None,
        "need_barrier_cm": None,
        "unknown_openings": unknown_openings,
    }

    if not known:
        return {**base, "status": "확인필요",
                "reason": "현관 턱과 창문 위치를 모두 확인하지 못했습니다."}

    weakest = min(known, key=known.get)
    effective = known[weakest]
    base["effective_defense_cm"] = effective
    base["weakest_point"] = weakest

    if flood_depth_cm is None:
        return {**base, "status": "확인필요",
                "reason": "해당 주소의 예상침수심 정보를 조회하지 못했습니다."}

    # 아는 개구부만으로 이미 유입이 확정되면, 모르는 쪽과 무관하게 결론이 같다.
    if flood_depth_cm > effective:
        reason = (f"예상침수심 {flood_depth_cm:g}cm 가 "
                  f"{weakest} 방어높이 {effective}cm 를 초과합니다.")
        if unknown_openings:
            reason += f" ({unknown_openings[0]} 상태는 확인하지 못했습니다.)"
        return {**base, "status": "유입가능", "reason": reason,
                "inflow_cm": round(flood_depth_cm - effective, 1),
                # 행안부 고시 제23조: 예상 침수 높이 이상의 여유고 확보
                "need_barrier_cm": round(flood_depth_cm, 1)}

    # 아는 개구부는 방어되지만, 모르는 개구부가 최약점일 수 있다.
    if unknown_openings:
        u = unknown_openings[0]
        return {**base, "status": "확인필요",
                "reason": (f"{weakest} 방어높이 {effective}cm 는 예상침수심 "
                           f"{flood_depth_cm:g}cm 이상이지만, {u} 상태를 확인하지 못해 "
                           f"방어 가능 여부를 결론지을 수 없습니다.")}

    return {**base, "status": "방어가능",
            "reason": (f"{weakest} 방어높이 {effective}cm 가 "
                       f"예상침수심 {flood_depth_cm:g}cm 이상입니다."),
            "inflow_cm": 0.0}


# ─────────────────────────────────────────────────────────────
# 경로 B — 내부 역류
# ─────────────────────────────────────────────────────────────
def _diagnose_backflow(slots: Dict[str, Any],
                       build_year: Optional[int] = None) -> Dict[str, Any]:
    """
    역류 발생 확률은 하수관망 해석의 영역이므로 예측하지 않는다.
    '막을 장치가 있는가' 와 '이미 전조가 나타나고 있는가' 만 판정한다.
    """
    symptoms: List[str] = []

    if slots.get("rainy_symptom") == "있음":
        symptoms.append("비가 올 때만 배수가 지연됩니다. 하수관 수위 상승 신호입니다.")
    if slots.get("gurgling") == "있음":
        symptoms.append("배수 시 이상음이 발생합니다. 배관 내 압력 이상입니다.")
    if build_year is not None and build_year < 1995:
        symptoms.append("1995년 이전 건축물로 배관 노후가 예상됩니다.")

    signals = list(symptoms)
    if slots.get("backflow_valve") == "없음":
        signals.append("역류방지밸브가 설치되어 있지 않습니다.")

    # 이미 역류를 경험했다면 징후가 아니라 사실이므로 상태를 확정한다.
    experienced = slots.get("floor_backup") == "있음"
    if experienced:
        signals.insert(0, "바닥 배수구에서 물이 올라온 경험이 있습니다.")

    core = ["backflow_valve", "rainy_symptom", "gurgling", "floor_backup"]
    unknowns = [s for s in core if _is_unknown(slots.get(s))]

    if experienced:
        status = "매우미흡"
    elif len(symptoms) >= 2:
        status = "매우미흡"
    elif len(symptoms) >= 1:
        status = "미흡"
    elif len(unknowns) == len(core):
        status = "확인필요"
    else:
        status = "양호"

    return {
        "status": status,
        "signals": signals,
        "signal_count": len(signals),
        "experienced": experienced,
        "unknown_items": unknowns,
    }


# ─────────────────────────────────────────────────────────────
# 가중 요인 — 점수화하지 않고 경고로만 표기
# ─────────────────────────────────────────────────────────────
def _collect_warnings(slots: Dict[str, Any]) -> List[str]:
    w: List[str] = []
    if slots.get("window_base") == "땅보다낮음":
        w.append("창문 하단이 지면보다 낮아 직접 유입 위험이 있습니다.")
    if slots.get("canopy") == "없음":
        w.append("현관 위 차양이 없어 빗물이 출입구로 직접 떨어집니다.")
    if slots.get("road_slope") == "내리막":
        w.append("골목이 집 방향으로 기울어 주변 빗물이 모입니다.")
    if slots.get("drain_status") == "막힘의심":
        w.append("빗물받이 막힘이 의심됩니다. 구청 신고를 권장합니다.")
    if slots.get("drain_status") == "없음":
        w.append("주변에 빗물받이가 확인되지 않습니다.")
    if slots.get("stair_count") in ("3-4", "5이상"):
        d = STAIR_DEPTH_CM[slots["stair_count"]]
        w.append(f"실내 바닥이 지면보다 약 {d}cm 낮아 유입 시 배수가 어렵습니다.")
    return w


# ─────────────────────────────────────────────────────────────
# 조치 안내
#   안양시 지원 현황(2026년 9월 담당부서 확인 기준)
#     지원   : 창문 차수막, 배수 펌프
#     미지원 : 현관 물막이판, 역류방지밸브
# ─────────────────────────────────────────────────────────────
ANYANG_SUPPORTED = {"window_barrier", "pump"}


def _build_actions(surface: Dict[str, Any],
                   backflow: Dict[str, Any],
                   slots: Dict[str, Any]) -> List[Dict[str, str]]:
    actions: List[Dict[str, str]] = []

    if surface["status"] == "유입가능":
        need = surface["need_barrier_cm"]
        if surface["weakest_point"] == "창문" and slots.get("window_barrier") == "미설치":
            actions.append({
                "item": "창문 차수막 설치",
                "detail": f"최소 {need:g}cm 이상 높이로 설치가 필요합니다.",
                "support": "안양시 지원 대상입니다. 동주민센터에 문의하세요.",
            })
        if slots.get("water_panel") == "미설치":
            actions.append({
                "item": "현관 물막이판 설치",
                "detail": f"최소 {need:g}cm 이상 높이로 설치가 필요합니다.",
                "support": "안양시는 현재 지원하지 않습니다. "
                           "자비 설치 또는 임대인 협의가 필요합니다.",
            })

    if backflow["status"] in ("미흡", "매우미흡"):
        if slots.get("backflow_valve") == "없음":
            actions.append({
                "item": "역류방지밸브 설치",
                "detail": "물막이판으로는 역류를 막을 수 없습니다. 별도 설치가 필요합니다.",
                "support": "안양시는 현재 지원하지 않습니다. "
                           "인근 지자체는 지원하는 사례가 있습니다.",
            })

    if slots.get("drain_status") == "막힘의심":
        actions.append({
            "item": "빗물받이 준설 신고",
            "detail": "낙엽·토사로 막힌 빗물받이는 설계 배수 용량을 쓰지 못합니다.",
            "support": "안양시 또는 동주민센터에 신고할 수 있습니다.",
        })

    return actions


# 강우 시 행동요령 — 진단 결과와 무관하게 동일하게 제공한다.
RAIN_GUIDE = [
    "지하 계단에 물이 조금이라도 흘러 들어오면 그때가 대피 시점입니다.",
    "계단 물높이가 종아리(약 40cm)에 닿기 전에 나오십시오.",
    "짐 정리나 물 퍼내기를 시도하지 마십시오.",
    "대피 시 슬리퍼 대신 운동화를 신으십시오.",
    "문 밖 수심이 무릎 이상이면 혼자 열지 말고 여러 명이 함께 미십시오.",
]


# ─────────────────────────────────────────────────────────────
# 공개 함수
# ─────────────────────────────────────────────────────────────
def diagnose(slots: Dict[str, Any],
             flood_depth_cm: Optional[float] = None,
             build_year: Optional[int] = None) -> Dict[str, Any]:
    """
    Parameters
    ----------
    slots : 12개 슬롯 값. 누락 시 unknown 으로 간주한다.
    flood_depth_cm : 도시침수지도 30년 빈도 예상침수심(cm). 조회 실패 시 None.
    build_year : 건축물대장 준공연도. 없으면 None.

    Returns
    -------
    dict — 경로 A / 경로 B / 경고 / 조치 / 데이터 품질
    """
    errors = validate_slots(slots)
    if errors:
        raise ValueError("슬롯 값 오류: " + "; ".join(errors))

    norm = {sid: (None if _is_unknown(slots.get(sid)) else slots.get(sid))
            for sid in SLOT_IDS}

    surface = _diagnose_surface(norm, flood_depth_cm)
    backflow = _diagnose_backflow(norm, build_year)
    warnings = _collect_warnings(norm)
    actions = _build_actions(surface, backflow, norm)

    unknown_count = sum(1 for sid in SLOT_IDS if norm[sid] is None)

    return {
        "flood_depth_cm": flood_depth_cm,
        "surface": surface,
        "backflow": backflow,
        "warnings": warnings,
        "actions": actions,
        "rain_guide": RAIN_GUIDE,
        "quality": {
            "unknown_count": unknown_count,
            "total_slots": len(SLOT_IDS),
            "unknown_rate": round(unknown_count / len(SLOT_IDS), 3),
            "reliable": unknown_count <= 3,
        },
    }


if __name__ == "__main__":
    import json
    sample = {
        "entrance_sill": "카드1개", "stair_count": "3-4",
        "water_panel": "미설치", "window_base": "비슷",
        "window_barrier": "미설치", "backflow_valve": "없음",
        "rainy_symptom": "있음", "gurgling": "없음",
        "floor_backup": "없음", "road_slope": "내리막",
        "drain_status": "막힘의심", "canopy": "없음",
    }
    print(json.dumps(diagnose(sample, 50.0, 1988),
                     ensure_ascii=False, indent=2))
