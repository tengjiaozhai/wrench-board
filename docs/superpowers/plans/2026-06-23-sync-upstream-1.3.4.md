# Sync Upstream v1.3.4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backport all upstream changes from Junkz3/wrench-board v1.3.4 into the local fork, preserving local additions (Chinese i18n, SMT-V551 board, dev-memory docs).

**Architecture:** 5-phase rollout. Phase 1: core backend (qa/graph_coverage + 3 new tools). Phase 2: board-delta agent + semantic search. Phase 3: schematic pipeline + Rust crates. Phase 4: deployment + toolchain. Phase 5: frontend reorg. Each phase is a single commit, independently testable and revertable.

**Tech Stack:** Python 3.11+, FastAPI, Pydantic v2, pytest, Rust (PyO3/maturin), vanilla HTML/CSS/JS (ES modules)

**Spec:** `docs/superpowers/specs/2026-06-23-sync-upstream-1.3.4-design.md`

---

## File Structure Overview

### Phase 1 (Core Backend)

| File | Action | Responsibility |
|------|--------|----------------|
| `api/pipeline/qa/__init__.py` | Create | Package init |
| `api/pipeline/qa/graph_coverage.py` | Create | Graph↔boardview coverage gate |
| `api/agent/recall.py` | Create | Direct-mode memory recall (3 wrapper tools) |
| `api/agent/board_ref.py` | Create | Global board reference setter |
| `api/agent/manifest.py` | Modify | Add 3 new tool definitions (+110 lines) |
| `api/agent/tools.py` | Modify | Add 3 new tool implementations (+84 lines) |
| `api/agent/memory_seed.py` | Modify | Add seed data loading (+78 lines) |
| `tests/pipeline/qa/__init__.py` | Create | Test package init |
| `tests/pipeline/qa/test_graph_coverage.py` | Create | Coverage gate tests |
| `tests/agent/test_recall.py` | Create | Recall tool tests |

### Phase 2 (Board-Delta + Semantic Search)

| File | Action | Responsibility |
|------|--------|----------------|
| `api/pipeline/board_delta/__init__.py` | Create | Package init |
| `api/pipeline/board_delta/agent.py` | Create | Board-delta agent (web search) |
| `api/pipeline/board_delta/prompts.py` | Create | Board-delta prompts |
| `api/pipeline/board_delta/schemas.py` | Create | DeltaBoard Pydantic model |
| `api/pipeline/board_delta/store.py` | Create | Board-delta storage |
| `api/pipeline/routes/board_delta.py` | Create | HTTP endpoint |
| `api/agent/cousin_hint.py` | Create | Sister-board hints |
| `api/agent/owner_ref.py` | Create | Multi-tenant context (ContextVar) |
| `api/agent/session_caps.py` | Create | Session limits |
| `api/agent/cloud_metering.py` | Create | Token usage reporting |
| `api/pipeline/expansion.py` | Rewrite | Major expansion (+537 lines) |
| `api/pipeline/graph_truth.py` | Create | Graph truth validation |
| `api/pipeline/live_graph.py` | Create | Live graph updates |
| `api/pipeline/models.py` | Create | Pipeline models |
| `api/pipeline/pack_lint.py` | Create | Pack linting |
| `api/pipeline/pack_migrate.py` | Create | Pack migration |
| `api/pipeline/pack_sanitizer.py` | Create | Pack sanitization |
| `api/pipeline/pack_storage.py` | Create | Pack storage |
| `api/pipeline/patch.py` | Create | Pipeline patch flow |
| `api/pipeline/reconcile.py` | Create | Reconciliation |
| `api/pipeline/routes/packs.py` | Rewrite | Pack routes (+509 lines) |
| `api/pipeline/routes/repairs.py` | Rewrite | Repair routes (+718 lines) |
| `api/pipeline/routes/documents.py` | Rewrite | Document routes (+298 lines) |
| `api/pipeline/schemas.py` | Rewrite | Pipeline schemas (+419 lines) |
| `tests/pipeline/board_delta/` | Create | Board-delta tests |
| `tests/pipeline/test_pack_*.py` | Create | Pack management tests |

### Phase 3 (Schematic + Rust)

