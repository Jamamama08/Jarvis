"""Read the text (and the main picture) of each slide in an uploaded slideshow.

Supported: PowerPoint (.pptx), PDF (text per page) and plain text / Markdown, where slides are
separated by a line containing only ``---``. Everything read here is untrusted data.
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass, field

MAX_UPLOAD_BYTES = 40 * 1024 * 1024
MAX_SLIDES = 80
MAX_SLIDE_CHARS = 4_000
MAX_NOTES_CHARS = 2_000
MAX_IMAGE_BYTES = 8 * 1024 * 1024
# A .pptx is a zip: refuse archives that expand to something unreasonable (zip bombs).
MAX_UNZIPPED_BYTES = 400 * 1024 * 1024
MAX_ZIP_ENTRIES = 5_000

#: Only raster formats a browser renders safely; never SVG (it can carry script).
IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}


class SlideError(Exception):
    """The upload can't be turned into slides; the message is safe to show the user."""


@dataclass
class SlideImage:
    content_type: str
    data: bytes

    @property
    def extension(self) -> str:
        return IMAGE_TYPES[self.content_type]


@dataclass
class Slide:
    index: int
    title: str = ""
    text: str = ""
    notes: str = ""
    image: SlideImage | None = field(default=None, repr=False)

    @property
    def has_content(self) -> bool:
        return bool(self.title.strip() or self.text.strip() or self.notes.strip())


def detect_kind(filename: str, data: bytes) -> str:
    name = filename.lower()
    if data[:4] == b"PK\x03\x04" and (name.endswith(".pptx") or not name.endswith((".pdf", ".md", ".txt"))):
        return "pptx"
    if data[:5] == b"%PDF-":
        return "pdf"
    if name.endswith((".md", ".markdown", ".txt")):
        return "text"
    if name.endswith(".ppt"):
        raise SlideError("Old .ppt files aren't supported. Save the deck as .pptx (or PDF) and upload that.")
    if name.endswith(".key"):
        raise SlideError("Keynote files aren't supported. Export the deck as .pptx or PDF and upload that.")
    raise SlideError("Upload a PowerPoint (.pptx), PDF, or Markdown/text file.")


