from api.stock.parts_index import _canonicalize_value, build_parts_index


def test_canonicalize_value_caps():
    assert _canonicalize_value({"raw": "100nF", "primary": None}) == "0.1uF"
    assert _canonicalize_value({"raw": "0.1uF", "primary": None}) == "0.1uF"
    assert _canonicalize_value({"raw": "1uF", "primary": "1µF"}) == "1uF"
    assert _canonicalize_value({"raw": "10pF", "primary": None}) == "10pF"


def test_canonicalize_value_resistors():
    assert _canonicalize_value({"raw": "10k", "primary": None}) == "10k"
    assert _canonicalize_value({"raw": "10K0", "primary": None}) == "10k"
    assert _canonicalize_value({"raw": "0R1", "primary": None}) == "0.1"
    assert _canonicalize_value({"raw": "4.7k", "primary": None}) == "4.7k"


def test_canonicalize_value_unrecognized_passes_through():
    assert _canonicalize_value({"raw": "weird_value_xyz", "primary": None}) == "weird_value_xyz"


def test_canonicalize_value_none():
    assert _canonicalize_value(None) is None
    assert _canonicalize_value({"raw": None, "primary": None}) is None


def _make_electrical_graph(components):
    """Tiny helper: build a minimal-shaped dict matching ElectricalGraph
    JSON for build_parts_index input."""
    return {
        "schema_version": "1.0",
        "device_slug": "test-device",
        "components": components,
        "nets": {},
        "power_rails": [],
        "typed_edges": [],
        "boot_sequence": [],
        "designer_notes": [],
        "ambiguities": [],
        "quality": {},
        "hierarchy": [],
    }


def test_build_parts_index_capacitor_decoupling():
    eg = _make_electrical_graph(
        {
            "C42": {
                "refdes": "C42",
                "type": "capacitor",
                "kind": "passive_c",
                "role": None,
                "value": {
                    "raw": "0.1uF",
                    "primary": "0.1µF",
                    "package": "0402",
                    "mpn": None,
                    "tolerance": "±10%",
                    "voltage_rating": 25.0,
                    "temp_coef": None,
                    "polarity_marker": False,
                    "description": None,
                },
                "pages": [3],
                "pins": [],
                "populated": True,
            }
        }
    )
    passive_class = {"classifications": [{"refdes": "C42", "role": "decoupling"}]}

    idx = build_parts_index(
        slug="test-device",
        electrical_graph=eg,
        passive_classification=passive_class,
        nets_classified=None,
    )

    e = idx.entries["C42"]
    assert e.value_canonical == "0.1uF"
    assert e.role_in_design == "decoupling"
    assert e.safety_class == "tolerant_with_warning"
    assert e.criticality_in_design == "low"  # no boot_sequence → default low


def test_build_parts_index_ic_is_exact_only():
    eg = _make_electrical_graph(
        {
            "U7": {
                "refdes": "U7",
                "type": "ic",
                "kind": "ic",
                "role": None,
                "value": {
                    "raw": "MAX77818EWY",
                    "primary": None,
                    "package": "QFN-56",
                    "mpn": "MAX77818EWY",
                    "tolerance": None,
                    "voltage_rating": None,
                    "temp_coef": None,
                    "polarity_marker": False,
                    "description": None,
                },
                "pages": [4],
                "pins": [],
                "populated": True,
            }
        }
    )
    idx = build_parts_index(
        slug="test-device", electrical_graph=eg, passive_classification=None, nets_classified=None
    )
    e = idx.entries["U7"]
    assert e.role_in_design == "ic"
    assert e.safety_class == "exact_only"
    assert e.mpn == "MAX77818EWY"


def test_build_parts_index_unclassified_passive_is_exact_only():
    eg = _make_electrical_graph(
        {
            "C99": {
                "refdes": "C99",
                "type": "capacitor",
                "kind": "passive_c",
                "role": None,
                "value": {
                    "raw": "1uF",
                    "primary": None,
                    "package": "0402",
                    "mpn": None,
                    "tolerance": None,
                    "voltage_rating": None,
                    "temp_coef": None,
                    "polarity_marker": False,
                    "description": None,
                },
                "pages": [1],
                "pins": [],
                "populated": True,
            }
        }
    )
    idx = build_parts_index(
        slug="test-device",
        electrical_graph=eg,
        passive_classification={"classifications": []},
        nets_classified=None,
    )
    e = idx.entries["C99"]
    assert e.role_in_design is None
    assert e.safety_class == "exact_only"  # fail-safe


def test_build_parts_index_filter_cap_blocked():
    eg = _make_electrical_graph(
        {
            "C200": {
                "refdes": "C200",
                "type": "capacitor",
                "kind": "passive_c",
                "role": None,
                "value": {
                    "raw": "10uF",
                    "primary": None,
                    "package": "0805",
                    "mpn": None,
                    "tolerance": None,
                    "voltage_rating": 16.0,
                    "temp_coef": None,
                    "polarity_marker": False,
                    "description": None,
                },
                "pages": [2],
                "pins": [],
                "populated": True,
            }
        }
    )
    passive_class = {"classifications": [{"refdes": "C200", "role": "filter"}]}
    idx = build_parts_index(
        slug="test-device",
        electrical_graph=eg,
        passive_classification=passive_class,
        nets_classified=None,
    )
    e = idx.entries["C200"]
    assert e.role_in_design == "filter"
    assert e.safety_class == "exact_only"


def test_build_parts_index_criticality_from_boot_sequence():
    eg = _make_electrical_graph(
        {
            "U1": {
                "refdes": "U1",
                "type": "ic",
                "kind": "ic",
                "role": None,
                "value": {
                    "raw": "PMIC",
                    "primary": None,
                    "package": "BGA",
                    "mpn": "PMIC123",
                    "tolerance": None,
                    "voltage_rating": None,
                    "temp_coef": None,
                    "polarity_marker": False,
                    "description": None,
                },
                "pages": [1],
                "pins": [],
                "populated": True,
            },
            "C500": {
                "refdes": "C500",
                "type": "capacitor",
                "kind": "passive_c",
                "role": None,
                "value": {
                    "raw": "0.1uF",
                    "primary": None,
                    "package": "0402",
                    "mpn": None,
                    "tolerance": None,
                    "voltage_rating": None,
                    "temp_coef": None,
                    "polarity_marker": False,
                    "description": None,
                },
                "pages": [9],
                "pins": [],
                "populated": True,
            },
        }
    )
    eg["boot_sequence"] = [
        {"phase": 1, "involved_refdes": ["U1"]},
        {"phase": 6, "involved_refdes": ["C500"]},
    ]
    idx = build_parts_index(
        slug="test-device", electrical_graph=eg, passive_classification=None, nets_classified=None
    )
    assert idx.entries["U1"].criticality_in_design == "high"  # phase ≤ 2
    assert idx.entries["C500"].criticality_in_design == "low"  # phase > 5


def test_build_parts_index_hash_is_deterministic():
    eg = _make_electrical_graph(
        {
            "C1": {
                "refdes": "C1",
                "type": "capacitor",
                "kind": "passive_c",
                "role": None,
                "value": None,
                "pages": [1],
                "pins": [],
                "populated": True,
            }
        }
    )
    idx1 = build_parts_index(
        slug="t", electrical_graph=eg, passive_classification=None, nets_classified=None
    )
    idx2 = build_parts_index(
        slug="t", electrical_graph=eg, passive_classification=None, nets_classified=None
    )
    assert idx1.source_electrical_graph_hash == idx2.source_electrical_graph_hash
    assert len(idx1.source_electrical_graph_hash) == 64  # sha256 hex
