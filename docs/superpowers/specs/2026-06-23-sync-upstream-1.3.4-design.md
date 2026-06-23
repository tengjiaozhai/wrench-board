# Design: Sync Upstream Junkz3/wrench-board v1.3.4

**Date:** 2026-06-23
**Status:** Draft
**Scope:** Backport all upstream changes from Junkz3/wrench-board v1.3.4 into the local fork, preserving local additions (Chinese i18n, SMT-V551 board, dev-memory docs).

---

## 1. Goals and Non-Goals

### Goals

- Sync the local fork with upstream Junkz3/wrench-board v1.3.4 (`60facc0`).
- Preserve all local additions: Chinese i18n (`web/i18n/_modules/*.zh.json`), SMT-V551 board assets, dev-memory docs, `phase_narrator.py`.
- Adopt upstream's adaptation strategy: hard-copy verbatim + thin adapter layer for multi-tenant code.
- Deliver in 5 phased commits, each independently testable and revertable.

### Non-Goals

- Upstream's evolve skill (no material difference; local already has it).
- Upstream's README translations (local has Chinese i18n via runtime switch, not separate README files).
- Upstream's dev-memory docs (local has its own).
- Upstream's internal board assets (SMT-V551 is local-only).
- Changing the evolve loop count (upstream README claims 4 loops, but skill file only defines 1; keep local's 1 loop).

---

## 2. Scope

### 2.1 In Scope

| Category | Files | Lines Changed |
|----------|-------|---------------|
| **api/agent/** | 18 files | +1,847 / -213 |
| **api/pipeline/** | 54 files | +9,397 / -1,130 |
| **api/board/parser/** | 37 files | +3,227 / -785 |
| **api/ (top-level)** | 4 new files | ~500 lines |
| **rust/** | 2 crates | ~1,000 lines |
| **scripts/** | 3 new scripts | ~600 lines |
| **web/** | ~30 new files, ~5 deleted | ~10,000 lines |
| **fixtures/** | 1 demo pack | ~5,000 lines |
| **config** | pyproject.toml, Makefile, config.py | ~200 lines |
| **Total** | ~150 files | ~32,000 lines |

### 2.2 Out of Scope (Preserved Local Additions)

| Local Addition | Reason |
|----------------|--------|
| `web/i18n/_modules/*.zh.json` (16 files) | Chinese UI strings (upstream has README.zh.md but no runtime i18n) |
| `web/js/stock.js`, `web/js/home.js`, `web/js/landing.js` | Legacy JS (upstream deleted; local keeps until frontend reorg phase) |
| `web/brd_viewer.js` | Legacy D3 fallback (upstream deleted; local keeps until WebGL viewer is stable) |
| `api/pipeline/phase_narrator.py` | Local addition (upstream deleted; local keeps for pipeline narration UI) |
| `board_assets/smt-v551.brd` | Private board asset |
| `memory/smt-v551/` | Private memory |
| `docs/dev-memory/` | Internal dev notes |
| `docs/superpowers/specs/` | Local specs |
| `scripts/check_i18n_keys.py` | Local i18n validator |

---

## 3. Current State Assessment

### 3.1 Already Matches Upstream (No Change Needed)

- `LICENSE` — already Proprietary (0 diff)
- `api/agent/seed_data/` — already matches (README + global_patterns/ + global_playbooks/)
- `api/agent/_session_mirrors.py` — already matches

### 3.2 Model Version

- Current: `claude-opus-4-7` (default in config.py)
- Upstream: `claude-opus-4-8`
- **Change needed:** config.py default model → 4.8

### 3.3 Multi-Tenant Code (Adapter Layer Strategy)

Upstream added cloud-gateway code for multi-tenant deployment:
- `api/agent/owner_ref.py` — per-session tenant context (ContextVar)
- `api/agent/cloud_metering.py` — token usage reporting to cloud
- `api/agent/session_caps.py` — session limits
- `api/http_security.py` — HTTP service-token middleware
- `api/ws_security.py` — extended with `enforce_ws_service_token`
- `api/_token_check.py` — bearer token extraction
- `api/env_bootstrap.py` — .env → os.environ bridge
- `api/config.py` — added `engine_service_token`, `cloud_metering_url`, `cloud_metering_token`, `cloud_device_registry_url`, `anthropic_base_url`

**Adapter strategy:** Copy upstream code verbatim. All cloud fields default to empty string → no-op in standalone mode. Local deployment works without any cloud config.

### 3.4 Deleted in Upstream (Local Decision)

| File | Upstream Action | Local Decision |
|------|-----------------|----------------|
| `api/pipeline/phase_narrator.py` | DELETED | **KEEP** (local addition, used by pipeline narration UI) |
| `web/brd_viewer.js` | DELETED | **KEEP** (legacy D3 fallback, delete in Phase 5b after WebGL stable) |
| `web/js/home.js`, `web/js/landing.js`, `web/js/stock.js` | DELETED | **KEEP** (legacy JS, delete in Phase 5b after features/ stable) |
| `web/styles/brd.css`, `brd_minimap.css`, `home.css`, `landing.css`, `stock.css` | DELETED | **KEEP** (legacy CSS, delete in Phase 5b) |

---

## 4. Adaptation Strategy

### 4.1 Hard-Copy + Adapter Layer

- **New files:** `git checkout junkz3/main -- <path>` (exact copy)
- **Rewritten files:** Replace entire file from upstream (e.g., `runtime_direct.py`, `orchestrator.py`, `writers.py`)
- **Minor changes:** Apply upstream patch (e.g., `pricing.py` +3 lines, `sanitize.py` +11 lines)
- **Multi-tenant code:** Copy verbatim; cloud fields default to empty → no-op in standalone

### 4.2 Local Additions Preserved

- After each phase, verify local-only files are untouched.
- Phase 5b (frontend reorg) will delete legacy JS/CSS, but only after the new `features/` structure is verified stable.

---

## 5. Phasing (5 Commits)

### Phase 1: Core Backend — Isolated, Low Risk

**Files:**
- `api/pipeline/qa/graph_coverage.py` (new, 230 lines)
- `api/pipeline/qa/__init__.py` (new)
- `api/agent/recall.py` (new, 124 lines)
- `api/agent/board_ref.py` (new, 33 lines)
- `api/agent/manifest.py` (patch: +110 lines for 3 new tools)
- `api/agent/tools.py` (patch: +84 lines for 3 new tool implementations)
- `api/agent/memory_seed.py` (patch: +78 lines)
- `tests/pipeline/qa/test_graph_coverage.py` (new)
- `tests/agent/test_recall.py` (new)

**Rationale:** Self-contained modules with no dependencies on other upstream changes. `graph_coverage.py` is a pure-function QA gate. `recall.py` is a read-only wrapper over existing `field_reports.py`. The 3 new tools (`mb_recall_field_reports`, `mb_search_patterns`, `mb_search_playbooks`) are additive.

**Acceptance:** `make test` passes. `python -m api.pipeline.qa.graph_coverage` runs against 3 real pilots (A2338, iPhone 8, iPhone 11).

### Phase 2: Board-Delta Agent + Semantic Search

**Files:**
- `api/pipeline/board_delta/` (5 new files: agent.py, prompts.py, schemas.py, store.py, __init__.py)
- `api/pipeline/routes/board_delta.py` (new, 68 lines)
- `api/agent/cousin_hint.py` (new, 51 lines)
- `api/agent/owner_ref.py` (new, 31 lines)
- `api/agent/session_caps.py` (new, 34 lines)
- `api/agent/cloud_metering.py` (new, 142 lines)
- `api/pipeline/expansion.py` (rewrite: 360 → much bigger)
- `api/pipeline/graph_truth.py` (new, 486 lines)
- `api/pipeline/live_graph.py` (new, 157 lines)
- `api/pipeline/models.py` (new, 123 lines)
- `api/pipeline/pack_lint.py`, `pack_migrate.py`, `pack_sanitizer.py`, `pack_storage.py` (4 new files)
- `api/pipeline/patch.py` (new, 137 lines)
- `api/pipeline/reconcile.py` (new, 205 lines)
- `api/pipeline/routes/packs.py` (rewrite: +509 lines)
- `api/pipeline/routes/repairs.py` (rewrite: +718 lines)
- `api/pipeline/routes/documents.py` (rewrite: +298 lines)
- `api/pipeline/schemas.py` (rewrite: +419 lines)
- `tests/pipeline/board_delta/` (new)
- `tests/pipeline/test_pack_*.py` (new, ~5 files)

**Rationale:** Board-delta agent depends on `graph_coverage.py` (Phase 1). Semantic search (`mb_search_patterns`, `mb_search_playbooks`) requires `seed_data/` (already exists) + `recall.py` (Phase 1). Pack management modules (`pack_*`) are a cohesive unit.

**Acceptance:** `make test` passes. Board-delta agent can be invoked via `POST /pipeline/packs/{slug}/board-delta`. Pack management endpoints work.

### Phase 3: Schematic Pipeline + Rust Crates

**Files:**
- `api/pipeline/schematic/batch_vision.py` (new, 271 lines)
- `api/pipeline/schematic/orchestrator.py` (rewrite: +491 lines)
- `api/pipeline/schematic/compiler.py` (rewrite: +342 lines)
- `api/pipeline/schematic/page_vision.py` (rewrite: +216 lines)
- `api/pipeline/schematic/renderer.py` (rewrite: +192 lines)
- `api/pipeline/schematic/grounding.py` (rewrite: +110 lines)
- `api/pipeline/schematic/boot_analyzer.py` (patch: +32 lines)
- `api/pipeline/schematic/hypothesize.py` (patch: +17 lines)
- `api/pipeline/schematic/merger.py` (patch: +32 lines)
- `api/pipeline/schematic/schemas.py` (patch: +45 lines)
- `api/pipeline/schematic/cli.py` (patch: +5 lines)
- `rust/wb_fz_cipher/` (new crate: Cargo.toml, pyproject.toml, src/lib.rs)
- `rust/wb_tvw_walker/` (new crate: Cargo.toml, pyproject.toml, src/lib.rs)
- `api/board/parser/_fz_engine/cipher.py` (patch: +24 lines)
- `api/board/parser/_tvw_engine/walker.py` (rewrite: +123 lines)
- `api/pipeline/orchestrator.py` (rewrite: +733 lines)
- `api/pipeline/writers.py` (rewrite: +363 lines)
- `api/pipeline/tool_call.py` (rewrite: +443 lines)
- `api/pipeline/prompts.py` (patch: +128 lines)
- `api/pipeline/scout.py` (patch: +30 lines)
- `api/pipeline/graph_transform.py` (patch: +23 lines)
- `api/pipeline/registry.py` (patch: +8 lines)
- `tests/pipeline/schematic/test_batch_vision.py` (new)
- `tests/rust/test_fz_cipher.py` (new)
- `tests/rust/test_tvw_walker.py` (new)

**Rationale:** Schematic pipeline rewrite is cohesive (orchestrator → compiler → page_vision → renderer). Rust crates are independent but depend on the schematic changes (batch_vision uses page_vision params).

**Acceptance:** `make test` passes. Rust crates build via `maturin develop` (if cargo available). `batch_vision.py` can be invoked via `PIPELINE_VISION_BATCH=1`.

### Phase 4: Deployment + Toolchain

**Files:**
- `Dockerfile` (new)
- `.dockerignore` (new)
- `scripts/doctor.py` (new, ~200 lines)
- `scripts/check_web_imports.py` (new, ~150 lines)
- `scripts/eval_all.py` (new, ~300 lines)
- `api/http_security.py` (new)
- `api/_token_check.py` (new)
- `api/env_bootstrap.py` (new)
- `api/ws_security.py` (patch: add `enforce_ws_service_token`)
- `api/config.py` (patch: add `anthropic_base_url`, `engine_service_token`, `cloud_metering_*`, `cloud_device_registry_*`)
- `api/main.py` (rewrite: add `ServiceTokenMiddleware`, `env_bootstrap.load_env_file()`, `set_board_ref`, demo-pack seeding, model default 4.7 → 4.8)
- `api/cli/pack_admin.py` (new)
- `pyproject.toml` (patch: license, author, URLs, numpy dep)
- `Makefile` (patch: add `check-web` target)
- `tests/test_http_security.py` (new)
- `tests/test_token_check.py` (new)
- `tests/test_env_bootstrap.py` (new)
- `tests/test_progress_ws_token.py` (new)

**Rationale:** Deployment + toolchain is independent of pipeline/agent changes. `http_security.py` + `_token_check.py` + `env_bootstrap.py` are prerequisites for `main.py` rewrite.

**Acceptance:** `make doctor` runs 8 health checks. `make check-web` validates ESM imports. Docker image builds. `make test` passes.

### Phase 5: Frontend Reorg

**Files:**
- `web/js/features/` (new: global/landing/, repair/diagnostic/)
- `web/js/services/` (new: deviceCatalog.js, diagnosticSocket.js, packs.js, pipelineSocket.js, repairs.js)
- `web/js/shared/` (new: api.js, context.js, dom.js)
- `web/js/store.js` (new)
- `web/js/onboarding_state.js` (new)
- `web/js/mascot_bubble.js`, `mascot_gallery.js`, `mascot_states.js`, `info_modal.js`, `cloud_hints.js` (5 new)
- `web/mascot_gallery.html` (new)
- `web/styles/onboarding.css` (new, 649 lines)
- `web/styles/mascot_gallery.css` (new, 130 lines)
- `web/demos/` (new dir)
- `fixtures/demo-packs/mnt-reform-motherboard/` (new, ~5,000 lines)
- `README.fr.md`, `README.hi.md`, `README.zh.md` (new)
- `docs/assets/og-card.png` (new)
- **Phase 5b (delete legacy):**
  - `web/brd_viewer.js` (delete)
  - `web/js/home.js`, `web/js/landing.js`, `web/js/stock.js` (delete)
  - `web/styles/brd.css`, `brd_minimap.css`, `home.css`, `landing.css`, `stock.css` (delete)

**Rationale:** Frontend reorg is the largest change (~10,000 lines). Split into 5a (additive) and 5b (subtractive) to allow rollback if the new structure breaks existing flows.

**Acceptance:** Web UI loads in 4 languages (en/fr/hi/zh). Mascot gallery works. Board-delta agent answers queries. `make check-web` passes.

---

## 6. Module Design (Key Modules)

### 6.1 qa/graph_coverage.py

**Purpose:** Compare electrical graph (from schematic vision) vs boardview (physical PCB) to measure pack completeness.

**Inputs:**
- `memory/{slug}/electrical_graph.json` (vision output)
- `board_assets/{slug}.brd` / `.kicad_pcb` / `.tvw` (boardview)

**Outputs:**
- `CoverageReport` dataclass with:
  - `component_coverage: float` (0.0–1.0)
  - `net_coverage: float` (0.0–1.0)
  - `missing_components: list[str]` (refdes in boardview but not graph)
  - `missing_nets: list[str]` (net names in boardview but not graph)

**Verdict Thresholds:**
- `PASS`: nets ≥ 0.90 AND missing-critical ≤ 8
- `FAIL`: nets < 0.75 OR missing-critical > 25
- `WARN`: everything in between → human review

**Calibration:** A2338 (97.9% nets, 83.6% comps, 4 missing-critical → PASS), iPhone 8 (98.9% nets, 91.4% comps, 5 missing-critical → PASS), iPhone 11 (93.8% nets, 84.6% comps, 12 missing-critical → WARN).

**Excluded Families:** `TPU`, `TP`, `PP`, `XW`, `FID`, `MP` (test pads, bare power pads, solder straps, fiducials, mounting points — legitimately absent from schematic).

**Critical Prefix:** `^(U|Q|J|L|F|D|T)\d` (ICs, mosfets, connectors, inductors, fuses, diodes, transformers — absence breaks diagnostic chains).

### 6.2 agent/recall.py

**Purpose:** Direct-mode memory recall — pure read helpers backing 3 wrapper tools.

**Functions:**
- `recall_field_reports(device_slug, query, refdes, limit)` — wrapper over `field_reports.list_field_reports` with free-text query filter.
- `search_patterns(query)` — grep over `seed_data/global_patterns/` (curated failure archetypes).
- `search_playbooks(query)` — grep over `seed_data/global_playbooks/` (curated protocol templates).

**Matching:** Substring/keyword grep (same shape as managed agent grepping FUSE-mounted files). No semantic search.

**Tools:**
- `mb_recall_field_reports` — recall confirmed findings from past repairs of THIS device.
- `mb_search_patterns` — search global cross-device failure archetypes.
- `mb_search_playbooks` — search global diagnostic protocol templates (call BEFORE `bv_propose_protocol`).

### 6.3 board_delta/agent.py

**Purpose:** Per-revision board context agent — uses web search to extract repair context for a specific board number.

**Inputs:**
- `device_label` (e.g., "iPhone 11 Pro")
- `board_number` (e.g., "820-01324")

**Outputs:**
- `DeltaBoard` Pydantic model with:
  - `signature_ics: list[SignatureIC]` (part marking, role, source URL)
  - `notable_rails: list[NotableRail]` (rail name, note, source URL)
  - `repair_pitfalls: list[RepairPitfall]` (title, detail, source URL)
  - `kinship_hints: list[KinshipHint]` (neighbouring board number, relation, source URL)
  - `sources: list[DeltaSource]` (URL, kind)

**Storage:** `memory/{slug}/board_deltas/{board_number}.json`

**Coverage:** `coverage='none'` means web had nothing usable → never inject into agent context.

### 6.4 Rust Crates

**wb_fz_cipher:**
- Replicates `_fz_engine/cipher.py::decrypt_fz_xor` byte-identically.
- RC6-shaped cipher, 16-byte sliding window, 20 rounds.
- PyO3 0.22, maturin build, optional (Python fallback exists).

**wb_tvw_walker:**
- Replicates `_tvw_engine/walker.py` record-identically.
- Hot loop: `_read_pin_record`, `_is_plausible_pin`, `_try_walk_pins_at`.
- Zero-copy buffer borrow (`&[u8]`) — crucial for multi-MB files.

---

## 7. Test Strategy

### 7.1 Per-Module Tests

- **Phase 1:** Copy `tests/pipeline/qa/test_graph_coverage.py` and `tests/agent/test_recall.py` from upstream.
- **Phase 2:** Copy `tests/pipeline/board_delta/` and `tests/pipeline/test_pack_*.py`.
- **Phase 3:** Copy `tests/pipeline/schematic/test_batch_vision.py` and `tests/rust/test_*.py`.
- **Phase 4:** Copy `tests/test_http_security.py`, `test_token_check.py`, `test_env_bootstrap.py`, `test_progress_ws_token.py`.
- **Phase 5:** No new tests (frontend reorg is manual QA).

### 7.2 Local Test Adaptations

- Tests that reference upstream-specific fixtures (e.g., `fixtures/demo-packs/mnt-reform-motherboard/`) will be skipped if the fixture is absent.
- Tests that require Rust toolchain will be skipped if `cargo` is not available.

### 7.3 Integration Tests

- After each phase, run `make test` to verify no regressions.
- After Phase 4, run `make doctor` to verify 8 health checks pass.
- After Phase 5, manually verify web UI in 4 languages.

---

## 8. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| **License change is irreversible** | Local LICENSE already matches upstream (Proprietary). No change needed. |
| **Rust toolchain not available** | Rust crates are optional; Python fallbacks exist. Skip Rust build in CI if no cargo. |
| **Frontend reorg breaks existing flows** | Phase 5 split into 5a (additive) and 5b (subtractive). Rollback 5b if 5a breaks anything. |
| **Multi-tenant code adds complexity** | Cloud fields default to empty → no-op in standalone. Adapter layer is thin. |
| **Large file rewrites are hard to review** | Each phase is a single commit. Review diff per phase, not per file. |
| **Local additions (phase_narrator, brd_viewer) conflict with upstream deletions** | Local keeps these files. Upstream's deletion is not applied. |

---

## 9. Acceptance Criteria

### Phase 1

- [ ] `make test` passes (no regressions).
- [ ] `python -m api.pipeline.qa.graph_coverage` runs against 3 real pilots (A2338, iPhone 8, iPhone 11) and produces correct verdicts.
- [ ] `mb_recall_field_reports`, `mb_search_patterns`, `mb_search_playbooks` tools are registered in manifest.

### Phase 2

- [ ] `make test` passes.
- [ ] `POST /pipeline/packs/{slug}/board-delta` endpoint works.
- [ ] Pack management endpoints (`/pipeline/packs`, `/pipeline/packs/{slug}`) work.

### Phase 3

- [ ] `make test` passes.
- [ ] Rust crates build via `maturin develop` (if cargo available).
- [ ] `PIPELINE_VISION_BATCH=1` invokes batch vision pass.

### Phase 4

- [ ] `make test` passes.
- [ ] `make doctor` runs 8 health checks.
- [ ] `make check-web` validates ESM imports.
- [ ] Docker image builds.
- [ ] `config.py` default model is `claude-opus-4-8`.

### Phase 5

- [ ] Web UI loads in 4 languages (en/fr/hi/zh).
- [ ] Mascot gallery works.
- [ ] Board-delta agent answers queries.
- [ ] `make check-web` passes.

---

## 10. Local Additions Preserved

| Local Addition | Location | Reason |
|----------------|----------|--------|
| Chinese i18n | `web/i18n/_modules/*.zh.json` (16 files) | Runtime language switch (upstream has README.zh.md but no runtime i18n) |
| SMT-V551 board | `board_assets/smt-v551.brd`, `memory/smt-v551/` | Private board asset |
| Dev-memory docs | `docs/dev-memory/` | Internal dev notes |
| Phase narrator | `api/pipeline/phase_narrator.py` | Local addition for pipeline narration UI (upstream deleted) |
| Legacy JS/CSS | `web/brd_viewer.js`, `web/js/home.js`, `web/js/landing.js`, `web/js/stock.js`, `web/styles/brd.css`, `brd_minimap.css`, `home.css`, `landing.css`, `stock.css` | Legacy fallback (delete in Phase 5b after new structure stable) |
| i18n validator | `scripts/check_i18n_keys.py` | Local i18n key checker |
| Local specs | `docs/superpowers/specs/` | Local design docs |

---

## 11. Out-of-Band (Not in This Sync)

- **Evolve skill:** Upstream README claims 4 loops, but skill file only defines 1. Keep local's 1 loop.
- **README translations:** Upstream has 4 README files (en/fr/hi/zh). Local has Chinese i18n via runtime switch. Keep local approach.
- **Dev-memory docs:** Upstream doesn't publish these. Local keeps its own.
- **Internal board assets:** Upstream doesn't publish SMT-V551. Local keeps it private.

---

## 12. Implementation Order

1. **Phase 1** (core backend) — lowest risk, highest value.
2. **Phase 2** (board-delta + semantic search) — depends on Phase 1.
3. **Phase 3** (schematic + Rust) — depends on Phase 2.
4. **Phase 4** (deployment + toolchain) — independent, can be done in parallel with Phase 3.
5. **Phase 5** (frontend reorg) — largest change, do last.

Each phase is a single commit. After each phase, run `make test` and verify acceptance criteria before proceeding.

---

## 13. Rollback Plan

- Each phase is a single commit → `git revert <commit>` rolls back that phase.
- Phase 5b (delete legacy) is a separate commit → easy to rollback if Phase 5a breaks.
- Local additions (phase_narrator, brd_viewer, legacy JS/CSS) are never deleted → always available as fallback.

---

## 14. Success Metrics

- **Code sync:** 100% of upstream v1.3.4 material is present in local fork (except deliberate exclusions in §2.2).
- **Test pass:** `make test` passes after each phase.
- **No regressions:** Local additions (Chinese i18n, SMT-V551, dev-memory) are preserved.
- **Deployment ready:** Docker image builds, `make doctor` passes, `make check-web` passes.

---

**End of spec.**