def extract_slides(filename: str, data: bytes) -> tuple[str, list[Slide]]:
    """Returns (kind, slides). Raises SlideError for unreadable or empty decks."""
    if not data:
        raise SlideError("The file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise SlideError(f"The file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
    kind = detect_kind(filename, data)
    try:
        slides = {"pptx": _pptx, "pdf": _pdf, "text": _text}[kind](data)
    except SlideError:
        raise
    except Exception as exc:  # malformed files raise all sorts of parser errors
        raise SlideError("This file couldn't be read. Is it a valid, unencrypted slideshow?") from exc
    slides = [s for s in slides if s.has_content or s.image][:MAX_SLIDES]
    if not any(s.has_content for s in slides):
        raise SlideError(
            "No text was found in this file. Scanned or image-only slides can't be read yet; "
            "export the deck with its text (for example as .pptx)."
        )
    for i, s in enumerate(slides, start=1):
        s.index = i
        s.title = _clip(s.title, 200)
        s.text = _clip(s.text, MAX_SLIDE_CHARS)
        s.notes = _clip(s.notes, MAX_NOTES_CHARS)
    return kind, slides


def _clip(text: str, limit: int) -> str:
    text = re.sub(r"(?<=\S)[ \t\u00a0]+", " ", text or "")  # keeps leading indentation (bullet levels)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


# --- PowerPoint ---------------------------------------------------------------------------


def _check_zip(data: bytes) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            infos = zf.infolist()
    except zipfile.BadZipFile as exc:
        raise SlideError("This file couldn't be read. Is it a valid .pptx?") from exc
    if len(infos) > MAX_ZIP_ENTRIES or sum(i.file_size for i in infos) > MAX_UNZIPPED_BYTES:
        raise SlideError("This presentation is too large to process.")


def _pptx(data: bytes) -> list[Slide]:
    _check_zip(data)
    from pptx import Presentation  # imported lazily: only needed for uploads
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    prs = Presentation(io.BytesIO(data))
    slides: list[Slide] = []

    def walk(shapes):
        for shape in shapes:
            if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
                yield from walk(shape.shapes)
            else:
                yield shape

    for n, pslide in enumerate(prs.slides, start=1):
        if n > MAX_SLIDES * 2:
            break
        slide = Slide(index=n)
        title_shape = pslide.shapes.title
        if title_shape is not None and title_shape.has_text_frame:
            slide.title = title_shape.text_frame.text.strip()
        lines: list[str] = []
        best_area = 0
        for shape in walk(pslide.shapes):
            if title_shape is not None and shape.shape_id == title_shape.shape_id:
                continue
            if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
                for p in shape.text_frame.paragraphs:
                    t = "".join(r.text for r in p.runs).strip() or p.text.strip()
                    if t:
                        lines.append(("  " * p.level) + "- " + t)
            elif getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    cells = [c.text.strip().replace("\n", " ") for c in row.cells]
                    if any(cells):
                        lines.append("| " + " | ".join(cells) + " |")
            elif getattr(shape, "has_chart", False) and shape.has_chart:
                lines.extend(_chart_lines(shape.chart))
            if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                try:
                    image = shape.image
                    area = int(shape.width or 0) * int(shape.height or 0)
                    if image.content_type in IMAGE_TYPES and len(image.blob) <= MAX_IMAGE_BYTES and area >= best_area:
                        slide.image = SlideImage(image.content_type, image.blob)
                        best_area = area
                except Exception:  # linked or broken pictures
                    pass
        slide.text = "\n".join(lines)
        if pslide.has_notes_slide and pslide.notes_slide.notes_text_frame is not None:
            slide.notes = pslide.notes_slide.notes_text_frame.text
        slides.append(slide)
    return slides


def _chart_lines(chart) -> list[str]:
    lines = []
    try:
        if chart.has_title and chart.chart_title.has_text_frame:
            lines.append(f"Chart: {chart.chart_title.text_frame.text.strip()}")
        categories = [str(c) for c in chart.plots[0].categories] if chart.plots else []
        for series in chart.series:
            values = list(series.values)
            pairs = ", ".join(f"{c}: {v}" for c, v in zip(categories, values)) if categories else ", ".join(map(str, values))
            lines.append(f"Series {series.name}: {pairs}")
    except Exception:
        pass
    return lines


# --- PDF ------------------------------------------------------------------------------------


def _pdf(data: bytes) -> list[Slide]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        raise SlideError("This PDF is password-protected. Remove the password and upload it again.")
    slides = []
    for n, page in enumerate(reader.pages, start=1):
        if n > MAX_SLIDES * 2:
            break
        text = (page.extract_text() or "").strip()
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        title = lines[0] if lines and len(lines[0]) <= 120 else ""
        body = "\n".join(lines[1:] if title else lines)
        slides.append(Slide(index=n, title=title, text=body))
    return slides


# --- Plain text / Markdown ------------------------------------------------------------------


def _text(data: bytes) -> list[Slide]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("latin-1")
    chunks = re.split(r"^\s*---+\s*$", text.replace("\r\n", "\n"), flags=re.M)
    if len(chunks) == 1:  # no separators: one slide per top-level heading
        chunks = re.split(r"(?m)^(?=#{1,2} )", text)
    slides = []
    for n, chunk in enumerate(c for c in chunks if c.strip()):
        lines = chunk.strip().splitlines()
        title = ""
        if lines and lines[0].lstrip().startswith("#"):
            title = lines.pop(0).lstrip("#").strip()
        slides.append(Slide(index=n + 1, title=title, text="\n".join(lines).strip()))
    return slides
