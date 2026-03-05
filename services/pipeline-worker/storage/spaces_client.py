"""
DigitalOcean Spaces client (S3-compatible).

Provides upload and listing for the data lake.
Path convention:
  iconsai-data-lake/raw/{source}/{yyyy}/{mm}/{dd}/{entity_id}_{timestamp}.json

Degrades gracefully if credentials are not configured.
"""

import json
from datetime import datetime, timezone
from typing import Any

import boto3
import structlog
from botocore.exceptions import BotoCoreError, ClientError

logger = structlog.get_logger(__name__)


class SpacesClient:
    """DigitalOcean Spaces (S3-compatible) client for data lake storage."""

    def __init__(
        self,
        access_key: str,
        secret_key: str,
        region: str = "nyc3",
        bucket: str = "iconsai-data-lake",
    ) -> None:
        self._bucket = bucket
        self._region = region
        self._client: Any | None = None

        if access_key and secret_key:
            try:
                self._client = boto3.client(
                    "s3",
                    region_name=region,
                    endpoint_url=f"https://{region}.digitaloceanspaces.com",
                    aws_access_key_id=access_key,
                    aws_secret_access_key=secret_key,
                )
                logger.info(
                    "Spaces client initialized",
                    region=region,
                    bucket=bucket,
                )
            except Exception as exc:
                logger.warning(
                    "Failed to initialize Spaces client",
                    error=str(exc),
                )
                self._client = None
        else:
            logger.warning(
                "Spaces credentials not configured. Data lake uploads disabled."
            )

    @property
    def is_configured(self) -> bool:
        """Return True if the client has valid credentials."""
        return self._client is not None

    def _build_key(self, source: str, entity_id: str, timestamp: datetime | None = None) -> str:
        """Build the S3 key following the data lake path convention."""
        ts = timestamp or datetime.now(timezone.utc)
        ts_str = ts.strftime("%Y%m%dT%H%M%SZ")
        return (
            f"raw/{source}"
            f"/{ts.strftime('%Y')}"
            f"/{ts.strftime('%m')}"
            f"/{ts.strftime('%d')}"
            f"/{entity_id}_{ts_str}.json"
        )

    async def upload_to_lake(
        self,
        source: str,
        entity_id: str,
        data: dict[str, Any],
        timestamp: datetime | None = None,
    ) -> str | None:
        """
        Upload a JSON document to the data lake.

        Args:
            source: Data source name (e.g. 'brasilapi', 'serper', 'apollo').
            entity_id: Unique entity identifier (e.g. CNPJ, company UUID).
            data: Dictionary to serialize as JSON.
            timestamp: Optional timestamp for path construction.

        Returns:
            The S3 key if upload succeeded, None otherwise.
        """
        if not self.is_configured:
            logger.debug(
                "Spaces not configured, skipping upload",
                source=source,
                entity_id=entity_id,
            )
            return None

        key = self._build_key(source, entity_id, timestamp)

        try:
            body = json.dumps(data, ensure_ascii=False, default=str)
            self._client.put_object(
                Bucket=self._bucket,
                Key=key,
                Body=body.encode("utf-8"),
                ContentType="application/json",
            )
            logger.info("Uploaded to data lake", key=key, size_bytes=len(body))
            return key
        except (BotoCoreError, ClientError) as exc:
            logger.error(
                "Failed to upload to data lake",
                key=key,
                error=str(exc),
            )
            return None
        except Exception as exc:
            logger.error(
                "Unexpected error uploading to data lake",
                key=key,
                error=str(exc),
            )
            return None

    async def list_lake_objects(
        self,
        prefix: str,
        max_keys: int = 100,
    ) -> list[dict[str, Any]]:
        """
        List objects in the data lake under a given prefix.

        Args:
            prefix: S3 key prefix (e.g. 'raw/brasilapi/2026/03').
            max_keys: Maximum number of keys to return.

        Returns:
            List of dicts with 'key', 'size', 'last_modified' fields.
        """
        if not self.is_configured:
            logger.debug("Spaces not configured, returning empty list")
            return []

        try:
            response = self._client.list_objects_v2(
                Bucket=self._bucket,
                Prefix=prefix,
                MaxKeys=max_keys,
            )

            objects: list[dict[str, Any]] = []
            for obj in response.get("Contents", []):
                objects.append({
                    "key": obj["Key"],
                    "size": obj["Size"],
                    "last_modified": obj["LastModified"].isoformat(),
                })

            logger.info(
                "Listed lake objects",
                prefix=prefix,
                count=len(objects),
            )
            return objects
        except (BotoCoreError, ClientError) as exc:
            logger.error(
                "Failed to list lake objects",
                prefix=prefix,
                error=str(exc),
            )
            return []
        except Exception as exc:
            logger.error(
                "Unexpected error listing lake objects",
                prefix=prefix,
                error=str(exc),
            )
            return []
