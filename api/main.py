"""wrench-board 的 FastAPI 应用入口。"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from api import __version__
from api.agent.board_ref import set_board_ref
from api.agent.macros import macro_path_for
from api.board.router import router as board_router
from api.config import get_settings
from api.http_security import (
    ServiceTokenMiddleware,
    should_fail_unprotected,
    should_warn_unprotected,
)
from api.logging_setup import configure_logging
from api.pipeline import router as pipeline_router
from api.profile.router import router as profile_router
from api.stock import stock_router
from api.ws_security import enforce_ws_origin, enforce_ws_service_token

logger = logging.getLogger("wrench_board.main")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


async def _prewarm_active_boardviews(memory_root: Path) -> None:
    """将各设备当前活跃的 boardview 解析进 /render 缓存。

    boardview 解析是 API 最重的同步工作（5 MB .tvw 约 5 s CPU）；
    不预热则每个设备首次打开仪表盘都要 upfront 付这 5 s。在后台 task
    中运行，预热期间服务仍可响应 — 每次解析 offload 到 worker 线程，
    保持事件循环响应。

    解析顺序镜像 `_find_boardview`：先 `active_sources.json` pin，
    再 `board_assets/{slug}.<ext>`，最后任意 `uploads/*-boardview-*`。
    """
    import asyncio  # 局部导入 — 保持启动导入轻量

    from api.board.parser.base import parser_for
    from api.board.render import to_render_payload
    from api.board.router import _RENDER_CACHE_MAX_ENTRIES, _render_cache
    from api.pipeline.routes.packs import _find_boardview

    if not memory_root.exists():
        return

    # 检查 pcbnew 是否可用（KiCad 文件需要）
    # KiCad parser 调用系统 Python，故在此检查
    import subprocess
    try:
        result = subprocess.run(
            ["/usr/bin/env", "python3", "-c", "import pcbnew"],
            capture_output=True,
            timeout=5,
        )
        pcbnew_available = result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pcbnew_available = False
    
    if not pcbnew_available:
        logger.info("[prewarm] pcbnew not available — skipping KiCad files")

    parsed = 0
    failed = 0
    for pack_dir in sorted(memory_root.iterdir()):
        if not pack_dir.is_dir() or pack_dir.name.startswith("_"):
            continue
        if len(_render_cache) >= _RENDER_CACHE_MAX_ENTRIES:
            logger.info("[prewarm] cache full, stopping after %d", parsed)
            break
        slug = pack_dir.name
        path = _find_boardview(slug, pack_dir)
        if path is None:
            continue
        # pcbnew 不可用时跳过 KiCad 文件
        if not pcbnew_available and path.suffix == ".kicad_pcb":
            logger.debug("[prewarm] skipping %s (pcbnew not available)", slug)
            continue
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        cache_key = (str(path), mtime)
        if cache_key in _render_cache:
            continue
        try:
            board = await asyncio.to_thread(parser_for(path).parse_file, path)
            payload = await asyncio.to_thread(to_render_payload, board)
            _render_cache[cache_key] = payload
            parsed += 1
            logger.info("[prewarm] %s cached (%s)", slug, path.name)
        except Exception:  # noqa: BLE001 — fire-and-forget；任意失败仅记录并跳过
            failed += 1
            logger.warning("[prewarm] failed for %s (%s)", slug, path.name, exc_info=True)
    logger.info("[prewarm] done: %d cached, %d failed", parsed, failed)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """启动 / 关闭钩子。"""
    import asyncio  # 局部 — 仅 prewarm task 需要

    settings = get_settings()
    configure_logging(settings.log_level)
    logger.info("wrench-board v%s starting up", __version__)
    logger.info(
        "main model=%s fast model=%s", settings.anthropic_model_main, settings.anthropic_model_fast
    )
    if not settings.anthropic_api_key:
        logger.warning(
            "ANTHROPIC_API_KEY is empty — pipeline + diagnostic WS will reject "
            "every request until it's set in .env. Pure-data endpoints "
            "(/health, /pipeline/packs read, board parsing) keep working."
        )
    # Fail-fast：在显式 production 上下文（ENV=production）且
    # 无 service-token 时，引擎将对全网开放 → 拒绝启动（与 cloud fail-fast 对称）。
    # 自托管（非 prod ENV，即使 docker 0.0.0.0）不受影响。
    if should_fail_unprotected(
        token=settings.engine_service_token,
        env=os.getenv("ENV", ""),
    ):
        raise RuntimeError(
            "ENGINE_SERVICE_TOKEN manquant en production — le moteur REFUSE de "
            "démarrer (il serait accessible sans auth depuis Internet). Définis "
            "ENGINE_SERVICE_TOKEN (identique à celui du cloud) et garde le moteur "
            "sur un réseau privé. Cf. DEPLOYMENT.md."
        )
    # 更松的网：prod-like 启发式（bind 0.0.0.0）且无 token 时 WARN — 不崩溃
    #（合法 docker 自托管保持安静）。
    if should_warn_unprotected(
        token=settings.engine_service_token,
        host=os.getenv("HOST", "127.0.0.1"),
        env=os.getenv("ENV", ""),
    ):
        logger.warning(
            "ENGINE_SERVICE_TOKEN vide en contexte prod-like — le moteur est OUVERT "
            "(toutes les routes accessibles sans auth). En managé : set le token + "
            "réseau privé (cf. DEPLOYMENT.md)."
        )
    # 播种随附 demo pack（如 MNT Reform），使首次示例导览有完整分析设备可走。
    # 幂等且非破坏性。
    try:
        from api.pipeline.demo_seed import seed_demo_packs

        seeded = seed_demo_packs(Path(settings.memory_root))
        if seeded:
            logger.info("demo packs seeded: %d", seeded)
    except Exception as exc:  # noqa: BLE001 — 播种不得阻塞启动
        logger.warning("demo-pack seeding skipped: %s", exc)
    # 后台启动 boardview 预热 — 不 await。服务立即可响应；
    # 每线程解析填充 /render 缓存，使各设备首次打开仪表盘即时。
    asyncio.create_task(_prewarm_active_boardviews(Path(settings.memory_root)))
    yield
    logger.info("wrench-board shutting down")


app = FastAPI(
    title="wrench-board",
    version=__version__,
    description="Agent-native board-level diagnostics workbench.",
    lifespan=lifespan,
)

# CORS：放弃 "*" + credentials（浏览器反正拒绝该组合），改用
# settings 的显式白名单。默认列表覆盖本地开发；在 .env 设
# CORS_ALLOW_ORIGINS 可放宽。
_cors_raw = get_settings().cors_allow_origins
_cors_origins = [o.strip() for o in _cors_raw.split(",") if o.strip()]
_cors_wildcard = _cors_origins == ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=not _cors_wildcard,
    allow_methods=["*"],
    allow_headers=["*"],
)

# HTTP service-token 门控：托管模式要求 bearer，自托管（token 空）为 no-op。
# 加在 CORS 之后 → 更外层 → 在应用逻辑前执行；放行 OPTIONS（预检）+ /health。
app.add_middleware(
    ServiceTokenMiddleware,
    expected_token=get_settings().engine_service_token,
)

app.include_router(pipeline_router)
app.include_router(board_router)
app.include_router(profile_router)
app.include_router(stock_router)


@app.get("/health")
async def health() -> JSONResponse:
    """存活探针。"""
    return JSONResponse({"status": "ok", "version": __version__})


_MACRO_MIME = {
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png":  "image/png",
    ".webp": "image/webp",
}


@app.get("/api/macros/{slug}/{repair_id}/{filename}")
async def get_macro(slug: str, repair_id: str, filename: str) -> FileResponse:
    """为聊天回放渲染提供已存 macro 图片。

    Flow A（技师上传）与 Flow B（agent cam_capture）均写入
    `memory/{slug}/repairs/{repair_id}/macros/`。本路由解析
    `messages.jsonl` 中存的 `image_ref.path`，供前端在聊天记录
    重载时重新渲染图片气泡。

    路径校验委托 `api.agent.macros.macro_path_for`，阻止遍历
    （`..`、`/`、前导点、经 resolve() 逃逸）。
    """
    settings = get_settings()
    try:
        path = macro_path_for(
            memory_root=Path(settings.memory_root),
            slug=slug, repair_id=repair_id, filename=filename,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="macro not found")
    media_type = _MACRO_MIME.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type)


_VALID_TIERS = {"fast", "normal", "deep"}


@app.websocket("/ws/diagnostic/{device_slug}")
async def diagnostic_session(websocket: WebSocket, device_slug: str) -> None:
    """诊断对话。`DIAGNOSTIC_MODE` 环境变量选择 runtime。

    - `managed`（默认）：Anthropic Managed Agents 持久 session +
      custom-tool 派发。须先运行 `bootstrap_managed_agent.py`。
    - `direct`：普通 `messages.create` tool-use 循环。无需 bootstrap；
      Managed Agents beta 不可用时使用。

    查询参数 `tier` 选择模型：`fast`（Haiku）、`normal`（Sonnet）、
    `deep`（Opus）。默认 `deep`，使 demo 流量落在 Opus 4.8 而无需
    显式选 tier。前端改 tier 会重连 WS — 即显式新对话。

    Origin 检查最先：CORS 中间件不覆盖 WS 握手，无此守卫时任意跨源
    浏览器页可开 session 并注入 `message` 帧。service-token 检查其次：
    引擎部署在 wrenchboard-cloud 后，仅携带共享 `Authorization: Bearer`
    token 的 cloud 中继可开 session — 直接 websocat 引擎 URL 会被拒绝，
    无法绕过 cloud auth + quota 烧 credits。独立工作台（无白名单 / 无 token）
    上两者均为 no-op。见 ``api.ws_security``。
    """
    if not await enforce_ws_origin(websocket):
        return
    if not await enforce_ws_service_token(websocket):
        return

    tier = websocket.query_params.get("tier", "deep").lower()
    if tier not in _VALID_TIERS:
        tier = "deep"
    # 可选：将 session 限定到特定 repair_id。设置时后端从
    # memory/{slug}/repairs/{repair_id}/messages.jsonl 加载历史并回放；
    # 每轮新消息追加。未设置则每次 WS 打开为全新（未持久化）对话。
    repair_id = websocket.query_params.get("repair") or None
    # 可选：指向 repair 内特定 conversation。None = 用最近一条
    #（或首次打开时迁移旧版扁平 messages.jsonl）。
    # "new" = 总是新建 conversation。其他值须匹配已有 conversation id，
    # 否则 ensure_conversation 抛错。
    conv_id = websocket.query_params.get("conv") or None
    # 多租户：cloud 前门在握手注入 X-Owner-Ref（tenant id），使 session
    # 的 owner 敏感工具（stock）写入正确租户的私有 store。独立/自托管缺席。
    owner_ref = websocket.headers.get("X-Owner-Ref") or None
    # cloud 注入的套餐能力（唯一守门人）：该 session 的租户能否触发
    # 付费 pack 扩充（mb_expand_knowledge）？
    # 头缺席 → 独立/自托管 → True（无限制）。cloud 总是显式发 "true"/"false"；
    # 仅 "false" 禁用。
    can_expand = (websocket.headers.get("X-Wb-Can-Expand") or "true").strip().lower() != "false"
    # 客户端以查询参数提供的可选板号（PCB 修订，如 "820-02016"）。
    # 缺席 → None → 无 board-delta 注入。此处无信任逻辑：公开引擎仅作 opaque key 携带。
    set_board_ref(websocket.query_params.get("board"))

    mode = os.environ.get("DIAGNOSTIC_MODE", "managed").lower()
    if mode == "direct":
        from api.agent.runtime_direct import run_diagnostic_session_direct

        await run_diagnostic_session_direct(
            websocket, device_slug, tier=tier, repair_id=repair_id, conv_id=conv_id,
            owner_ref=owner_ref, can_expand=can_expand,
        )
    else:
        from api.agent.runtime_managed import run_diagnostic_session_managed

        await run_diagnostic_session_managed(
            websocket, device_slug, tier=tier, repair_id=repair_id, conv_id=conv_id,  # type: ignore[arg-type]
            owner_ref=owner_ref, can_expand=can_expand,
        )


class _NoCacheStaticFiles(StaticFiles):
    """StaticFiles 子类，对提供的每个文件禁用浏览器缓存。

    原因：诊断聊天面板以 ES 模块树加载
    （`js/main.js` → `js/llm.js` → `js/protocol.js` → …）。浏览器
    积极缓存各模块 URL，ES 模块 import 不会因父脚本 `?v=` 查询串
    失效 — 相对 `import './foo.js'` 解析为裸 URL。开发中意味着
    改兄弟模块会静默 no-op，直到技师记得 Ctrl+Shift+R，且陈旧
    缓存版本继续经旧代码路径丢未处理 WS 事件（用户反复看到的
    聊天里 `?{...}` 原始 JSON）。no-store 对 prod CDN 过重，但对
    本地 FastAPI 开发服务器刚好：每次重载拉新代码，无陈旧模块坑。
    """

    async def get_response(self, path, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store, max-age=0"
        return response


if WEB_DIR.is_dir():
    app.mount("/", _NoCacheStaticFiles(directory=str(WEB_DIR), html=True), name="web")
else:
    logger.warning("web/ directory not found at %s — static files not mounted", WEB_DIR)
