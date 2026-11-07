"""Push notifications to your phone or chat via a webhook URL you configure:
ntfy (ntfy.sh or self-hosted), Discord, Slack, or any endpoint accepting JSON."""

import json
from urllib.parse import urlsplit

from app.integrations import http


def kind(url: str) -> str:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if "discord.com" in host or "discordapp.com" in host:
        return "discord"
    if host == "hooks.slack.com":
        return "slack"
    if "ntfy" in host:
        return "ntfy"
    return "json"


def send(url: str, title: str, message: str) -> str:
    url = http.require_http(url)
    k = kind(url)
    if k == "ntfy":
        http.fetch(url, method="POST", data=message.encode(), headers={"Title": title.encode("ascii", "replace").decode()})
    elif k == "discord":
        http.fetch(url, method="POST", data=json.dumps({"content": f"**{title}**\n{message}"[:2000]}).encode(),
                   headers={"Content-Type": "application/json"})
    elif k == "slack":
        http.fetch(url, method="POST", data=json.dumps({"text": f"*{title}*\n{message}"}).encode(),
                   headers={"Content-Type": "application/json"})
    else:
        http.fetch(url, method="POST", data=json.dumps({"title": title, "message": message}).encode(),
                   headers={"Content-Type": "application/json"})
    return k