| File | Action | Responsibility |
|------|--------|----------------|
| `api/pipeline/schematic/batch_vision.py` | Create | Batch vision API |
| `api/pipeline/schematic/orchestrator.py` | Rewrite | Schematic orchestrator (+491 lines) |
| `api/pipeline/schematic/compiler.py` | Rewrite | Electrical graph compiler (+342 lines) |
| `api/pipeline/schematic/page_vision.py` | Rewrite | Page vision (+216 lines) |
| `api/pipeline/schematic/renderer.py` | Rewrite | PDF renderer (+192 lines) |
| `api/pipeline/schematic/grounding.py` | Rewrite | Grounding extraction (+110 lines) |
| `api/pipeline/schematic/boot_analyzer.py` | Modify | Boot analyzer (+32 lines) |
| `api/pipeline/schematic/hypothesize.py` | Modify | Hypothesizer (+17 lines) |
| `api/pipeline/schematic/merger.py` | Modify | Page merger (+32 lines) |
| `api/pipeline/schematic/schemas.py` | Modify | Schematic schemas (+45 lines) |
| `api/pipeline/schematic/cli.py` | Modify | CLI (+5 lines) |
| `rust/wb_fz_cipher/` | Create | Rust FZ cipher crate |
| `rust/wb_tvw_walker/` | Create | Rust TVW walker crate |
| `api/board/parser/_fz_engine/cipher.py` | Modify | FZ cipher (+24 lines) |
| `api/board/parser/_tvw_engine/walker.py` | Rewrite | TVW walker (+123 lines) |
| `api/pipeline/orchestrator.py` | Rewrite | Pipeline orchestrator (+733 lines) |
| `api/pipeline/writers.py` | Rewrite | Writers (+363 lines) |
| `api/pipeline/tool_call.py` | Rewrite | Tool call (+443 lines) |
| `api/pipeline/prompts.py` | Modify | Prompts (+128 lines) |
| `api/pipeline/scout.py` | Modify | Scout (+30 lines) |
| `api/pipeline/graph_transform.py` | Modify | Graph transform (+23 lines) |
| `api/pipeline/registry.py` | Modify | Registry (+8 lines) |
| `tests/pipeline/schematic/test_batch_vision.py` | Create | Batch vision tests |
| `tests/rust/test_fz_cipher.py` | Create | FZ cipher tests |
| `tests/rust/test_tvw_walker.py` | Create | TVW walker tests |

### Phase 4 (Deployment + Toolchain)

| File | Action | Responsibility |
|------|--------|----------------|
| `Dockerfile` | Create | Docker image |
| `.dockerignore` | Create | Docker ignore |
| `scripts/doctor.py` | Create | 8 health checks |
| `scripts/check_web_imports.py` | Create | ESM import validator |
| `scripts/eval_all.py` | Create | 4-eval orchestrator |
| `api/http_security.py` | Create | HTTP service-token middleware |
| `api/_token_check.py` | Create | Bearer token extraction |
| `api/env_bootstrap.py` | Create | .env → os.environ bridge |
| `api/ws_security.py` | Modify | Add `enforce_ws_service_token` |
| `api/config.py` | Modify | Add cloud fields + model 4.8 |
| `api/main.py` | Rewrite | Add middleware + env bootstrap |
| `api/cli/pack_admin.py` | Create | Pack admin CLI |
| `pyproject.toml` | Modify | License, author, URLs, numpy |
| `Makefile` | Modify | Add `check-web` target |
| `tests/test_http_security.py` | Create | HTTP security tests |
| `tests/test_token_check.py` | Create | Token check tests |
| `tests/test_env_bootstrap.py` | Create | Env bootstrap tests |
| `tests/test_progress_ws_token.py` | Create | WS token tests |

### Phase 5 (Frontend Reorg)

