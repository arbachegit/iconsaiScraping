"""
Stats Snapshot Cron Job
Executa a cada 5 minutos para atualizar estatisticas do dashboard.
"""

import asyncio
import os
from datetime import datetime

import httpx
import structlog
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

from config.settings import settings

logger = structlog.get_logger()

# Intervalo de atualizacao em minutos
SNAPSHOT_INTERVAL_MINUTES = 5


class StatsSnapshotJob:
    """Job para criar snapshots de estatisticas."""

    def __init__(self):
        self.scheduler = AsyncIOScheduler()
        self.last_run: datetime | None = None
        self.run_count = 0
        self.error_count = 0

    async def create_snapshot(self) -> dict:
        """
        Cria snapshot chamando o endpoint /api/stats/snapshot.
        """
        try:
            # URL do backend Python (usar env var em produção)
            base_url = os.getenv("PYTHON_API_URL", "http://localhost:8000")

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(f"{base_url}/api/stats/snapshot")
                response.raise_for_status()

                result = response.json()
                self.last_run = datetime.now()
                self.run_count += 1

                logger.info(
                    "stats_snapshot_job_success",
                    run_count=self.run_count,
                    data=result.get("data"),
                )

                return result

        except httpx.HTTPStatusError as e:
            self.error_count += 1
            logger.error(
                "stats_snapshot_job_http_error",
                status_code=e.response.status_code,
                error=str(e),
            )
            raise

        except Exception as e:
            self.error_count += 1
            logger.error("stats_snapshot_job_error", error=str(e))
            raise

    def start(self):
        """Inicia o scheduler com intervalo de 5 minutos."""
        self.scheduler.add_job(
            self.create_snapshot,
            trigger=IntervalTrigger(minutes=SNAPSHOT_INTERVAL_MINUTES),
            id="stats_snapshot",
            name="Stats Snapshot Job",
            replace_existing=True,
        )

        self.scheduler.start()
        logger.info(
            "stats_snapshot_scheduler_started",
            interval_minutes=SNAPSHOT_INTERVAL_MINUTES,
        )

    def stop(self):
        """Para o scheduler."""
        self.scheduler.shutdown()
        logger.info("stats_snapshot_scheduler_stopped")

    def get_status(self) -> dict:
        """Retorna status do job."""
        return {
            "running": self.scheduler.running,
            "last_run": self.last_run.isoformat() if self.last_run else None,
            "run_count": self.run_count,
            "error_count": self.error_count,
            "interval_minutes": SNAPSHOT_INTERVAL_MINUTES,
            "next_run": self._get_next_run(),
        }

    def _get_next_run(self) -> str | None:
        """Retorna proxima execucao."""
        job = self.scheduler.get_job("stats_snapshot")
        if job and job.next_run_time:
            return job.next_run_time.isoformat()
        return None


# Instancia global
stats_snapshot_job = StatsSnapshotJob()


async def run_once():
    """Executa snapshot uma vez (para testes)."""
    job = StatsSnapshotJob()
    result = await job.create_snapshot()
    print(f"Snapshot criado: {result}")
    return result


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Stats Snapshot Cron Job")
    parser.add_argument(
        "--run-now",
        action="store_true",
        help="Executa snapshot imediatamente",
    )
    parser.add_argument(
        "--daemon",
        action="store_true",
        help="Inicia scheduler como daemon",
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="Mostra status do job",
    )

    args = parser.parse_args()

    if args.run_now:
        asyncio.run(run_once())
    elif args.daemon:
        job = StatsSnapshotJob()
        job.start()
        try:
            asyncio.get_event_loop().run_forever()
        except (KeyboardInterrupt, SystemExit):
            job.stop()
    elif args.status:
        print(f"Interval: {SNAPSHOT_INTERVAL_MINUTES} minutes")
        print(f"Supabase configured: {settings.has_supabase}")
    else:
        parser.print_help()
