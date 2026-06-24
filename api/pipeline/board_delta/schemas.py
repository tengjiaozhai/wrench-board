from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class SignatureIC(BaseModel):
    model_config = ConfigDict(extra="forbid")
    part: str | None = Field(default=None, description="零件标记（如果按来源命名）（例如“ISL9240”）。未知时为空。")
    refdes_hint: str | None = Field(default=None, description="如果来源提到了一个（例如“U5200”），则指示性refdes。从未被视为已验证。")
    role: str = Field(description="功能角色：‘充电器’、‘PMIC’、‘基带 PMU’、‘USB-C CC 控制器’。")
    source_url: str = Field(description="声明所基于的 URL。")


class NotableRail(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(description="来源中的 rail 名称（如 'PP3v8_AON_VDDMAIN'）。")
    note: str = Field(description="该修订版中此 rail 的重要性说明。")
    source_url: str = Field(description="声明所基于的 URL。")


class RepairPitfall(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(description="陷阱名称简短（例如“单向 USB-C”）。")
    detail: str = Field(description="报告的具体症状+原因。")
    source_url: str = Field(description="URL the claim is grounded in.")


class KinshipHint(BaseModel):
    model_config = ConfigDict(extra="forbid")
    board_number: str = Field(description="消息来源提到的相邻修订版的板号。")
    relation: str = Field(description="它是如何关联的（例如“前身英特尔变体”、“同一系列、N6 芯片收缩”）。")
    source_url: str = Field(description="URL the claim is grounded in.")


class DeltaSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(description="来源网址。")
    kind: str = Field(description="来源类型：“论坛”、“ifixit”、“拆解”、“供应商”、“数据表”、“视频”。")


class DeltaBoard(BaseModel):
    """来自网络搜索的每个修订版上下文叠加。背景/知识，
    未验证refdes。位于 memory/{slug}/board_deltas/{board}.json。
    coverage='none' 意味着网络没有任何可用的东西：永远不要注入它。"""

    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["1.0"] = "1.0"
    device_label: str = Field(description="生成此增量的商业设备标签。")
    board_number: str = Field(description="标准化板号键。")
    coverage: Literal["rich", "thin", "none"] = Field(description="发现了多少可用的来源增量。")
    signature_ics: list[SignatureIC] = Field(default_factory=list)
    notable_rails: list[NotableRail] = Field(default_factory=list)
    repair_pitfalls: list[RepairPitfall] = Field(default_factory=list)
    kinship_hints: list[KinshipHint] = Field(default_factory=list)
    sources: list[DeltaSource] = Field(default_factory=list)
    generated_at: str | None = Field(default=None, description="ISO-8601 UTC 标记在写入时设置。")
    generated_by_tenant: str | None = Field(default=None, description="生成它的租户的owner_ref（出处）。")

    def is_empty(self) -> bool:
        return not (self.signature_ics or self.notable_rails or self.repair_pitfalls)