| File | Action | Responsibility |
|------|--------|----------------|
| `web/js/features/global/landing/` | Create | Landing page modules (6 files) |
| `web/js/features/repair/diagnostic/` | Create | Diagnostic modules (8 files) |
| `web/js/features/repair/workspace.js` | Create | Repair workspace |
| `web/js/services/` | Create | Service modules (5 files) |
| `web/js/shared/` | Create | Shared utilities (3 files) |
| `web/js/store.js` | Create | Global store |
| `web/js/onboarding_state.js` | Create | Onboarding state machine |
| `web/js/mascot_*.js` | Create | Mascot modules (3 files) |
| `web/js/info_modal.js` | Create | Info modal |
| `web/js/cloud_hints.js` | Create | Cloud hints |
| `web/mascot_gallery.html` | Create | Mascot gallery page |
| `web/styles/onboarding.css` | Create | Onboarding styles (649 lines) |
| `web/styles/mascot_gallery.css` | Create | Mascot gallery styles (130 lines) |
| `web/demos/` | Create | Demo directory |
| `fixtures/demo-packs/mnt-reform-motherboard/` | Create | Demo pack (~5,000 lines) |
| `README.fr.md`, `README.hi.md`, `README.zh.md` | Create | Multi-language READMEs |
| `docs/assets/og-card.png` | Create | OpenGraph card |
| **Phase 5b (delete legacy):** | | |
| `web/brd_viewer.js` | Delete | Legacy D3 fallback |
| `web/js/home.js`, `landing.js`, `stock.js` | Delete | Legacy JS |
| `web/styles/brd.css`, `brd_minimap.css`, `home.css`, `landing.css`, `stock.css` | Delete | Legacy CSS |

---

## Phase 1: Core Backend (Isolated, Low Risk)

### Task 1: Create qa/graph_coverage.py

**Files:**
- Create: `api/pipeline/qa/__init__.py`
- Create: `api/pipeline/qa/graph_coverage.py`
- Test: `tests/pipeline/qa/test_graph_coverage.py`

- [ ] **Step 1: Create package init**

```python
# api/pipeline/qa/__init__.py
"""QA gates for the knowledge pipeline."""
```

- [ ] **Step 2: Write failing test for coverage gate**

```python
# tests/pipeline/qa/test_graph_coverage.py
import pytest
from pathlib import Path
from api.pipeline.qa.graph_coverage import CoverageReport, compute_coverage

def test_compute_coverage_pass():
    # Mock data: 100 nets in boardview, 95 in graph, 3 missing-critical
    board_nets = [f"NET_{i}" for i in range(100)]
    graph_nets = board_nets[:95]
    board_components = ["U1", "C1", "R1", "L1", "F1"]
    graph_components = ["U1", "C1", "R1", "L1"]
    
    report = compute_coverage(
        board_nets=board_nets,
        graph_nets=graph_nets,
        board_components=board_components,
        graph_components=graph_components,
    )
    
    assert report.net_coverage == 0.95
    assert report.component_coverage == 0.8
    assert report.missing_components == ["F1"]
    assert report.verdict == "PASS"  # nets ≥ 0.90, missing-critical ≤ 8
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pytest tests/pipeline/qa/test_graph_coverage.py::test_compute_coverage_pass -v
```

Expected: FAIL with "ModuleNotFoundError: No module named 'api.pipeline.qa'"

- [ ] **Step 4: Implement graph_coverage.py**

Copy from upstream:

```bash
git remote add junkz3 https://github.com/Junkz3/wrench-board.git
git fetch junkz3 main --depth=1
git checkout junkz3/main -- api/pipeline/qa/__init__.py
git checkout junkz3/main -- api/pipeline/qa/graph_coverage.py
git remote remove junkz3
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pytest tests/pipeline/qa/test_graph_coverage.py -v
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add api/pipeline/qa/ tests/pipeline/qa/
git commit -m "feat(pipeline): add qa/graph_coverage gate"
```

### Task 2: Add 3 new agent tools

**Files:**
- Modify: `api/agent/manifest.py`
- Modify: `api/agent/tools.py`
- Create: `api/agent/recall.py`
- Test: `tests/agent/test_recall.py`

- [ ] **Step 1: Write failing test for recall tools**

```python
# tests/agent/test_recall.py
import pytest
from pathlib import Path
from api.agent.recall import recall_field_reports, search_patterns, search_playbooks

def test_recall_field_reports_empty():
    result = recall_field_reports(device_slug="nonexistent", query="test")
    assert result == []

def test_search_patterns_empty():
    result = search_patterns(query="nonexistent")
    assert result == []

def test_search_playbooks_empty():
    result = search_playbooks(query="nonexistent")
    assert result == []
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pytest tests/agent/test_recall.py -v
```

Expected: FAIL with "ModuleNotFoundError: No module named 'api.agent.recall'"

