"""
Cron Jobs para IconsAI Scraping
"""

from api.cron.stats_snapshot import StatsSnapshotJob, stats_snapshot_job

__all__ = ["StatsSnapshotJob", "stats_snapshot_job"]
