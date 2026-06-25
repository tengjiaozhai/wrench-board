#!/usr/bin/env python3
"""Rebuild mnt-reform-motherboard knowledge pack.

Generates raw_research_dump.md from existing baseline + electrical graph data,
then runs Registry → Writers → Drift → Auditor (skipping Scout which needs
Claude-native web_search).
"""

import asyncio
import json
import logging
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)
logging.basicConfig(level=logging.INFO, stream=sys.stderr)

sys.path.insert(0, str(Path.cwd()))

from api.config import get_settings
from api.pipeline.schemas import (
    AuditVerdict,
    Dictionary,
    KnowledgeGraph,
    Registry,
    RulesSet,
    DriftItem,
)
from api.pipeline.schematic.schemas import ElectricalGraph
from api.pipeline.graph_truth import GraphTruth, build_ground_truth_report, extract_mentions
from api.pipeline.registry import run_registry_builder
from api.pipeline.writers import run_writers_parallel
from api.pipeline.auditor import run_auditor
from api.pipeline.drift import compute_drift
from api.pipeline.telemetry.token_stats import PhaseTokenStats
from anthropic import AsyncAnthropic

SLUG = "mnt-reform-motherboard"
LABEL = "MNT Reform 2 motherboard"


def generate_dump_from_baseline(pack_dir: Path) -> str:
    """Generate a synthetic raw_research_dump.md from existing baseline + graph data."""
    lines = [
        f"# Research Dump: {LABEL}",
        "",
        "## Device Overview",
        "",
        "The MNT Reform 2 is an open-source hardware laptop motherboard designed by MNT Research GmbH (Berlin). "
        "It is based on the i.MX8M Quad application processor (NXP) and features a fully open-source PCB design "
        "published under the CERN Open Hardware License v2. The motherboard handles power management, "
        "display output (eDP), audio codec (SGTL5000), PCIe expansion, USB connectivity, and the LPC bus for the "
        "system controller (RP2040). The power architecture uses a 24V DC input (J1 barrel jack) with a fuse (F1), "
        "a P-channel load switch (Q3, SI7461DP) gating VIN to PVIN, and multiple buck regulators generating "
        "+5V (U7, LM2677), +1V2 (U13, TLV62568), +3V3 (U12), LPC_VCC (U14, LMR16006), and PCIe 3.3V (U20, AP22815).",
        "",
        "## Components mentioned",
        "",
    ]

    # Extract components from baseline registry
    reg_path = pack_dir / "baseline" / "registry.json"
    if reg_path.exists():
        reg = json.loads(reg_path.read_text())
        for item in reg.get("items", []):
            name = item.get("canonical_name", "")
            desc = item.get("description", "")
            kind = item.get("kind", "")
            aliases = item.get("aliases", [])
            alias_str = f" (aliases: {', '.join(aliases)})" if aliases else ""
            lines.append(f"- **{name}** ({kind}){alias_str}: {desc}")
        lines.append("")

    # Extract edges from baseline knowledge graph
    kg_path = pack_dir / "baseline" / "knowledge_graph.json"
    if kg_path.exists():
        kg = json.loads(kg_path.read_text())
        lines.append("## Relationships")
        lines.append("")
        for edge in kg.get("items", []):
            src = edge.get("source", "")
            tgt = edge.get("target", "")
            rel = edge.get("relation", "")
            desc = edge.get("description", "")
            lines.append(f"- **{src}** --[{rel}]--> **{tgt}**: {desc}")
        lines.append("")

    # Extract rules from baseline
    rules_path = pack_dir / "baseline" / "rules.json"
    if rules_path.exists():
        rules = json.loads(rules_path.read_text())
        lines.append("## Diagnostic Rules")
        lines.append("")
        for rule in rules.get("items", []):
            rid = rule.get("id", "")
            symptom = rule.get("symptom", "")
            action = rule.get("action", "")
            lines.append(f"- **{rid}**: symptom={symptom} → action={action}")
        lines.append("")

    # Power rails from electrical graph
    eg_path = pack_dir / "electrical_graph.json"
    if eg_path.exists():
        eg = json.loads(eg_path.read_text())
        nodes = eg.get("nodes", [])
        rails = [n for n in nodes if n.get("type") == "rail"]
        components = [n for n in nodes if n.get("type") == "component"]
        lines.append("## Electrical Graph Summary")
        lines.append("")
        lines.append(f"- Total nodes: {len(nodes)}")
        lines.append(f"- Rails: {len(rails)}")
        lines.append(f"- Components: {len(components)}")
        lines.append("")
        if rails:
            lines.append("### Power Rails")
            lines.append("")
            for r in rails[:40]:
                rid = r.get("id", r.get("label", "?"))
                v = r.get("voltage", "?")
                lines.append(f"- {rid} ({v}V)")
            lines.append("")

    # Sources
    lines.append("## Sources")
    lines.append("")
    lines.append("- https://shop.mntre.com/products/reform-motherboard")
    lines.append("- https://source.mnt.re/reform/reform/-/blob/master/reform2-motherboard/")
    lines.append("- https://github.com/mntmn/reform/blob/master/reform2-motherboard/")
    lines.append("- https://www.ti.com/lit/ds/symlink/lm2677.pdf (U7)")
    lines.append("- https://www.ti.com/lit/ds/symlink/tlv62568.pdf (U13)")
    lines.append("- https://www.ti.com/lit/ds/symlink/lmr16006.pdf (U14)")
    lines.append("- https://www.diodes.com/assets/Datasheets/AP22815.pdf (U20)")
    lines.append("- https://www.vishay.com/docs/72056/si7461dp.pdf (Q3)")
    lines.append("")

    return "\n".join(lines)


