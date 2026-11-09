"""Visual lessons: upload a slideshow, Claude builds a visual lesson from it."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal

import anyio
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.models import Lesson
from app.services import lessons as svc
from app.services.preferences import load_preferences
from app.services.providers import ClaudeProvider, ProviderError
from app.services.slides import IMAGE_TYPES, MAX_UPLOAD_BYTES, SlideError, extract_slides

router = APIRouter(prefix="/api/lessons", tags=["lessons"])

Level = Literal["intro", "standard", "advanced"]


class LessonSummary(BaseModel):
    id: str
    title: str
    source_name: str
    source_kind: str
    status: str
    error: str | None
    level: str
    slide_count: int
    scenes_ready: int
    position: int
    completed: bool
    created_at: datetime
    updated_at: datetime


class LessonDetail(LessonSummary):
    slides: list[dict]
    overview: dict
    scenes: list[dict]
    progress: dict


class LessonUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    position: int | None = Field(default=None, ge=0, le=1000)
    answer: tuple[int, int] | None = None  # (slide number, chosen option)
    completed: bool | None = None
    reset_progress: bool = False


class RetryBody(BaseModel):
    level: Level | None = None
    rebuild: bool = False  # discard finished scenes and start over


class AskBody(BaseModel):
    slide: int = Field(ge=1, le=1000)
    question: str = Field(min_length=1, max_length=2000)


class AskAnswer(BaseModel):
    answer: str


def _summary(lesson: Lesson, cls=LessonSummary):
    progress = lesson.progress or {}
    extra = {}
    if cls is LessonDetail:
        extra = {"slides": lesson.slides, "overview": lesson.overview, "scenes": lesson.scenes, "progress": progress}
    return cls(
        id=lesson.id, title=lesson.title, source_name=lesson.source_name, source_kind=lesson.source_kind,
        status=lesson.status, error=lesson.error, level=lesson.level, slide_count=len(lesson.slides),
        scenes_ready=len(lesson.scenes), position=int(progress.get("position", 0)),
        completed=bool(progress.get("completed")), created_at=lesson.created_at, updated_at=lesson.updated_at,
        **extra,
    )


async def _owned(db, user_id: str, lesson_id: str) -> Lesson:
    lesson = await db.get(Lesson, lesson_id)
    if lesson is None or lesson.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lesson not found")
    return lesson


def _claude(request: Request) -> ClaudeProvider:
    provider = request.app.state.provider
    if not isinstance(provider, ClaudeProvider):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Claude isn't connected, so lessons can't be built. Add an Anthropic API key in Settings.",
        )
    return provider


async def _model(request: Request, db, user_id: str) -> str:
    prefs = await load_preferences(db, user_id)
    return prefs.model or request.app.state.settings.default_model


def _safe_name(name: str) -> str:
    name = re.sub(r"[\x00-\x1f\x7f/\\]+", " ", name or "").strip()
    return name[:255] or "slides"


@router.get("", response_model=list[LessonSummary])
async def list_lessons(user: CurrentUser, db: DbSession) -> list[LessonSummary]:
    rows = (
        await db.execute(select(Lesson).where(Lesson.user_id == user.id).order_by(Lesson.updated_at.desc()))
    ).scalars()
    return [_summary(lesson) for lesson in rows]


@router.post("", response_model=LessonDetail, status_code=status.HTTP_201_CREATED)
async def create_lesson(
    request: Request,
    user: CurrentUser,
    db: DbSession,
    file: UploadFile = File(...),
    title: str = Form(default="", max_length=200),
    level: Level = Form(default="standard"),
) -> LessonDetail:
    """Upload a slideshow (.pptx, .pdf, .md/.txt). The lesson is built in the background."""
    provider = _claude(request)
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    name = _safe_name(file.filename or "")
    try:
        kind, slides = await anyio.to_thread.run_sync(extract_slides, name, data)
    except SlideError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc

    lesson = Lesson(
        user_id=user.id, title=title.strip() or name.rsplit(".", 1)[0][:200], source_name=name,
        source_kind=kind, level=level, slides=[], status="processing", progress={"position": 0, "answers": {}},
    )
    db.add(lesson)
    await db.flush()
    images: dict[int, str] = {}
    folder = svc.lesson_dir(request.app.state.settings.data_dir, lesson.id)
    for s in slides:
        if s.image:
            folder.mkdir(parents=True, exist_ok=True)
            filename = f"slide-{s.index}.{s.image.extension}"
            (folder / filename).write_bytes(s.image.data)
            images[s.index] = filename
    lesson.slides = svc.slides_to_json(slides, images)
    await db.commit()
    request.app.state.lessons.start(lesson.id, provider=provider, model=await _model(request, db, user.id))
    await db.refresh(lesson)
    return _summary(lesson, LessonDetail)


@router.get("/{lesson_id}", response_model=LessonDetail)
async def get_lesson(lesson_id: str, user: CurrentUser, db: DbSession) -> LessonDetail:
    return _summary(await _owned(db, user.id, lesson_id), LessonDetail)


@router.patch("/{lesson_id}", response_model=LessonSummary)
async def update_lesson(lesson_id: str, body: LessonUpdate, user: CurrentUser, db: DbSession) -> LessonSummary:
    lesson = await _owned(db, user.id, lesson_id)
    progress = {"position": 0, "answers": {}} if body.reset_progress else dict(lesson.progress or {})
    answers = dict(progress.get("answers") or {})
    if body.title is not None:
        lesson.title = body.title.strip()
    if body.position is not None:
        progress["position"] = min(body.position, max(0, len(lesson.slides) + 1))
    if body.answer is not None:
        slide, choice = body.answer
        scene = next((s for s in lesson.scenes if s["slide"] == slide and s.get("check")), None)
        if scene is None or not 0 <= choice < len(scene["check"]["options"]):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That answer doesn't match a question.")
        answers[str(slide)] = choice
    if body.completed is not None:
        progress["completed"] = body.completed
    progress["answers"] = answers
    lesson.progress = progress
    await db.commit()
    await db.refresh(lesson)
    return _summary(lesson)


@router.post("/{lesson_id}/retry", response_model=LessonSummary)
async def retry_lesson(lesson_id: str, body: RetryBody, request: Request, user: CurrentUser, db: DbSession) -> LessonSummary:
    """Continue a failed lesson, or rebuild it (optionally at a different level)."""
    provider = _claude(request)
    lesson = await _owned(db, user.id, lesson_id)
    runner: svc.LessonRunner = request.app.state.lessons
    if runner.is_running(lesson.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "This lesson is still being built.")
    if body.level and body.level != lesson.level:
        lesson.level = body.level
        body.rebuild = True
    if body.rebuild:
        lesson.overview = {}
        lesson.scenes = []
        lesson.progress = {"position": 0, "answers": {}}
    lesson.status = "processing"
    lesson.error = None
    await db.commit()
    runner.start(lesson.id, provider=provider, model=await _model(request, db, user.id))
    await db.refresh(lesson)
    return _summary(lesson)


@router.post("/{lesson_id}/ask", response_model=AskAnswer)
async def ask(lesson_id: str, body: AskBody, request: Request, user: CurrentUser, db: DbSession) -> AskAnswer:
    """Ask the tutor a question about one slide of the lesson."""
    provider = _claude(request)
    lesson = await _owned(db, user.id, lesson_id)
    try:
        answer = await svc.answer_question(
            db, provider, user_id=user.id, model=await _model(request, db, user.id),
            lesson=lesson, slide_index=body.slide, question=body.question.strip(),
        )
    except ProviderError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.user_message) from exc
    return AskAnswer(answer=answer)


@router.get("/{lesson_id}/slides/{index}/image", include_in_schema=False)
async def slide_image(lesson_id: str, index: int, request: Request, user: CurrentUser, db: DbSession) -> FileResponse:
    lesson = await _owned(db, user.id, lesson_id)
    slide = next((s for s in lesson.slides if s["index"] == index), None)
    filename = slide.get("image") if slide else None
    if not filename or not re.fullmatch(r"slide-\d+\.(png|jpg|gif|webp)", filename):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No image for this slide")
    path = svc.lesson_dir(request.app.state.settings.data_dir, lesson.id) / filename
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No image for this slide")
    media = {ext: ct for ct, ext in IMAGE_TYPES.items()}[filename.rsplit(".", 1)[1]]
    return FileResponse(path, media_type=media, headers={"Cache-Control": "private, max-age=3600"})


@router.delete("/{lesson_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_lesson(lesson_id: str, request: Request, user: CurrentUser, db: DbSession) -> None:
    lesson = await _owned(db, user.id, lesson_id)
    runner: svc.LessonRunner = request.app.state.lessons
    runner.cancel(lesson.id)
    await runner.wait(lesson.id)
    await db.delete(lesson)
    await db.commit()
    await anyio.to_thread.run_sync(svc.remove_files, request.app.state.settings.data_dir, lesson_id)
