from research.options_promoter.options_costs import leg_cost, structure_round_trip_cost


def test_sell_leg_has_stt_buy_leg_does_not():
    sell = leg_cost("sell", "entry", premium=100.0, lot_size=50, num_lots=1)
    buy = leg_cost("buy", "entry", premium=20.0, lot_size=50, num_lots=1)
    assert sell.stt > 0
    assert buy.stt == 0
    assert buy.stamp_duty > 0
    assert sell.stamp_duty == 0


def test_structure_cost_is_never_negative_and_scales_with_lots():
    legs = [
        {"side": "sell", "entry_premium": 100.0, "exit_premium": 40.0},
        {"side": "sell", "entry_premium": 90.0, "exit_premium": 150.0},
        {"side": "buy", "entry_premium": 20.0, "exit_premium": 5.0},
        {"side": "buy", "entry_premium": 18.0, "exit_premium": 60.0},
    ]
    cost_1_lot = structure_round_trip_cost(legs, lot_size=50, num_lots=1)
    cost_2_lots = structure_round_trip_cost(legs, lot_size=50, num_lots=2)
    assert cost_1_lot > 0
    assert cost_2_lots > cost_1_lot


def test_naked_structure_is_impossible_via_build_structure():
    from research.options_promoter.options_engine import build_structure

    for structure in ["iron_condor", "hedged_strangle", "iron_fly"]:
        legs = build_structure(structure, spot_price=20000, strike_step=50, wing_width_steps=4,
                                otm_steps=6)
        assert "buy_call_wing" in legs and "buy_put_wing" in legs

    import pytest
    with pytest.raises(ValueError):
        build_structure("unknown_naked_thing", 20000, 50, 4, 6)
