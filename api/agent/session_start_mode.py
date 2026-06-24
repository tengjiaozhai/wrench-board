"""Managed Agents 会话如何启动的显式状态机。

替换布尔值 `resumed` + `stale_agent_recovery` + 隐式
`runtime_managed.py` 中的“reused_session_id 并且未恢复”分支。这
进入会话的五个路径之前被表示为以下组合
两个标志，它们内联读起来很好，但对 WS 事件进行了推理
合约（前端应该期望的`session_*`事件，何时
发出 `context_lost`，何时重放 JSONL vs MA 历史）很脆弱。

五种模式，详尽且互不相交：

* `FRESH_NEW` — 磁盘上没有此转换的先前会话 ID。第一个用户
  全新对话中的消息。用户界面：`session_ready`。
* `FRESH_RECOVERED_LOST` — 先前的会话 ID 已存在，但
  `client.beta.sessions.retrieve` 失败（已存档、已过期、MA 中断）。
  我们创建一个新会话；之前的聊天记录丢失了。用户界面：
  `context_lost` 带有磁盘状态快照。
* `FRESH_RECOVERED_AGENT_BUMP` — 之前的会话绑定到
  agent_id 与当前引导程序不同（隔夜进化循环
  碰撞了 SYSTEM_PROMPT 或清单）。我们创建一个新的会话
  现任代理人；聊天记录从 JSONL 镜像读取，因此技术
  没有看到新会话 UI 警报。 UI：静默（无事件），JSONL
  重播处理视觉效果。
* `RESUMED` — 先前的会话检索良好并绑定到
  当前代理 ID。 UI：`session_resumed` + MA-历史重播。
* `RESUMED_BUT_EMPTY` — 与 RESUMED 类似，但 `events.list()` 没有返回
  用户/代理事件（可能已压缩）。代理没有
  会话记忆。 UI：`session_resumed`，然后`context_lost`一次
  观察到空重放；我们注入一个合成状态块，所以
  代理重新定位。

转换`RESUMED → RESUMED_BUT_EMPTY`发生在重播之后
尝试——这是运行时观察，而不是启动决定。这是
为了清晰起见，建模为一个单独的常数，即使只有
重播后代码路径构建它。"""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class SessionStartMode(StrEnum):
    """会话可以以五种不相交的模式开始。

    上面每个值的文档字符串（在模块头中）解释了
    触发条件+预期WS事件合约。值为 str
    因此记录器和测试可以通过名称引用它们，而无需导入。"""

    FRESH_NEW = "fresh_new"
    FRESH_RECOVERED_LOST = "fresh_recovered_lost"
    FRESH_RECOVERED_AGENT_BUMP = "fresh_recovered_agent_bump"
    RESUMED = "resumed"
    RESUMED_BUT_EMPTY = "resumed_but_empty"


@dataclass(frozen=True, slots=True)
class SessionStartDecision:
    """`decide_session_start_mode` 的结果。

    `mode` 驱动WS 事件合约和 recap-injection 分支。
    当 MA 在磁盘上有一个会话 ID 时，`prior_session_id` 为非 None
    此转换（FRESH_RECOVERED_* 或 RESUMED* 模式之一）；它是
    出现在`context_lost`上，这样前端就可以渲染“我们输了”
    会话 sesn_xyz，这是您的快照”。"""

    mode: SessionStartMode
    prior_session_id: str | None = None


def decide_session_start_mode(
    *,
    reused_session_id: str | None,
    retrieved_session_agent_id: str | None,
    current_agent_id: str,
    retrieve_failed: bool,
) -> SessionStartDecision:
    """将会话启动分类为四种启动模式之一。

    `RESUMED_BUT_EMPTY` 不会在此处返回 - 这是重播后的结果
    仅在 `decide_session_start_mode` 之后运行的观察
    当初始模式为`RESUMED`时。调用者转换为
    一旦观察到空的`events.list()`，就会执行`RESUMED_BUT_EMPTY`。

    参数：
        reused_session_id：为此存储在磁盘上的 MA 会话 ID
            （设备、维修、转化、等级），如果转化为品牌，则为“无”
            新的。驱动 FRESH_NEW 与 FRESH_RECOVERED_* / RESUMED
            分裂。
        retrieved_session_agent_id：返回的`agent.id`
            ⟦保留6⟧。没有任何
            如果 `retrieve_failed=True` 或 MA 返回会话
            没有代理绑定（防御性的——不应该发生在
            实践）。
        current_agent_id：来自`managed_ids.json`的agent_id
            当前层。用于检测夜间药剂碰撞漂移。
        retrieve_failed：如果 `client.beta.sessions.retrieve` 引发则为 True
            （已存档/过期/中断）。意味着我们无法恢复
            即使我们愿意。

    返回：
        一个`SessionStartDecision`，其模式+先前的会话ID
        （如适用）。"""
    if not reused_session_id:
        return SessionStartDecision(mode=SessionStartMode.FRESH_NEW)

    if retrieve_failed:
        return SessionStartDecision(
            mode=SessionStartMode.FRESH_RECOVERED_LOST,
            prior_session_id=reused_session_id,
        )

    if (
        retrieved_session_agent_id
        and retrieved_session_agent_id != current_agent_id
    ):
        return SessionStartDecision(
            mode=SessionStartMode.FRESH_RECOVERED_AGENT_BUMP,
            prior_session_id=reused_session_id,
        )

    return SessionStartDecision(
        mode=SessionStartMode.RESUMED,
        prior_session_id=reused_session_id,
    )
