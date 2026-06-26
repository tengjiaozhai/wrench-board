"""测试 _try_unwrap 对字符串化 JSON 的处理。

模拟 qwen3-vl-plus 模型返回的畸形 payload：
- nodes 和 nets 字段是字符串化的 JSON（带换行符前缀）
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from pydantic import ValidationError
from api.pipeline.schematic.schemas import SchematicPageGraph
from api.pipeline.tool_call import _deep_unwrap_strings, _normalize_qwen_fields, _try_unwrap


def _try_unwrap_with_error(payload: object, output_schema) -> tuple:
    """带详细错误输出的 _try_unwrap。"""
    if not isinstance(payload, dict):
        return None, "not a dict"
    
    unwrapped = _deep_unwrap_strings(payload)
    page_hint = unwrapped.get("page") if isinstance(unwrapped, dict) else None
    normalized = _normalize_qwen_fields(unwrapped, page_hint)
    
    if normalized != payload:
        try:
            return output_schema.model_validate(normalized), None
        except ValidationError as exc:
            return None, f"normalize+unwrap validation failed:\n{exc}"
    
    if isinstance(normalized, dict):
        for value in normalized.values():
            if isinstance(value, dict):
                try:
                    return output_schema.model_validate(value), None
                except ValidationError:
                    continue
    
    return None, "no recovery path matched"


def test_stringified_nodes_list():
    """测试节点列表被字符串化的情况。"""
    print("\n=== Test 1: Stringified nodes list ===")
    
    # 模拟模型返回的畸形 payload
    payload = {
        "page": 10,
        "nodes": '\n[{"refdes": "C2200", "type": "capacitor", "pins": []}]\n',
        "nets": '\n[{"local_id": "net_001", "label": "VBUS", "is_power": true}]\n',
        "cross_page_refs": [],
        "typed_edges": [],
        "designer_notes": [],
        "ambiguities": [],
    }
    
    print(f"Input nodes type: {type(payload['nodes'])}")
    print(f"Input nodes value: {payload['nodes']!r}")
    
    # 测试 _deep_unwrap_strings
    unwrapped = _deep_unwrap_strings(payload)
    print(f"\nAfter _deep_unwrap_strings:")
    print(f"Unwrapped nodes type: {type(unwrapped['nodes'])}")
    print(f"Unwrapped nodes value: {unwrapped['nodes']}")
    
    # 测试 _try_unwrap
    result, error = _try_unwrap_with_error(payload, SchematicPageGraph)
    if result:
        print(f"\n_try_unwrap SUCCESS:")
        print(f"  page: {result.page}")
        print(f"  nodes count: {len(result.nodes)}")
        print(f"  nets count: {len(result.nets)}")
    else:
        print(f"\n_try_unwrap FAILED:")
        print(f"  {error}")
    
    return result is not None


def test_nested_stringified():
    """测试嵌套字符串化的情况。"""
    print("\n=== Test 2: Nested stringified payload ===")
    
    # 模拟更复杂的嵌套字符串化
    payload = {
        "page": 10,
        "nodes": '[{"refdes": "U1", "type": "ic", "pins": [{"pin": "1", "net_label": "VCC"}]}]',
        "nets": '[{"local_id": "n1", "label": "VCC", "is_power": true}]',
        "cross_page_refs": '[]',
        "typed_edges": '[]',
        "designer_notes": '[]',
        "ambiguities": '[]',
    }
    
    result, error = _try_unwrap_with_error(payload, SchematicPageGraph)
    if result:
        print(f"SUCCESS: page={result.page}, nodes={len(result.nodes)}, nets={len(result.nets)}")
    else:
        print(f"FAILED: {error}")
    
    return result is not None


def test_partial_stringified():
    """测试部分字段字符串化的情况。"""
    print("\n=== Test 3: Partial stringified payload ===")
    
    # 只有部分字段是字符串
    payload = {
        "page": 10,
        "nodes": '\n[{"refdes": "R1", "type": "resistor", "value": {"nominal": "10k", "unit": "ohm"}}]\n',
        "nets": [{"local_id": "n1", "label": "GND", "is_power": False}],  # 这个是正常的 list
        "cross_page_refs": [],
        "typed_edges": [],
        "designer_notes": [],
        "ambiguities": [],
    }
    
    result, error = _try_unwrap_with_error(payload, SchematicPageGraph)
    if result:
        print(f"SUCCESS: page={result.page}, nodes={len(result.nodes)}, nets={len(result.nets)}")
    else:
        print(f"FAILED: {error}")
    
    return result is not None


def test_invalid_json_in_string():
    """测试字符串中包含无效 JSON 的情况。"""
    print("\n=== Test 4: Invalid JSON in string ===")
    
    payload = {
        "page": 10,
        "nodes": '\n[{"refdes": "C1", "type": "capacitor", ...}]\n',  # 无效的 JSON（省略号）
        "nets": [],
        "cross_page_refs": [],
        "typed_edges": [],
        "designer_notes": [],
        "ambiguities": [],
    }
    
    result, error = _try_unwrap_with_error(payload, SchematicPageGraph)
    if result:
        print(f"SUCCESS (unexpected)")
    else:
        print(f"FAILED (expected - invalid JSON): {error[:100]}...")
    
    return result is None


def test_real_world_payload():
    """测试从日志中提取的真实 payload 结构。"""
    print("\n=== Test 5: Real-world payload from logs ===")
    
    # 模拟日志中显示的错误情况
    payload = {
        "ambiguities": [
            {
                "description": "Refdes 'U2400C' and 'U2400E' both labeled 'MT6358'",
                "page": 10,
                "related_refdes": ["U2400C", "U2400E"]
            }
        ],
        "confidence": 0.98,
        "cross_page_refs": [
            {"direction": "in", "label": "BATON", "page": 10}
        ],
        "designer_notes": [],
        "nodes": '\n[{"refdes": "C2200", "type": "capacitor", "value": {"nominal": "100n", "unit": "F"}, "pins": [{"pin": "1", "net_label": "VBUS"}], "populated": true}]\n',
        "nets": '\n[{"local_id": "net_001", "label": "VBUS", "is_power": true, "connects": ["C2200:1"]}]\n',
        "page": 10,
        "page_kind": "schematic",
        "sheet_name": None,
        "sheet_path": None,
        "typed_edges": [],
    }
    
    print(f"Input nodes: {payload['nodes']!r}")
    
    # 先测试 _deep_unwrap_strings
    unwrapped = _deep_unwrap_strings(payload)
    print(f"\nAfter _deep_unwrap_strings:")
    print(f"  nodes type: {type(unwrapped['nodes'])}")
    if isinstance(unwrapped['nodes'], list):
        print(f"  nodes[0]: {unwrapped['nodes'][0]}")
    
    # 测试 _try_unwrap
    result, error = _try_unwrap_with_error(payload, SchematicPageGraph)
    if result:
        print(f"\n_try_unwrap SUCCESS:")
        print(f"  page: {result.page}")
        print(f"  nodes: {len(result.nodes)}")
        print(f"  nets: {len(result.nets)}")
        print(f"  cross_page_refs: {len(result.cross_page_refs)}")
        print(f"  ambiguities: {len(result.ambiguities)}")
    else:
        print(f"\n_try_unwrap FAILED:")
        print(f"  {error}")
    
    return result is not None


def main():
    print("Testing _try_unwrap with stringified JSON payloads")
    print("=" * 60)
    
    results = {
        "stringified_node_list": test_stringified_nodes_list(),
        "nested_stringified": test_nested_stringified(),
        "partial_stringified": test_partial_stringified(),
        "invalid_json_in_string": test_invalid_json_in_string(),
        "real_world_payload": test_real_world_payload(),
    }
    
    print("\n" + "=" * 60)
    print("SUMMARY:")
    print("=" * 60)
    for name, passed in results.items():
        status = "PASS" if passed else "FAIL"
        print(f"  {name:30s} {status}")
    
    all_passed = all(results.values())
    print("\n" + ("All tests passed!" if all_passed else "Some tests failed!"))
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
