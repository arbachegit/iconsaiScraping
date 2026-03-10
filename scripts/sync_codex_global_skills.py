#!/usr/bin/env python3
"""Synchronize patched Codex global skills into ~/.codex/skills.

By default this writes to ~/.codex/skills. Use --output-dir to test the generated
files in a temporary directory before applying them globally.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import sys
from datetime import datetime


PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = PROJECT_ROOT / "scripts" / "codex_skill_fixes"
DEFAULT_OUTPUT_DIR = Path.home() / ".codex" / "skills"

SKILLS = {
    "skill-deploy": TEMPLATES_DIR / "skill-deploy.SKILL.md",
    "skill-versioning": TEMPLATES_DIR / "skill-versioning.SKILL.md",
}


def sync_skill(skill_name: str, template_path: Path, output_dir: Path) -> Path:
    if not template_path.exists():
        raise FileNotFoundError(f"Template not found: {template_path}")

    destination_dir = output_dir / skill_name
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination_file = destination_dir / "SKILL.md"

    if destination_file.exists():
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        backup_path = destination_dir / f"SKILL.md.bak.{timestamp}"
        shutil.copy2(destination_file, backup_path)

    shutil.copy2(template_path, destination_file)
    return destination_file


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Destination base directory for Codex skills (default: ~/.codex/skills)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only print what would be updated.",
    )
    args = parser.parse_args()

    output_dir = args.output_dir.expanduser().resolve()

    for skill_name, template_path in SKILLS.items():
        destination_file = output_dir / skill_name / "SKILL.md"
        if args.dry_run:
            print(f"[dry-run] {template_path} -> {destination_file}")
            continue

        written = sync_skill(skill_name, template_path, output_dir)
        print(f"[ok] {written}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