- [ ] **Step 3: Fetch recall.py from upstream**

```bash
git remote add junkz3 https://github.com/Junkz3/wrench-board.git
git fetch junkz3 main --depth=1
git checkout junkz3/main -- api/agent/recall.py
git remote remove junkz3
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pytest tests/agent/test_recall.py -v
```

Expected: PASS

- [ ] **Step 5: Update manifest.py with 3 new tools**

Fetch from upstream:

```bash
git remote add junkz3 https://github.com/Junkz3/wrench-board.git
git fetch junkz3 main --depth=1
git checkout junkz3/main -- api/agent/manifest.py
git checkout junkz3/main -- api/agent/tools.py
git checkout junkz3/main -- api/agent/memory_seed.py
git remote remove junkz3
```

- [ ] **Step 6: Run full test suite**

```bash
make test
```

Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add api/agent/ tests/agent/
git commit -m "feat(agent): add mb_recall_field_reports, mb_search_patterns, mb_search_playbooks tools"
```

### Task 3: Add board_ref.py

**Files:**
- Create: `api/agent/board_ref.py`

- [ ] **Step 1: Fetch board_ref.py from upstream**

```bash
git remote add junkz3 https://github.com/Junkz3/wrench-board.git
git fetch junkz3 main --depth=1
git checkout junkz3/main -- api/agent/board_ref.py
git remote remove junkz3
```

- [ ] **Step 2: Verify no import errors**

```bash
python -c "from api.agent.board_ref import set_board_ref; print('OK')"
```

Expected: "OK"

- [ ] **Step 3: Commit**

```bash
git add api/agent/board_ref.py
git commit -m "feat(agent): add board_ref module"
```

### Task 4: Phase 1 acceptance

- [ ] **Step 1: Run full test suite**

```bash
make test
```

Expected: All tests pass

- [ ] **Step 2: Verify graph_coverage runs**

```bash
python -c "from api.pipeline.qa.graph_coverage import compute_coverage; print('OK')"
```

Expected: "OK"

- [ ] **Step 3: Verify 3 new tools are registered**

```bash
python -c "from api.agent.manifest import build_tools_manifest; from api.session.state import SessionState; s = SessionState(); tools = build_tools_manifest(s); names = [t['name'] for t in tools]; assert 'mb_recall_field_reports' in names; assert 'mb_search_patterns' in names; assert 'mb_search_playbooks' in names; print('OK')"
```

Expected: "OK"

**Phase 1 complete.** Proceed to Phase 2.

---

## Phase 2: Board-Delta Agent + Semantic Search

### Task 5: Create board_delta module

**Files:**
- Create: `api/pipeline/board_delta/__init__.py`
- Create: `api/pipeline/board_delta/agent.py`
- Create: `api/pipeline/board_delta/prompts.py`
- Create: `api/pipeline/board_delta/schemas.py`
- Create: `api/pipeline/board_delta/store.py`
- Create: `api/pipeline/routes/board_delta.py`
- Test: `tests/pipeline/board_delta/test_agent.py`

- [ ] **Step 1: Fetch board_delta from upstream**

```bash
git remote add junkz3 https://github.com/Junkz3/wrench-board.git
git fetch junkz3 main --depth=1
git checkout junkz3/main -- api/pipeline/board_delta/
git checkout junkz3/main -- api/pipeline/routes/board_delta.py
git checkout junkz3/main -- tests/pipeline/board_delta/
git remote remove junkz3
```

- [ ] **Step 2: Run tests**

```bash
pytest tests/pipeline/board_delta/ -v
```

Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add api/pipeline/board_delta/ api/pipeline/routes/board_delta.py tests/pipeline/board_delta/
git commit -m "feat(pipeline): add board_delta agent"
```

### Task 6: Add multi-tenant modules

**Files:**
- Create: `api/agent/cousin_hint.py`
- Create: `api/agent/owner_ref.py`
- Create: `api/agent/session_caps.py`
- Create: `api/agent/cloud_metering.py`

- [ ] **Step 1: Fetch multi-tenant modules from upstream**

