"""
Pipeline Worker - FASE 4: Data Lake / Continuous Collection Pipeline

FastAPI microservice that runs scheduled background jobs for:
- News collection (every 6 hours)
- Stale company updates (every 12 hours)
- Relationship detection (every 4 hours)
- Embedding generation (every 2 hours)

Also listens to Postgres NOTIFY events on 'pipeline_events' channel
for real-time event-driven processing.
"""

import asyncio
from contextlib import asynccontextmanager
from typing import Any

import asyncpg
import structlog
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import FastAPI
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict

from events.event_bus import start_listener
from events.handlers import handle_event
from storage.spaces_client import SpacesClient
from workers.company_updater import update_stale_companies
from workers.embedding_generator import generate_pending_embeddings
from workers.news_collector import collect_news
from workers.relationship_detector import detect_new_relationships

logger = structlog.get_logger(__name__)


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = ""
    supabase_url: str = ""
    supabase_db_url: str = ""

    backend_base_url: str = "http://localhost:3000"
    openai_api_key: str = ""

    do_spaces_key: str = ""
    do_spaces_secret: str = ""
    do_spaces_region: str = "nyc3"
    do_spaces_bucket: str = "iconsai-data-lake"

    news_interval_hours: int = 6
    company_update_interval_hours: int = 12
    relationship_interval_hours: int = 4
    embedding_interval_hours: int = 2

    @property
    def effective_db_url(self) -> str:
        """Return the first available database URL."""
        return self.database_url or self.supabase_db_url or self.supabase_url


settings = Settings()

# Global references for shared resources
db_pool: asyncpg.Pool | None = None
spaces_client: SpacesClient | None = None
scheduler: AsyncIOScheduler | None = None


async def _setup_db_pool() -> asyncpg.Pool | None:
    """Create asyncpg connection pool."""
    db_url = settings.effective_db_url
    if not db_url:
        logger.warning("No database URL configured. Database features disabled.")
        return None

    try:
        pool = await asyncpg.create_pool(
            dsn=db_url,
            min_size=2,
            max_size=10,
            command_timeout=30,
        )
        logger.info("Database pool created successfully")
        return pool
    except Exception as exc:
        logger.error("Failed to create database pool", error=str(exc))
        return None


def _setup_spaces_client() -> SpacesClient:
    """Create DigitalOcean Spaces client."""
    return SpacesClient(
        access_key=settings.do_spaces_key,
        secret_key=settings.do_spaces_secret,
        region=settings.do_spaces_region,
        bucket=settings.do_spaces_bucket,
    )


def _setup_scheduler(pool: asyncpg.Pool | None, spaces: SpacesClient) -> AsyncIOScheduler:
    """Configure APScheduler with all recurring jobs."""
    sched = AsyncIOScheduler(timezone="UTC")

    sched.add_job(
        collect_news,
        trigger=IntervalTrigger(hours=settings.news_interval_hours),
        kwargs={"db_pool": pool, "backend_base_url": settings.backend_base_url},
        id="news_collector",
        name="News Collector",
        replace_existing=True,
    )

    sched.add_job(
        update_stale_companies,
        trigger=IntervalTrigger(hours=settings.company_update_interval_hours),
        kwargs={"db_pool": pool, "backend_base_url": settings.backend_base_url},
        id="company_updater",
        name="Company Updater",
        replace_existing=True,
    )

    sched.add_job(
        detect_new_relationships,
        trigger=IntervalTrigger(hours=settings.relationship_interval_hours),
        kwargs={"db_pool": pool, "backend_base_url": settings.backend_base_url},
        id="relationship_detector",
        name="Relationship Detector",
        replace_existing=True,
    )

    sched.add_job(
        generate_pending_embeddings,
        trigger=IntervalTrigger(hours=settings.embedding_interval_hours),
        kwargs={
            "db_pool": pool,
            "openai_api_key": settings.openai_api_key,
            "spaces_client": spaces,
        },
        id="embedding_generator",
        name="Embedding Generator",
        replace_existing=True,
    )

    return sched


async def _start_pg_listener(pool: asyncpg.Pool, spaces: SpacesClient) -> None:
    """Start Postgres LISTEN on pipeline_events channel."""
    try:
        conn = await pool.acquire()
        await start_listener(
            conn,
            handler=lambda event: handle_event(
                event,
                db_pool=pool,
                backend_base_url=settings.backend_base_url,
                openai_api_key=settings.openai_api_key,
                spaces_client=spaces,
            ),
        )
        logger.info("Postgres LISTEN started on 'pipeline_events' channel")
    except Exception as exc:
        logger.error("Failed to start Postgres listener", error=str(exc))


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown logic."""
    global db_pool, spaces_client, scheduler

    logger.info("Pipeline Worker starting up")

    # 1. Database pool
    db_pool = await _setup_db_pool()

    # 2. Spaces client
    spaces_client = _setup_spaces_client()

    # 3. Scheduler
    scheduler = _setup_scheduler(db_pool, spaces_client)
    scheduler.start()
    logger.info("Scheduler started with all jobs")

    # 4. Postgres LISTEN (requires active pool)
    if db_pool is not None:
        asyncio.create_task(_start_pg_listener(db_pool, spaces_client))

    yield

    # Shutdown
    logger.info("Pipeline Worker shutting down")

    if scheduler is not None:
        scheduler.shutdown(wait=False)

    if db_pool is not None:
        await db_pool.close()

    logger.info("Pipeline Worker stopped")


app = FastAPI(
    title="Pipeline Worker",
    description="FASE 4 - Data Lake / Continuous Collection Pipeline",
    version="1.0.0",
    lifespan=lifespan,
)


class HealthResponse(BaseModel):
    status: str
    database: str
    spaces: str
    scheduler: str


class JobInfo(BaseModel):
    id: str
    name: str
    next_run: str | None
    trigger: str


class StatusResponse(BaseModel):
    status: str
    jobs: list[JobInfo]
    database_connected: bool
    spaces_configured: bool


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Health check endpoint."""
    db_status = "disconnected"
    if db_pool is not None:
        try:
            async with db_pool.acquire() as conn:
                await conn.fetchval("SELECT 1")
            db_status = "connected"
        except Exception:
            db_status = "error"

    spaces_status = "configured" if spaces_client and spaces_client.is_configured else "not_configured"
    sched_status = "running" if scheduler and scheduler.running else "stopped"

    return HealthResponse(
        status="healthy",
        database=db_status,
        spaces=spaces_status,
        scheduler=sched_status,
    )


@app.get("/status", response_model=StatusResponse)
async def status() -> StatusResponse:
    """Return scheduler job information."""
    jobs: list[JobInfo] = []

    if scheduler is not None:
        for job in scheduler.get_jobs():
            jobs.append(
                JobInfo(
                    id=job.id,
                    name=job.name or job.id,
                    next_run=str(job.next_run_time) if job.next_run_time else None,
                    trigger=str(job.trigger),
                )
            )

    return StatusResponse(
        status="running" if scheduler and scheduler.running else "stopped",
        jobs=jobs,
        database_connected=db_pool is not None,
        spaces_configured=spaces_client is not None and spaces_client.is_configured,
    )
