"""Email over standard IMAP (read/search) and SMTP (send).

Works with Gmail, Outlook, iCloud, Fastmail and most providers. Use an *app
password* (Gmail and Outlook require one when 2-step verification is on); your
normal password and OAuth tokens are never needed. Credentials are stored in the
secret store, never in the database.
"""

from __future__ import annotations

import email
import email.policy
import imaplib
import re
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import getaddresses, parseaddr

from app.integrations.http import IntegrationError

TIMEOUT = 20
MAX_RESULTS = 25
BODY_CHARS = 20_000
_ADDRESS = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@dataclass
class EmailConfig:
    username: str
    password: str
    imap_host: str
    smtp_host: str
    imap_port: int = 993
    smtp_port: int = 587
    imap_security: str = "ssl"  # ssl | starttls | none (none: local testing only)
    smtp_security: str = "starttls"  # starttls | ssl | none
    from_address: str = ""

    @classmethod
    def from_dict(cls, d: dict) -> EmailConfig:
        return cls(**{k: d[k] for k in cls.__dataclass_fields__ if k in d})


def _imap(cfg: EmailConfig) -> imaplib.IMAP4:
    try:
        if cfg.imap_security == "ssl":
            conn = imaplib.IMAP4_SSL(cfg.imap_host, cfg.imap_port, ssl_context=ssl.create_default_context(), timeout=TIMEOUT)
        else:
            conn = imaplib.IMAP4(cfg.imap_host, cfg.imap_port, timeout=TIMEOUT)
            if cfg.imap_security == "starttls":
                conn.starttls(ssl_context=ssl.create_default_context())
        conn.login(cfg.username, cfg.password)
        return conn
    except imaplib.IMAP4.error as exc:
        raise IntegrationError(f"Email sign-in failed: {exc}. For Gmail/Outlook, use an app password.") from exc
    except (OSError, ssl.SSLError) as exc:
        raise IntegrationError(f"Couldn't connect to {cfg.imap_host}:{cfg.imap_port} ({exc}).") from exc


def _quote(text: str) -> str:
    # IMAP quoted string: strip characters that could break out of the quotes.
    cleaned = re.sub(r'[\r\n"\\]', " ", text).strip()[:200]
    return f'"{cleaned}"'


def _text_of(msg: email.message.EmailMessage) -> str:
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    content = part.get_content()
    if part.get_content_type() == "text/html":
        content = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", content, flags=re.S | re.I)
        content = re.sub(r"<[^>]+>", " ", content)
    return re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n\n", content)).strip()


def search(cfg: EmailConfig, query: str = "", folder: str = "INBOX", limit: int = 10, unread_only: bool = False) -> list[dict]:
    conn = _imap(cfg)
    try:
        status, _ = conn.select(_quote(folder), readonly=True)
        if status != "OK":
            raise IntegrationError(f"No folder named {folder!r}.")
        criteria = ["UNSEEN"] if unread_only else []
        if query.strip():
            q = _quote(query)
            criteria += ["OR", "OR", "SUBJECT", q, "FROM", q, "BODY", q]
        status, data = conn.uid("SEARCH", None, *(criteria or ["ALL"]))
        if status != "OK":
            raise IntegrationError("The mail server rejected the search.")
        uids = data[0].split()[-max(1, min(limit, MAX_RESULTS)):][::-1]  # newest first
        results = []
        for uid in uids:
            status, parts = conn.uid("FETCH", uid, "(BODY.PEEK[]<0.30000> FLAGS)")
            raw = next((p[1] for p in parts if isinstance(p, tuple)), b"")
            msg = email.message_from_bytes(raw, policy=email.policy.default)
            flags = b" ".join(p for p in parts if isinstance(p, bytes))
            results.append({
                "uid": uid.decode(), "from": str(msg.get("From", "")), "subject": str(msg.get("Subject", "")),
                "date": str(msg.get("Date", "")), "unread": b"\\Seen" not in flags,
                "snippet": _text_of(msg)[:200].replace("\n", " "),
            })
        return results
    finally:
        try:
            conn.logout()
        except Exception:  # pragma: no cover
            pass


def read(cfg: EmailConfig, uid: str, folder: str = "INBOX") -> dict:
    if not uid.isdigit():
        raise IntegrationError("Message ids are numbers from email_search.")
    conn = _imap(cfg)
    try:
        conn.select(_quote(folder), readonly=True)
        status, parts = conn.uid("FETCH", uid.encode(), "(BODY.PEEK[])")
        raw = next((p[1] for p in parts if isinstance(p, tuple)), None) if status == "OK" else None
        if not raw:
            raise IntegrationError(f"No message {uid} in {folder}.")
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        attachments = [p.get_filename() for p in msg.iter_attachments() if p.get_filename()]
        return {
            "from": str(msg.get("From", "")), "to": str(msg.get("To", "")), "cc": str(msg.get("Cc", "")),
            "subject": str(msg.get("Subject", "")), "date": str(msg.get("Date", "")),
            "body": _text_of(msg)[:BODY_CHARS], "attachments": attachments,
        }
    finally:
        try:
            conn.logout()
        except Exception:  # pragma: no cover
            pass


def validate_recipients(value: str) -> list[str]:
    addresses = [a for _, a in getaddresses([value]) if a]
    if not addresses or any(not _ADDRESS.match(a) for a in addresses):
        raise IntegrationError(f"Invalid email address list: {value!r}")
    if len(addresses) > 20:
        raise IntegrationError("Too many recipients (max 20).")
    return addresses


def send(cfg: EmailConfig, to: str, subject: str, body: str, cc: str = "") -> str:
    if any(c in subject for c in "\r\n"):
        raise IntegrationError("The subject can't contain line breaks.")
    recipients = validate_recipients(to) + (validate_recipients(cc) if cc.strip() else [])
    msg = EmailMessage()
    msg["From"] = cfg.from_address or cfg.username
    msg["To"] = to
    if cc.strip():
        msg["Cc"] = cc
    msg["Subject"] = subject
    msg.set_content(body)
    try:
        if cfg.smtp_security == "ssl":
            server = smtplib.SMTP_SSL(cfg.smtp_host, cfg.smtp_port, timeout=TIMEOUT, context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=TIMEOUT)
            if cfg.smtp_security == "starttls":
                server.starttls(context=ssl.create_default_context())
        with server:
            if cfg.smtp_security != "none" or cfg.password:
                try:
                    server.login(cfg.username, cfg.password)
                except smtplib.SMTPNotSupportedError:
                    if cfg.smtp_security != "none":
                        raise
            server.send_message(msg, to_addrs=recipients)
    except smtplib.SMTPAuthenticationError as exc:
        raise IntegrationError("Email sign-in failed. For Gmail/Outlook, use an app password.") from exc
    except (smtplib.SMTPException, OSError) as exc:
        raise IntegrationError(f"Couldn't send the email: {exc}") from exc
    return f"Sent to {', '.join(recipients)}."


def test(cfg: EmailConfig) -> str:
    conn = _imap(cfg)
    try:
        status, data = conn.select("INBOX", readonly=True)
        count = int(data[0]) if status == "OK" and data and data[0] else 0
    finally:
        conn.logout()
    sender = parseaddr(cfg.from_address or cfg.username)[1]
    return f"Connected. Inbox has {count} messages; mail will be sent as {sender}."