```bash
git remote add junkz3 https://github.com/Junkz3/wrench-board.git
git fetch junkz3 main --depth=1
git checkout junkz3/main -- api/agent/cousin_hint.py
git checkout junkz3/main -- api/agent/owner_ref.py
git checkout junkz3/main -- api/agent/session_caps.py
git checkout junkz3/main -- api/agent/cloud_metering.py
git remote remove junkz3
```

- [ ] **Step 2: Verify no import errors**

```bash
python -c "from api.agent.owner_ref import set_owner_ref, current_owner_ref; print('OK')"
```

Expected: "OK"

- [ ] **Step 3: Commit**

```bash
git add api/agent/cousin_hint.py api/agent/owner_ref.py api/agent/session_caps.py api/agent/cloud_metering.py
git commit -m "feat(agent): add multi-tenant modules (owner_ref, session_caps, cloud_metering, cousin_hint)"
```

### Task 7: Rewrite pipeline modules

**Files:**
- Rewrite: `api/pipeline/expansion.py`
- Create: `api/pipeline/graph_truth.py`
- Create: `api/pipeline/live_graph.py`
- Create: `api/pipeline/models.py`
- Create: `api/pipeline/pack_lint.py`
- Create: `api/pipeline/pack_migrate.py`
- Create: `api/pipeline/pack_sanitizer.py`
- Create: `api/pipeline/pack_storage.py`
- Create: `api/pipeline/patch.py`
- Create: `api/pipeline/reconcile.py`
- Rewrite: `api/pipeline/routes/packs.py`
- Rewrite: `api/pipeline/routes/repairs.py`
- Rewrite: `api/pipeline/routes/documents.py`
- Rewrite: `api/pipeline/schemas.py`
- Test: `tests/pipeline/test_pack_*.py`

- [ ] **Step 1: Fetch pipeline modules from upstream**

```bash
git remote add junkz3 https://github.com/Junkz3/wrench-board.git
git fetch junkz3 main --depth=1
git checkout junkz3/main -- api/pipeline/expansion.py
git checkout junkz3/main -- api/pipeline/graph_truth.py
git checkout junkz3/main -- api/pipeline/live_graph.py
git checkout junkz3/main -- api/pipeline/models.py
git checkout junkz3/main -- api/pipeline/pack_lint.py
git checkout junkz3/main -- api/pipeline/pack_migrate.py
git checkout junkz3/main -- api/pipeline/pack_sanitizer.py
git checkout junkz3/main -- api/pipeline/pack_storage.py
git checkout junkz3/main -- api/pipeline/patch.py
git checkout junkz3/main -- api/pipeline/reconcile.py
git checkout junkz3/main -- api/pipeline/routes/packs.py
git checkout junkz3/main -- api/pipeline/routes/repairs.py
git checkout junkz3/main -- api/pipeline/routes/documents.py
git checkout junkz3/main -- api/pipeline/schemas.py
git checkout junkz3/main -- tests/pipeline/test_pack_*.py
git remote remove junkz3
```

- [ ] **Step 2: Run full test suite**

```bash
make test
```

Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add api/pipeline/ tests/pipeline/
git commit -m "feat(pipeline): rewrite pack management + add graph_truth, live_graph, reconcile"
```

### Task 8: Phase 2 acceptance

- [ ] **Step 1: Run full test suite**

```bash
make test
```

Expected: All tests pass

- [ ] **Step 2: Verify board_delta endpoint**

```bash
python -c "from api.pipeline.routes.board_delta import router; print('OK')"
```

Expected: "OK"

**Phase 2 complete.** Proceed to Phase 3.

---

## Phase 3: Schematic Pipeline + Rust Crates

### Task 9: Rewrite schematic pipeline

**Files:**
- Create: `api/pipeline/schematic/batch_vision.py`
- Rewrite: `api/pipeline/schematic/orchestrator.py`
- Rewrite: `api/pipeline/schematic/compiler.py`
- Rewrite: `api/pipeline/schematic/page_vision.py`
- Rewrite: `api/pipeline/schematic/renderer.py`
- Rewrite: `api/pipeline/schematic/grounding.py`
- Modify: `api/pipeline/schematic/boot_analyzer.py`
- Modify: `api/pipeline/schematic/hypothesize.py`
- Modify: `api/pipeline/schematic/merger.py`
- Modify: `api/pipeline/schematic/schemas.py`
- Modify: `api/pipeline/schematic/cli.py`
- Test: `tests/pipeline/schematic/test_batch_vision.py`

- [ ] **Step 1: Fetch schematic modules from upstream**

```bash
git remote add junkz3 https://github.com/Junkz3/wrench-board.git
git fetch junkz3 main --depth=1
git checkout junkz3/main -- api/pipeline/schematic/
git checkout junkz3/main -- tests/pipeline/schematic/test_batch_vision.py
git remote remove junkz3
```

- [ ] **Step 2: Run tests**

```bash
pytest tests/pipeline/schematic/ -v
```

Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add api/pipeline/schematic/ tests/pipeline/schematic/
git commit -m "feat(schematic): rewrite pipeline + add batch_vision"
```

