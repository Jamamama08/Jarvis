"""Anthropic-hosted web search and web fetch (run on Anthropic's servers, not here).

Opt-in per user because web search is billed: $10 per 1,000 searches plus the tokens
of the results. Web fetch is billed only as tokens. Results are untrusted data.
"""

# Models that support the dynamic-filtering versions of the web tools.
DYNAMIC_FILTERING_MODELS = frozenset({
    "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
    "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5", "claude-fable-5-1",
})
MAX_SEARCHES_PER_REQUEST = 5
SEARCH_PRICE_USD = 0.01  # $10 per 1,000 searches
SERVER_TOOL_NAMES = frozenset({"web_search", "web_fetch"})


def web_tool_definitions(model: str) -> list[dict]:
    if model in DYNAMIC_FILTERING_MODELS:
        search, fetch = "web_search_20260209", "web_fetch_20260209"
    else:
        search, fetch = "web_search_20250305", "web_fetch_20250910"
    return [
        {"type": search, "name": "web_search", "max_uses": MAX_SEARCHES_PER_REQUEST},
        {"type": fetch, "name": "web_fetch", "max_uses": MAX_SEARCHES_PER_REQUEST},
    ]


def describe_server_result(block: dict) -> tuple[bool, str]:
    """Summarise a web_search/web_fetch result block for the activity log: (ok, text)."""
    content = block.get("content")
    if isinstance(content, dict) and content.get("error_code"):
        return False, f"Error: {content['error_code']}"
    if isinstance(content, list):
        lines = [f"- {r.get('title') or r.get('url')}: {r.get('url')}" for r in content if isinstance(r, dict)]
        return True, "\n".join(lines) or "No results."
    if isinstance(content, dict):
        return True, f"Fetched {content.get('url') or 'page'}"
    return True, "Done."
