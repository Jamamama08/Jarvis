"""Network guard for browser automation.

Web pages are untrusted. Without this guard a malicious page (or a prompt-injected
instruction) could make the browser on your machine reach your router, NAS, cloud
metadata endpoints or JARVIS itself. Every request the browser makes, including
redirects and sub-resources, is checked here: only http(s) to public addresses is
allowed unless the user enables private-network access.
"""

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

ALLOWED_SCHEMES = {"http", "https"}


class BlockedURL(ValueError):
    pass


def is_private_address(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
        or (isinstance(addr, ipaddress.IPv4Address) and addr in ipaddress.ip_network("100.64.0.0/10"))  # CGNAT
    )


class NetworkGuard:
    def __init__(self, allow_private: bool):
        self.allow_private = allow_private
        self._cache: dict[str, bool] = {}

    async def check(self, url: str) -> None:
        """Raise BlockedURL if the browser must not load this URL."""
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        if scheme in ("data", "blob", "about"):
            return  # in-page content, no network access
        if scheme not in ALLOWED_SCHEMES:
            raise BlockedURL(f"Only http and https addresses can be opened (not {scheme or 'this'}:).")
        host = (parts.hostname or "").rstrip(".").lower()
        if not host:
            raise BlockedURL("That address has no host name.")
        if self.allow_private:
            return
        if host == "localhost" or host.endswith(".localhost") or host.endswith(".local") or host.endswith(".internal"):
            raise BlockedURL(f"{host} is on your private network; private-network browsing is turned off.")
        if host in self._cache:
            if not self._cache[host]:
                raise BlockedURL(f"{host} is on your private network; private-network browsing is turned off.")
            return
        try:
            ip = ipaddress.ip_address(host.strip("[]"))
            addresses = [str(ip)]
        except ValueError:
            loop = asyncio.get_running_loop()
            try:
                infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
            except socket.gaierror as exc:
                raise BlockedURL(f"Couldn't find {host}.") from exc
            addresses = sorted({info[4][0] for info in infos})
        ok = bool(addresses) and not any(is_private_address(a) for a in addresses)
        self._cache[host] = ok
        if not ok:
            raise BlockedURL(f"{host} is on your private network; private-network browsing is turned off.")