### Task 10: Create Rust crates

**Files:**
- Create: `rust/wb_fz_cipher/Cargo.toml`
- Create: `rust/wb_fz_cipher/pyproject.toml`
- Create: `rust/wb_fz_cipher/src/lib.rs`
- Create: `rust/wb_tvw_walker/Cargo.toml`
- Create: `rust/wb_tvw_walker/pyproject.toml`
- Create: `rust/wb_tvw_walker/src/lib.rs`
- Modify: `api/board/parser/_fz_engine/cipher.py`
- Modify: `api/board/parser/_tvw_engine/walker.py`
- Test: `tests/rust/test_fz_cipher.py`
- Test: `tests/rust/test_tvw_walker.py`

- [ ] **Step 1: Fetch Rust crates from upstream**

```bash
git remote add junkz3 https://github.com/Junkz3/wrench-board.git
git fetch junkz3 main --depth=1
git checkout junkz3/main -- rust/
git checkout junkz3/main -- api/board/parser/_fz_engine/cipher.py
git checkout junkz3/main -- api/board/parser/_tvw_engine/walker.py
git checkout junkz3/main -- tests/rust/
git remote remove junkz3
```

- [ ] **Step 2: Build Rust crates (if cargo available)**

```bash
cd rust/wb_fz_cipher && maturin develop --release
cd ../wb_tvw_walker && maturin develop --release
```

Expected: Build succeeds (or skip if no cargo)

- [ ] **Step 3: Run tests**

```bash
pytest tests/rust/ -v
```

Expected: All tests pass (or skip if no cargo)

- [ ] **Step 4: Commit**

```bash
git add rust/ api/board/parser/ tests/rust/
git commit -m "feat(parser): add Rust crates for FZ cipher and TVW walker"
```

### Task 11: Rewrite core pipeline modules

**Files:**
- Rewrite: `api/pipeline/orchestrator.py`
- Rewrite: `api/pipeline/writers.py`
- Rewrite: `api/pipeline/tool_call.py`
- Modify: `api/pipeline/prompts.py`
- Modify: `api/pipeline/scout.py`
- Modify: `api/pipeline/graph_transform.py`
- Modify: `api/pipeline/registry.py`

- [ ] **Step 1: Fetch core pipeline modules from upstream**

```bash
git remote add junkz3 https://github.com/Junkz3/wrench-board.git
git fetch junkz3 main --depth=1
git checkout junkz3/main -- api/pipeline/orchestrator.py
git checkout junkz3/main -- api/pipeline/writers.py
git checkout junkz3/main -- api/pipeline/tool_call.py
git checkout junkz3/main -- api/pipeline/prompts.py
git checkout junkz3/main -- api/pipeline/scout.py
git checkout junkz3/main -- api/pipeline/graph_transform.py
git checkout junkz3/main -- api/pipeline/registry.py
git remote remove junkz3
```

- [ ] **Step 2: Run full test suite**

