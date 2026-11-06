"""Tool registry: the single list of tools Claude can use."""

from app.core.config import Settings
from app.tools.base import Tool


class ToolRegistry:
    def __init__(self, tools: list[Tool] | None = None):
        self._tools: dict[str, Tool] = {}
        for tool in tools or []:
            self.register(tool)

    def register(self, tool: Tool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"Duplicate tool name: {tool.name}")
        if not tool.name.replace("_", "").isalnum() or len(tool.name) > 64:
            raise ValueError(f"Invalid tool name: {tool.name}")
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def all(self) -> list[Tool]:
        return [self._tools[name] for name in sorted(self._tools)]

    def available(self, settings: Settings) -> list[Tool]:
        return [t for t in self.all() if t.enabled(settings)]

    def definitions(self, settings: Settings) -> list[dict]:
        # Sorted by name so the tools prefix is byte-stable across requests (prompt caching).
        return [t.definition() for t in self.available(settings)]


def default_registry() -> ToolRegistry:
    from app.tools.builtin import BUILTIN_TOOLS

    return ToolRegistry(BUILTIN_TOOLS)
