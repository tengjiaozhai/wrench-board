"""工作台生成器的异常类。

从主模块中分离出来，这样就可以在不触发的情况下导入它们
下游消费者中的 Pydantic + Anthropic 导入图（例如
CLI 只想漂亮地打印前提条件失败）。"""


class BenchGeneratorError(Exception):
    """基础班。抓住这个来捕捉所有发电机故障。"""


class BenchGeneratorPreconditionError(BenchGeneratorError):
    """当包输入不足时，在任何 LLM 调用之前引发。
    CLI 中的退出代码 2。"""


class BenchGeneratorLLMError(BenchGeneratorError):
    """在 max_attempts 次重试格式错误的 LLM 响应后引发。
    CLI 中的退出代码 3。"""