async def main():
    t0 = time.time()
    settings = get_settings()
    client = AsyncAnthropic(
        api_key=settings.anthropic_api_key,
        base_url=settings.anthropic_base_url or None,
    )
    pack_dir = Path(settings.memory_root) / SLUG
    pack_dir.mkdir(parents=True, exist_ok=True)

    model_main = settings.anthropic_model_main
    model_sonnet = settings.anthropic_model_sonnet
    print(f"[rebuild] Starting rebuild for {SLUG}")
    print(f"[rebuild] Model main={model_main} sonnet={model_sonnet}")
    print(f"[rebuild] Pack dir: {pack_dir}")

    # ---- Phase 0: Generate dump from baseline ----
    print("\n[phase 0] Generating raw_research_dump.md from baseline + graph...")
    dump = generate_dump_from_baseline(pack_dir)
    dump_path = pack_dir / "raw_research_dump.md"
    dump_path.write_text(dump, encoding="utf-8")
    print(f"[phase 0] Written {len(dump)} chars to raw_research_dump.md")

    # ---- Load graph truth ----
    graph_truth = None
    eg_path = pack_dir / "electrical_graph.json"
    if eg_path.exists():
        try:
            eg = ElectricalGraph.model_validate_json(eg_path.read_text(encoding="utf-8"))
            graph_truth = GraphTruth(eg)
            print(f"[graph] Loaded GraphTruth: {len(graph_truth._components)} components, {len(graph_truth._nets)} nets")
        except Exception as e:
            print(f"[graph] Failed to load GraphTruth: {e}")

    # ---- Phase 1: Registry ----
    print("\n[phase 1] Running Registry...")
    t1 = time.time()
    registry_stats = PhaseTokenStats(phase="registry")
    registry = await run_registry_builder(
        client=client,
        model=model_sonnet,
        device_label=LABEL,
        raw_dump=dump,
        device_kind="laptop_logic_board",
        stats=registry_stats,
    )
    print(f"[phase 1] Registry done in {time.time()-t1:.1f}s · {len(registry.components)} components, {len(registry.signals)} signals")

    # Enrich registry from graph
    if graph_truth is not None:
        from api.pipeline.graph_truth import enrich_registry_from_graph
        added = enrich_registry_from_graph(registry, graph_truth)
        if added:
            print(f"[phase 1] Registry enriched from graph: +{len(added)} signals")

    # Save registry
    (pack_dir / "registry.json").write_text(registry.model_dump_json(indent=2), encoding="utf-8")
    print("[phase 1] Saved registry.json")

    # ---- Phase 2: Writers (parallel) ----
    print("\n[phase 2] Running Writers (Cartographe + Clinicien + Lexicographe)...")
    t2 = time.time()
    writer_stats: dict = {}
    kg, rules, dictionary = await run_writers_parallel(
        client=client,
        cartographe_model=model_main,
        clinicien_model=model_main,
        lexicographe_model=model_sonnet,
        device_label=LABEL,
        raw_dump=dump,
        registry=registry,
        writer_stats=writer_stats,
    )
    print(f"[phase 2] Writers done in {time.time()-t2:.1f}s")
    print(f"  - KnowledgeGraph: {len(kg.nodes)} nodes, {len(kg.edges)} edges")
    print(f"  - Rules: {len(rules.rules)} rules")
    print(f"  - Dictionary: {len(dictionary.entries)} entries")

    # Save writer outputs
    (pack_dir / "knowledge_graph.json").write_text(kg.model_dump_json(indent=2), encoding="utf-8")
    (pack_dir / "rules.json").write_text(rules.model_dump_json(indent=2), encoding="utf-8")
    (pack_dir / "dictionary.json").write_text(dictionary.model_dump_json(indent=2), encoding="utf-8")
    print("[phase 2] Saved knowledge_graph.json, rules.json, dictionary.json")

    # ---- Phase 3: Drift check ----
    print("\n[phase 3] Running drift check...")
    drift = compute_drift(
        registry=registry,
        knowledge_graph=kg,
        rules=rules,
        dictionary=dictionary,
        graph_truth=graph_truth,
    )
    print(f"[phase 3] Drift: {len(drift)} items")
    for d in drift[:5]:
        print(f"  - {d.file}: {d.reason}")

    # ---- Phase 4: Auditor ----
    print("\n[phase 4] Running Auditor...")
    t4 = time.time()

    # Build ground truth report if graph available
    ground_truth_report = None
    if graph_truth is not None:
        mentions = extract_mentions(registry, kg, rules, dictionary)
        ground_truth_report = build_ground_truth_report(graph_truth, mentions)
        print(f"[phase 4] Ground truth report: {len(ground_truth_report)} chars")

    audit_stats = PhaseTokenStats(phase="audit")
    verdict = await run_auditor(
        client=client,
        model=model_main,
        device_label=LABEL,
        registry=registry,
        knowledge_graph=kg,
        rules=rules,
        dictionary=dictionary,
        precomputed_drift=drift,
        graph_truth=graph_truth,
        ground_truth_report=ground_truth_report,
        stats=audit_stats,
    )
    print(f"[phase 4] Auditor done in {time.time()-t4:.1f}s")

    # Save verdict
    (pack_dir / "audit_verdict.json").write_text(verdict.model_dump_json(indent=2), encoding="utf-8")
    print(f"[phase 4] Saved audit_verdict.json · verdict={verdict.verdict}")

    elapsed = time.time() - t0
    print(f"\n{'='*60}")
    print(f"[rebuild] COMPLETE in {elapsed:.1f}s")
    print(f"[rebuild] Verdict: {verdict.verdict}")

    # List all files
    print(f"\n[rebuild] Files in pack:")
    for f in sorted(pack_dir.rglob("*")):
        if f.is_file() and f.suffix in (".json", ".md"):
            size = f.stat().st_size
            print(f"  {f.relative_to(pack_dir)} ({size:,} bytes)")


if __name__ == "__main__":
    asyncio.run(main())