```bash
make test
```

Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add api/pipeline/
git commit -m "feat(pipeline): rewrite orchestrator, writers, tool_call"
```

### Task 12: Phase 3 acceptance

- [ ] **Step 1: Run full test suite**

```bash
make test
```

Expected: All tests pass

- [ ] **Step 2: Verify batch_vision can be invoked**

```bash
python -c "from api.pipeline.schematic.batch_vision import run_batch_vision; print('OK')"
```

Expected: "OK"

**Phase 3 complete.** Proceed to Phase 4.

---

## Phase 4: Deployment + Toolchain

### Task 13: Add security modules

**Files:**
- Create: `api/http_security.py`
- Create: `api/_token_check.py`
- Create: `api/env_bootstrap.py`
- Modify: `api/ws_security.py`
- Modify: `api/config.py`
- Test: `tests/test_http_security.py`
- Test: `tests/test_token_check.py`
- Test: `tests/test_env_bootstrap.py`

- [ ] **Step 1: Fetch security modules from upstream**

```bash
git remote add junkz3 https://github.com/Junkz3/wrench-board.git
git fetch junkz3 main --depth=1
git checkout junkz3/main -- api/http_security.py
git checkout junkz3/main -- api/_token_check.py
git checkout junkz3/main -- api/env_bootstrap.py
git checkout junkz3/main -- api/ws_security.py
git checkout junkz3/main -- api/config.py
git checkout junkz3/main -- tests/test_http_security.py
git checkout junkz3/main -- tests/test_token_check.py
git checkout junkz3/main -- tests/test_env_bootstrap.py
git remote remove junkz3
```

- [ ] **Step 2: Run tests**

```bash
pytest tests/test_http_security.py tests/test_token_check.py tests/test_env_bootstrap.py -v
```

Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add api/http_security.py api/_token_check.py api/env_bootstrap.py api/ws_security.py api/config.py tests/test_http_security.py tests/test_token_check.py tests/test_env_bootstrap.py
git commit -m "feat(security): add http_security, token_check, env_bootstrap"
```

### Task 14: Rewrite main.py

**Files:**
- Rewrite: `api/main.py`

- [ ] **Step 1: Fetch main.py from upstream**

```bash
git remote add junkz3 https://github.com/Junkz3/wrench-board.git
git fetch junkz3 main --depth=1
git checkout junkz3/main -- api/main.py
git remote remove junkz3
```

- [ ] **Step 2: Verify server starts**

```bash
timeout 5 make run || true
```

Expected: Server starts without errors

- [ ] **Step 3: Commit**

```bash
git add api/main.py
git commit -m "feat(main): rewrite with ServiceTokenMiddleware + env_bootstrap"
```

### Task 15: Add deployment files

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `scripts/doctor.py`
- Create: `scripts/check_web_imports.py`
- Create: `scripts/eval_all.py`
- Create: `api/cli/pack_admin.py`
- Modify: `pyproject.toml`
- Modify: `Makefile`

- [ ] **Step 1: Fetch deployment files from upstream**

```bash
git remote add junkz3 https://github.com/Junkz3/wrench-board.git
git fetch junkz3 main --depth=1
git checkout junkz3/main -- Dockerfile
git checkout junkz3/main -- .dockerignore
git checkout junkz3/main -- scripts/doctor.py
git checkout junkz3/main -- scripts/check_web_imports.py
git checkout junkz3/main -- scripts/eval_all.py
git checkout junkz3/main -- api/cli/pack_admin.py
git checkout junkz3/main -- pyproject.toml
git checkout junkz3/main -- Makefile
git remote remove junkz3
```

- [ ] **Step 2: Run make doctor**

```bash
make doctor
```

Expected: 8 health checks pass

- [ ] **Step 3: Run make check-web**

```bash
make check-web
```

