# -*- coding: utf-8 -*-
"""
diagnose.py 단위 테스트 — 결측값·극단값 포함 5대 케이스

실행:  python3 scripts/test_diagnose.py
     또는  pytest scripts/test_diagnose.py

검증 목적
--------
심사 발표에서 "판정이 항상 같은 결과를 내는가"를 물었을 때
이 테스트 결과를 근거로 제시한다.

작성: 차동현
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from diagnose import diagnose, validate_slots, SLOT_IDS  # noqa: E402


def base(**over):
    """기본값(모두 unknown)에서 필요한 슬롯만 덮어쓴다."""
    s = {sid: "unknown" for sid in SLOT_IDS}
    s.update(over)
    return s


# ══════════════════════════════════════════════════════════════
# CASE 1 — 전형적 취약 가구
#   현관 턱 낮고, 물막이판 없고, 역류 징후 있음
#   기대: 경로 A 유입가능 / 경로 B 매우미흡
# ══════════════════════════════════════════════════════════════
def test_case1_typical_vulnerable():
    slots = base(
        entrance_sill="카드보다낮음", stair_count="3-4",
        water_panel="미설치", window_base="비슷",
        window_barrier="미설치", backflow_valve="없음",
        rainy_symptom="있음", gurgling="없음", floor_backup="없음",
        road_slope="내리막", drain_status="막힘의심", canopy="없음",
    )
    r = diagnose(slots, flood_depth_cm=50.0, build_year=1988)

    assert r["surface"]["status"] == "유입가능"
    # 창문(3cm)이 현관(5cm)보다 낮으므로 창문이 최약점
    assert r["surface"]["weakest_point"] == "창문"
    assert r["surface"]["effective_defense_cm"] == 3
    assert r["surface"]["inflow_cm"] == 47.0
    assert r["surface"]["need_barrier_cm"] == 50.0

    assert r["backflow"]["status"] == "매우미흡"
    assert r["backflow"]["signal_count"] == 3

    assert r["quality"]["unknown_count"] == 0
    assert r["quality"]["reliable"] is True
    print("  CASE 1 통과 — 전형적 취약 가구")


# ══════════════════════════════════════════════════════════════
# CASE 2 — 전 항목 결측 (극단값)
#   사용자가 모든 문항에 '잘 모르겠다'로 답한 경우
#   기대: 억지 판정하지 않고 확인필요 반환, 서비스는 중단되지 않음
# ══════════════════════════════════════════════════════════════
def test_case2_all_unknown():
    slots = base()
    r = diagnose(slots, flood_depth_cm=50.0)

    assert r["surface"]["status"] == "확인필요"
    assert r["surface"]["effective_defense_cm"] is None
    assert r["surface"]["inflow_cm"] is None

    assert r["backflow"]["status"] == "확인필요"
    assert r["backflow"]["signal_count"] == 0

    assert r["quality"]["unknown_count"] == 12
    assert r["quality"]["unknown_rate"] == 1.0
    assert r["quality"]["reliable"] is False

    # 행동요령은 진단 결과와 무관하게 항상 제공되어야 한다
    assert len(r["rain_guide"]) == 5
    print("  CASE 2 통과 — 전 항목 결측 시 억지 판정 없음")


# ══════════════════════════════════════════════════════════════
# CASE 3 — 완전 방어 가구
#   물막이판·차수막·역류방지밸브 모두 설치
#   기대: 경로 A 방어가능 / 경로 B 양호 / 조치 없음
# ══════════════════════════════════════════════════════════════
def test_case3_fully_protected():
    slots = base(
        entrance_sill="카드보다높음", stair_count="0",
        water_panel="설치", window_base="땅보다높음",
        window_barrier="설치", backflow_valve="있음",
        rainy_symptom="없음", gurgling="없음", floor_backup="없음",
        road_slope="오르막", drain_status="양호", canopy="있음",
    )
    r = diagnose(slots, flood_depth_cm=40.0, build_year=2015)

    # 현관 15+30=45, 창문 20+30=50 -> 실효 45cm > 침수심 40cm
    assert r["surface"]["status"] == "방어가능"
    assert r["surface"]["effective_defense_cm"] == 45
    assert r["surface"]["inflow_cm"] == 0.0
    assert r["surface"]["need_barrier_cm"] is None

    assert r["backflow"]["status"] == "양호"
    assert r["backflow"]["signal_count"] == 0

    assert r["warnings"] == []
    assert r["actions"] == []
    print("  CASE 3 통과 — 완전 방어 시 조치 없음")


# ══════════════════════════════════════════════════════════════
# CASE 4 — 침수심 데이터 없음 (외부 조회 실패)
#   기대: 경로 A 는 보류하되 경로 B 는 독립적으로 판정되어야 함
#         공공데이터 장애가 서비스 전체를 멈추면 안 된다
# ══════════════════════════════════════════════════════════════
def test_case4_no_flood_data():
    slots = base(
        entrance_sill="카드와비슷", stair_count="1-2",
        water_panel="미설치", window_base="비슷",
        window_barrier="미설치", backflow_valve="없음",
        rainy_symptom="없음", gurgling="있음", floor_backup="없음",
        road_slope="평지", drain_status="양호", canopy="있음",
    )
    r = diagnose(slots, flood_depth_cm=None, build_year=2001)

    assert r["surface"]["status"] == "확인필요"
    assert r["surface"]["effective_defense_cm"] == 3   # 창문이 최약점
    assert r["surface"]["inflow_cm"] is None

    # 역류는 침수심과 무관하므로 정상 판정되어야 한다
    assert r["backflow"]["status"] == "미흡"
    assert r["backflow"]["signal_count"] == 2
    print("  CASE 4 통과 — 침수심 조회 실패 시에도 역류 판정 유지")


# ══════════════════════════════════════════════════════════════
# CASE 5 — 현관은 방어되나 창문이 최약점 (최소값 로직 검증)
#   + 이미 역류를 경험한 경우 상태 확정
#   기대: 물막이판이 있어도 창문 때문에 유입가능
# ══════════════════════════════════════════════════════════════
def test_case5_window_is_weakest():
    slots = base(
        entrance_sill="카드보다높음", stair_count="1-2",
        water_panel="설치",            # 현관 15+30 = 45cm
        window_base="땅보다낮음",       # 창문 0cm
        window_barrier="미설치",
        backflow_valve="있음",          # 밸브는 있으나
        rainy_symptom="없음", gurgling="없음",
        floor_backup="있음",            # 이미 역류 경험 -> 상태 확정
        road_slope="평지", drain_status="양호", canopy="있음",
    )
    r = diagnose(slots, flood_depth_cm=30.0, build_year=2005)

    assert r["surface"]["weakest_point"] == "창문"
    assert r["surface"]["effective_defense_cm"] == 0
    assert r["surface"]["status"] == "유입가능"
    assert r["surface"]["inflow_cm"] == 30.0

    # 밸브가 있어도 실제 역류 경험이 있으면 매우미흡으로 확정
    assert r["backflow"]["status"] == "매우미흡"
    assert r["backflow"]["experienced"] is True

    # 창문이 지면보다 낮다는 경고가 있어야 함
    assert any("창문" in w for w in r["warnings"])
    print("  CASE 5 통과 — 최약 개구부 기준 판정 및 역류 경험 확정")


# ══════════════════════════════════════════════════════════════
# 부가 — 허용되지 않은 Enum 차단
# ══════════════════════════════════════════════════════════════
def test_invalid_enum_rejected():
    bad = base(entrance_sill="아주높음")
    assert validate_slots(bad) != []
    try:
        diagnose(bad, 50.0)
        raise AssertionError("잘못된 Enum 이 통과되었습니다")
    except ValueError:
        pass
    print("  부가 통과 — 허용 외 Enum 차단")


# ══════════════════════════════════════════════════════════════
# 부가 — 재현성: 동일 입력 100회 반복 시 동일 출력
# ══════════════════════════════════════════════════════════════
def test_deterministic():
    slots = base(
        entrance_sill="카드보다낮음", stair_count="3-4",
        water_panel="미설치", window_base="비슷",
        window_barrier="미설치", backflow_valve="없음",
        rainy_symptom="있음", gurgling="없음", floor_backup="없음",
        road_slope="내리막", drain_status="막힘의심", canopy="없음",
    )
    first = diagnose(slots, 50.0, 1988)
    for _ in range(100):
        assert diagnose(slots, 50.0, 1988) == first
    print("  부가 통과 — 동일 입력 100회 재현성 확인")


if __name__ == "__main__":
    print("\n판정 엔진 단위 테스트")
    print("=" * 52)
    tests = [
        test_case1_typical_vulnerable,
        test_case2_all_unknown,
        test_case3_fully_protected,
        test_case4_no_flood_data,
        test_case5_window_is_weakest,
        test_invalid_enum_rejected,
        test_deterministic,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except AssertionError as e:
            failed += 1
            print(f"  {t.__name__} 실패: {e}")
    print("=" * 52)
    if failed:
        print(f"{len(tests) - failed}/{len(tests)} 통과, {failed}건 실패")
        sys.exit(1)
    print(f"전체 {len(tests)}건 통과")
