"""
Backfill graph relationships from existing data.

Populates fato_relacoes_entidades by detecting relationships from:
1. Sócios (fato_transacao_empresas) -> societaria edges
2. CNAE similarity (fato_regime_tributario) -> cnae_similar edges
3. Geographic proximity (dim_empresas.cidade) -> geografico edges
4. News mentions (dim_noticias) -> mencionado_em edges

Usage:
    python scripts/backfill_graph_relationships.py
    python scripts/backfill_graph_relationships.py --type socios
    python scripts/backfill_graph_relationships.py --type cnae
    python scripts/backfill_graph_relationships.py --type geo
    python scripts/backfill_graph_relationships.py --type news
"""

import argparse
import os
import sys
from typing import Optional

import httpx
import structlog

logger = structlog.get_logger()

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

HEADERS = {}


def init_headers() -> None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        logger.error("missing_env", msg="SUPABASE_URL and SUPABASE_SERVICE_KEY required")
        sys.exit(1)
    global HEADERS
    HEADERS = {
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_KEY,
        "Prefer": "return=minimal",
    }


def supabase_get(table: str, select: str = "*", params: Optional[dict] = None) -> list:
    """GET from Supabase REST API."""
    url = f"{SUPABASE_URL}/rest/v1/{table}?select={select}"
    if params:
        for k, v in params.items():
            url += f"&{k}={v}"
    headers = {**HEADERS, "Prefer": "return=representation"}
    resp = httpx.get(url, headers=headers, timeout=30)
    if resp.status_code >= 400:
        logger.error("supabase_get_error", table=table, status=resp.status_code, body=resp.text[:200])
        return []
    return resp.json() if resp.text else []


