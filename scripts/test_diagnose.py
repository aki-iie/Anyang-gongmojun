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

    # 밸브가 있어도 실제 역류 경험이 있으면 매우미흡으로 확정
    assert r["backflow"]["status"] == "매우미흡"
    assert r["backflow"]["experienced"] is True

    # 창문이 지면보다 낮다는 경고가 있어야 함
    assert any("창문" in w for w in r["warnings"])
    print("  CASE 5 통과 — 최약 개구부 기준 판정 및 역류 경험 확정")


# ══════════════════════════════════════════════════════════════
# CASE 6 — 한쪽 개구부만 알 때 (류서현 지적 사항, 2026-09-16)
#   현관은 방어되는데 창문을 모름
#   기대: '방어가능'으로 결론짓지 않고 '확인필요'
#         모르는 개구부가 최약점일 수 있으므로 안전하다고 말할 수 없다
# ══════════════════════════════════════════════════════════════
def test_case6_partial_unknown_not_safe():
    slots = base(
        entrance_sill="카드보다높음", water_panel="설치",   # 현관 15+30 = 45cm
        window_base="unknown", window_barrier="unknown",   # 창문 모름
        backflow_valve="있음", rainy_symptom="없음",
        gurgling="없음", floor_backup="없음",
    )
    r = diagnose(slots, flood_depth_cm=30.0)

    # 현관 45cm > 침수심 30cm 이지만 창문을 모르므로 방어가능이라 할 수 없다
    assert r["surface"]["status"] == "확인필요", \
        f"창문 미확인인데 {r['surface']['status']} 로 결론 — 위험"
    assert r["surface"]["unknown_openings"] == ["창문"]
    assert r["surface"]["weakest_point"] == "현관"
    assert r["surface"]["effective_defense_cm"] == 45
    assert "창문" in r["surface"]["reason"]
    print("  CASE 6 통과 — 한쪽 미확인 시 '방어가능' 결론 금지")


# ══════════════════════════════════════════════════════════════
# CASE 7 — 한쪽만 알아도 유입이 확정되는 경우 (비대칭의 반대편)
#   현관이 이미 침수심보다 낮음, 창문은 모름
#   기대: 모르는 쪽과 무관하게 '유입가능' 확정
# ══════════════════════════════════════════════════════════════
def test_case7_partial_unknown_but_inflow_certain():
    slots = base(
        entrance_sill="카드보다낮음", water_panel="미설치",  # 현관 5cm
        window_base="unknown", window_barrier="unknown",
    )
    r = diagnose(slots, flood_depth_cm=30.0)

    assert r["surface"]["status"] == "유입가능"
    assert r["surface"]["effective_defense_cm"] == 5
    assert r["surface"]["need_barrier_cm"] == 30.0
    assert r["surface"]["unknown_openings"] == ["창문"]
    assert "확인하지 못했습니다" in r["surface"]["reason"]
    print("  CASE 7 통과 — 한쪽만으로 유입 확정 시 미확인과 무관하게 판정")


# ══════════════════════════════════════════════════════════════
# CASE 8 — 둘 다 알고 둘 다 방어될 때만 '방어가능'
# ══════════════════════════════════════════════════════════════
def test_case8_both_known_both_safe():
    slots = base(
        entrance_sill="카드보다높음", water_panel="설치",    # 45cm
        window_base="땅보다높음", window_barrier="설치",     # 50cm
    )
    r = diagnose(slots, flood_depth_cm=30.0)
    assert r["surface"]["status"] == "방어가능"
    assert r["surface"]["unknown_openings"] == []
    print("  CASE 8 통과 — 전부 확인된 경우에만 '방어가능'")


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


# ══════════════════════════════════════════════════════════════
# 부가: 예상침수심 - 방어높이 차이값을 내보내지 않는다
#   두 입력을 따로 두고 차이는 쓰는 시점에 계산한다.
#   저장하면 SEG_DEPTH_CM 과 환산 규칙이 개정될 때 행마다 정의가 달라진다.
# ══════════════════════════════════════════════════════════════
def test_no_derived_inflow_column():
    cases = [
        # (침수심, 슬롯, 기대 status)
        (50.0, dict(entrance_sill="카드보다낮음", water_panel="미설치",
                    window_base="땅보다낮음", window_barrier="미설치"), "유입가능"),
        (40.0, dict(entrance_sill="카드보다높음", water_panel="설치",
                    window_base="땅보다높음", window_barrier="설치"), "방어가능"),
        (30.0, dict(entrance_sill="unknown", water_panel="unknown",
                    window_base="unknown", window_barrier="unknown"), "확인필요"),
    ]
    for depth, extra, expected in cases:
        r = diagnose(base(**extra), flood_depth_cm=depth)
        assert r["surface"]["status"] == expected, r["surface"]["status"]
        assert "inflow_cm" not in r["surface"], "차이값 컬럼이 되살아났다"
        # 두 입력은 따로 남아 있어야 한다 (차이는 여기서 재계산 가능)
        assert "effective_defense_cm" in r["surface"]
    print("  부가 통과 — 차이값 컬럼 부재 및 두 입력 분리 보존")


if __name__ == "__main__":
    print("\n판정 엔진 단위 테스트")
    print("=" * 52)
    tests = [
        test_case1_typical_vulnerable,
        test_case2_all_unknown,
        test_case3_fully_protected,
        test_case4_no_flood_data,
        test_case5_window_is_weakest,
        test_case6_partial_unknown_not_safe,
        test_case7_partial_unknown_but_inflow_certain,
        test_case8_both_known_both_safe,
        test_invalid_enum_rejected,
        test_deterministic,
        test_no_derived_inflow_column,
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