Expected: ESM imports validated

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore scripts/ api/cli/ pyproject.toml Makefile
git commit -m "feat(deploy): add Dockerfile, doctor, check-web, eval_all"
```

### Task 16: Phase 4 acceptance

- [ ] **Step 1: Run full test suite**

```bash
make test
```

Expected: All tests pass

- [ ] **Step 2: Verify config default model is 4.8**

```bash
python -c "from api.config import get_settings; s = get_settings(); assert s.anthropic_model_main == 'claude-opus-4-8'; print('OK')"
```

Expected: "OK"

- [ ] **Step 3: Verify Docker image builds**

```bash
docker build -t wrench-board:test .
```

Expected: Build succeeds

**Phase 4 complete.** Proceed to Phase 5.

---

## Phase 5: Frontend Reorg

### Task 17: Add new frontend structure

**Files:**
- Create: `web/js/features/` (14 files)
- Create: `web/js/services/` (5 files)
- Create: `web/js/shared/` (3 files)
- Create: `web/js/store.js`
- Create: `web/js/onboarding_state.js`
- Create: `web/js/mascot_*.js` (3 files)
- Create: `web/js/info_modal.js`
- Create: `web/js/cloud_hints.js`
- Create: `web/mascot_gallery.html`
- Create: `web/styles/onboarding.css`
- Create: `web/styles/mascot_gallery.css`
- Create: `web/demos/`
- Create: `fixtures/demo-packs/mnt-reform-motherboard/`
- Create: `README.fr.md`, `README.hi.md`, `README.zh.md`
- Create: `docs/assets/og-card.png`

- [ ] **Step 1: Fetch frontend files from upstream**

```bash
git remote add junkz3 https://github.com/Junkz3/wrench-board.git
git fetch junkz3 main --depth=1
git checkout junkz3/main -- web/js/features/
git checkout junkz3/main -- web/js/services/
git checkout junkz3/main -- web/js/shared/
git checkout junkz3/main -- web/js/store.js
git checkout junkz3/main -- web/js/onboarding_state.js
git checkout junkz3/main -- web/js/mascot_bubble.js
git checkout junkz3/main -- web/js/mascot_gallery.js
git checkout junkz3/main -- web/js/mascot_states.js
git checkout junkz3/main -- web/js/info_modal.js
git checkout junkz3/main -- web/js/cloud_hints.js
git checkout junkz3/main -- web/mascot_gallery.html
git checkout junkz3/main -- web/styles/onboarding.css
git checkout junkz3/main -- web/styles/mascot_gallery.css
git checkout junkz3/main -- web/demos/
git checkout junkz3/main -- fixtures/demo-packs/mnt-reform-motherboard/
git checkout junkz3/main -- README.fr.md
git checkout junkz3/main -- README.hi.md
git checkout junkz3/main -- README.zh.md
git checkout junkz3/main -- docs/assets/og-card.png
git remote remove junkz3
```

- [ ] **Step 2: Run make check-web**

```bash
make check-web
```

Expected: ESM imports validated

- [ ] **Step 3: Commit**

```bash
git add web/ fixtures/ README.fr.md README.hi.md README.zh.md docs/assets/og-card.png
git commit -m "feat(web): add features/services/shared structure + mascot gallery + onboarding"
```

### Task 18: Delete legacy frontend files

**Files:**
- Delete: `web/brd_viewer.js`
- Delete: `web/js/home.js`
- Delete: `web/js/landing.js`
- Delete: `web/js/stock.js`
- Delete: `web/styles/brd.css`
- Delete: `web/styles/brd_minimap.css`
- Delete: `web/styles/home.css`
- Delete: `web/styles/landing.css`
- Delete: `web/styles/stock.css`

- [ ] **Step 1: Delete legacy files**

```bash
git rm web/brd_viewer.js
git rm web/js/home.js
git rm web/js/landing.js
git rm web/js/stock.js
git rm web/styles/brd.css
git rm web/styles/brd_minimap.css
git rm web/styles/home.css
git rm web/styles/landing.css
git rm web/styles/stock.css
```

- [ ] **Step 2: Run make check-web**

```bash
make check-web
```

Expected: ESM imports validated (no broken references to deleted files)

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(web): remove legacy brd_viewer, home, landing, stock"
```

### Task 19: Phase 5 acceptance

- [ ] **Step 1: Run full test suite**

```bash
make test
```

Expected: All tests pass

- [ ] **Step 2: Run make check-web**

```bash
make check-web
```

Expected: ESM imports validated

- [ ] **Step 3: Manually verify web UI**

Open browser to `http://localhost:8000` and verify:
- Landing page loads
- Diagnostic chat works
- Mascot gallery accessible
- 4 languages work (en/fr/hi/zh)

**Phase 5 complete. All phases done.**

---

## Final Acceptance

- [ ] **Run full test suite**

```bash
make test
```

Expected: All tests pass

- [ ] **Run make doctor**

```bash
make doctor
```

Expected: 8 health checks pass

- [ ] **Run make check-web**

```bash
make check-web
```

Expected: ESM imports validated

- [ ] **Verify local additions preserved**

```bash
ls web/i18n/_modules/*.zh.json | wc -l
```

Expected: 16

```bash
ls board_assets/smt-v551.brd
```

Expected: File exists

```bash
ls api/pipeline/phase_narrator.py
```

Expected: File exists

**Sync complete.**