def upsert_relationship(rel: dict) -> bool:
    """Upsert a relationship into fato_relacoes_entidades."""
    url = f"{SUPABASE_URL}/rest/v1/fato_relacoes_entidades"
    headers = {
        **HEADERS,
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    resp = httpx.post(url, json=rel, headers=headers, timeout=15)
    if resp.status_code >= 400:
        # 409 = duplicate, which is fine (idempotent)
        if resp.status_code != 409:
            logger.warn("upsert_error", status=resp.status_code, body=resp.text[:200])
            return False
    return True


def backfill_socios() -> int:
    """Create societaria edges from fato_transacao_empresas."""
    logger.info("backfill_socios_start")
    transacoes = supabase_get(
        "fato_transacao_empresas",
        "pessoa_id,empresa_id,cargo,qualificacao,data_transacao,ativo",
        {"ativo": "eq.true", "limit": "5000"},
    )

    if not transacoes:
        logger.info("backfill_socios_skip", msg="No transactions found")
        return 0

    created = 0
    strength_map = {
        "ADMINISTRADOR": 1.0,
        "PRESIDENTE": 1.0,
        "DIRETOR": 0.9,
        "SOCIO-ADMINISTRADOR": 0.9,
        "SOCIO": 0.8,
        "CONSELHEIRO": 0.6,
        "PROCURADOR": 0.5,
    }

    for tx in transacoes:
        cargo = (tx.get("cargo") or tx.get("qualificacao") or "").upper()
        strength = 0.5
        for keyword, value in strength_map.items():
            if keyword in cargo:
                strength = value
                break

        ok = upsert_relationship({
            "source_type": "pessoa",
            "source_id": str(tx["pessoa_id"]),
            "target_type": "empresa",
            "target_id": str(tx["empresa_id"]),
            "tipo_relacao": "societaria",
            "strength": strength,
            "confidence": 0.95,
            "bidirecional": True,
            "source": "backfill",
            "detection_method": "socios_qsa",
            "metadata": {"cargo": tx.get("cargo"), "qualificacao": tx.get("qualificacao")},
            "descricao": f"{cargo or 'Sócio'} da empresa",
            "data_inicio": tx.get("data_transacao"),
        })
        if ok:
            created += 1

    logger.info("backfill_socios_complete", total=len(transacoes), created=created)
    return created


def backfill_cnae() -> int:
    """Create cnae_similar edges for companies with the same CNAE principal."""
    logger.info("backfill_cnae_start")
    regimes = supabase_get(
        "fato_regime_tributario",
        "empresa_id,cnae_principal",
        {"ativo": "eq.true", "cnae_principal": "not.is.null", "limit": "5000"},
    )

    if not regimes:
        logger.info("backfill_cnae_skip", msg="No regime data found")
        return 0

    # Group by CNAE
    cnae_groups: dict[str, list[str]] = {}
    for r in regimes:
        cnae = r.get("cnae_principal")
        if cnae:
            cnae_groups.setdefault(cnae, []).append(str(r["empresa_id"]))

    created = 0
    for cnae, empresa_ids in cnae_groups.items():
        if len(empresa_ids) < 2:
            continue
        # Create pairwise edges (limit to first 20 per CNAE to avoid explosion)
        ids = empresa_ids[:20]
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                ok = upsert_relationship({
                    "source_type": "empresa",
                    "source_id": ids[i],
                    "target_type": "empresa",
                    "target_id": ids[j],
                    "tipo_relacao": "cnae_similar",
                    "strength": 0.3,
                    "confidence": 0.9,
                    "bidirecional": True,
                    "source": "backfill",
                    "detection_method": "cnae_match",
                    "metadata": {"cnae": cnae},
                    "descricao": f"Mesmo CNAE: {cnae}",
                })
                if ok:
                    created += 1

    logger.info("backfill_cnae_complete", cnae_groups=len(cnae_groups), created=created)
    return created


def backfill_geo() -> int:
    """Create geografico edges for companies in the same city."""
    logger.info("backfill_geo_start")
    empresas = supabase_get(
        "dim_empresas",
        "id,cidade,estado",
        {"cidade": "not.is.null", "limit": "5000"},
    )

    if not empresas:
        logger.info("backfill_geo_skip", msg="No company location data found")
        return 0

    # Group by city+state
    geo_groups: dict[str, list[str]] = {}
    for e in empresas:
        cidade = e.get("cidade")
        estado = e.get("estado", "")
        if cidade:
            key = f"{cidade.upper()}|{estado.upper()}" if estado else cidade.upper()
            geo_groups.setdefault(key, []).append(str(e["id"]))

    created = 0
    for geo_key, empresa_ids in geo_groups.items():
        if len(empresa_ids) < 2:
            continue
        cidade, _, estado = geo_key.partition("|")
        # Create pairwise edges (limit to first 15 per city)
        ids = empresa_ids[:15]
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                ok = upsert_relationship({
                    "source_type": "empresa",
                    "source_id": ids[i],
                    "target_type": "empresa",
                    "target_id": ids[j],
                    "tipo_relacao": "geografico",
                    "strength": 0.2,
                    "confidence": 0.85,
                    "bidirecional": True,
                    "source": "backfill",
                    "detection_method": "geo_match",
                    "metadata": {"cidade": cidade, "estado": estado},
                    "descricao": f"Mesma cidade: {cidade}/{estado}",
                })
                if ok:
                    created += 1

    logger.info("backfill_geo_complete", cities=len(geo_groups), created=created)
    return created


def backfill_news() -> int:
    """Create mencionado_em edges from news mentions."""
    logger.info("backfill_news_start")
    empresas = supabase_get(
        "dim_empresas",
        "id,razao_social,nome_fantasia",
        {"limit": "1000"},
    )

    noticias = supabase_get(
        "dim_noticias",
        "id,titulo,conteudo",
        {"limit": "1000"},
    )

    if not empresas or not noticias:
        logger.info("backfill_news_skip", msg="No companies or news found")
        return 0

    created = 0
    for empresa in empresas:
        name = empresa.get("nome_fantasia") or empresa.get("razao_social") or ""
        if len(name) < 3:
            continue

        # Simple text search in news titles/content
        search_name = name.upper()
        for noticia in noticias:
            titulo = (noticia.get("titulo") or "").upper()
            conteudo = (noticia.get("conteudo") or "").upper()

            if search_name in titulo or search_name in conteudo:
                ok = upsert_relationship({
                    "source_type": "empresa",
                    "source_id": str(empresa["id"]),
                    "target_type": "noticia",
                    "target_id": str(noticia["id"]),
                    "tipo_relacao": "mencionado_em",
                    "strength": 0.6,
                    "confidence": 0.7,
                    "bidirecional": False,
                    "source": "backfill",
                    "detection_method": "news_mention",
                    "metadata": {"titulo": noticia.get("titulo", "")[:100]},
                    "descricao": f"Mencionado em: {noticia.get('titulo', '')[:80]}",
                })
                if ok:
                    created += 1

    logger.info("backfill_news_complete", empresas=len(empresas), noticias=len(noticias), created=created)
    return created


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill graph relationships")
    parser.add_argument(
        "--type",
        choices=["socios", "cnae", "geo", "news", "all"],
        default="all",
        help="Type of relationships to backfill",
    )
    args = parser.parse_args()

    init_headers()

    total = 0

    if args.type in ("socios", "all"):
        total += backfill_socios()

    if args.type in ("cnae", "all"):
        total += backfill_cnae()

    if args.type in ("geo", "all"):
        total += backfill_geo()

    if args.type in ("news", "all"):
        total += backfill_news()

    logger.info("backfill_complete", type=args.type, total_created=total)


if __name__ == "__main__":
    main()
