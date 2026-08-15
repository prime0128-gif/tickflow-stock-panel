"""中国 A 股市场情绪数据接口。

宽度从本地日线统一计算；行业归属和期权 PCR 通过扩展数据接入，避免把供应商
字段或口径硬编码到页面。行业数据需包含 ``symbol`` 与 ``sw_l2``，PCR 数据需
包含 ``date``、``hs300``、``zz500``、``kc50``。
"""
from __future__ import annotations

import math
import threading
import time
from datetime import date
from pathlib import Path
from typing import Any

import polars as pl
from fastapi import APIRouter, Request

from app.services.ext_data import ExtConfigStore

router = APIRouter(prefix="/api/market-sentiment", tags=["market-sentiment"])

_TTL_SECONDS = 300.0
_cache: tuple[float, dict[str, Any]] | None = None
_cache_lock = threading.Lock()
_WATCH_SECTORS = ["半导体材料", "半导体设备", "半导体芯片", "算力租赁", "云服务器", "端侧", "电力", "光通信", "券商", "传媒"]


def _to_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _to_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_to_json(item) for item in value]
    if isinstance(value, (date,)):
        return value.isoformat()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _ext_frame(data_dir: Path, required: set[str]) -> pl.DataFrame:
    """返回第一个覆盖 required 字段的扩展数据集，未配置时返回空表。"""
    store = ExtConfigStore(data_dir)
    for config in store.load_all():
        fields = {field.name for field in config.fields}
        if not required.issubset(fields):
            continue
        root = data_dir / "ext_data" / config.id
        files = list((root / "timeseries").rglob("*.parquet")) if config.mode == "timeseries" else list(root.glob("*.parquet"))
        if not files:
            continue
        try:
            return pl.read_parquet([str(item) for item in files], hive_partitioning=True)
        except Exception:  # noqa: BLE001 - 外部数据不应阻断主看板
            continue
    return pl.DataFrame()


def _daily_frame(data_dir: Path) -> pl.DataFrame:
    daily = data_dir / "kline_daily"
    if not daily.exists():
        return pl.DataFrame()
    files = list(daily.rglob("*.parquet"))
    if not files:
        return pl.DataFrame()
    return (
        pl.scan_parquet([str(item) for item in files], hive_partitioning=True)
        .select(["symbol", "date", "close"])
        .with_columns(pl.col("date").cast(pl.Date))
        .filter(pl.col("close").is_not_null() & (pl.col("close") > 0))
        .sort(["symbol", "date"])
        .with_columns([
            pl.col("close").rolling_mean(window).over("symbol").alias(f"ma{window}")
            for window in (5, 10, 20, 50, 120)
        ])
        .collect()
    )


def _breadth_history(daily: pl.DataFrame) -> tuple[list[dict], pl.DataFrame]:
    if daily.is_empty():
        return [], daily
    history = (
        daily.group_by("date")
        .agg([
            pl.col("close").mean().alias("avg_price"),
            *[
                (pl.col("close") > pl.col(f"ma{window}")).mean().mul(100).alias(f"above_ma{window}")
                for window in (5, 10, 20, 50, 120)
            ],
        ])
        .sort("date")
    )
    return history.to_dicts(), history


def _industry_rank(daily: pl.DataFrame, data_dir: Path) -> dict[str, Any]:
    industry = _ext_frame(data_dir, {"symbol", "sw_l2"})
    if daily.is_empty() or industry.is_empty():
        return {"available": False, "best": [], "worst": []}
    latest_dates = daily.get_column("date").unique().sort()
    if len(latest_dates) < 6:
        return {"available": False, "best": [], "worst": []}
    latest, week_ago = latest_dates[-1], latest_dates[-6]
    members = industry.select(["symbol", "sw_l2"]).unique().with_columns(pl.col("symbol").cast(pl.String))
    snap = daily.filter(pl.col("date").is_in([latest, week_ago])).join(members, on="symbol", how="inner")
    grouped = (
        snap.group_by(["sw_l2", "date"])
        .agg([
            (pl.col("close") > pl.col("ma5")).mean().mul(100).alias("above_ma5"),
            (pl.col("close") > pl.col("ma10")).mean().mul(100).alias("above_ma10"),
            pl.len().alias("stocks"),
        ])
    )
    current = grouped.filter(pl.col("date") == latest).rename({"above_ma5": "ma5", "above_ma10": "ma10", "stocks": "stocks"})
    prior = grouped.filter(pl.col("date") == week_ago).select(["sw_l2", pl.col("above_ma5").alias("ma5_prior"), pl.col("above_ma10").alias("ma10_prior")])
    ranked = (
        current.join(prior, on="sw_l2", how="left")
        .with_columns([
            (pl.col("ma5") - pl.col("ma5_prior")).alias("ma5_week_change"),
            (pl.col("ma10") - pl.col("ma10_prior")).alias("ma10_week_change"),
            ((pl.col("ma5") + pl.col("ma10")) / 2).alias("score"),
        ])
        .sort("score", descending=True)
    )
    rows = ranked.select(["sw_l2", "stocks", "ma5", "ma10", "ma5_week_change", "ma10_week_change"]).to_dicts()
    return {"available": True, "best": rows[:10], "worst": list(reversed(rows[-10:]))}


def _watch_sector_history(daily: pl.DataFrame, data_dir: Path) -> dict[str, Any]:
    sector = _ext_frame(data_dir, {"symbol", "sector"})
    if daily.is_empty() or sector.is_empty():
        return {"available": False, "series": []}
    dates = daily.get_column("date").unique().sort()[-15:]
    members = sector.select(["symbol", "sector"]).unique().filter(pl.col("sector").is_in(_WATCH_SECTORS))
    rows = (
        daily.filter(pl.col("date").is_in(dates)).join(members, on="symbol", how="inner")
        .group_by(["sector", "date"])
        .agg((pl.col("close") > pl.col("ma5")).mean().mul(100).alias("above_ma5"))
        .sort(["sector", "date"])
        .to_dicts()
    )
    return {"available": bool(rows), "series": rows}


def _pcr_history(data_dir: Path) -> dict[str, Any]:
    pcr = _ext_frame(data_dir, {"date", "hs300", "zz500", "kc50"})
    if pcr.is_empty():
        return {"available": False, "series": []}
    rows = (
        pcr.select(["date", "hs300", "zz500", "kc50"])
        .with_columns(pl.col("date").cast(pl.Date))
        .sort("date")
        .tail(120)
        .to_dicts()
    )
    return {"available": True, "series": rows}


@router.get("/dashboard")
def dashboard(request: Request) -> dict[str, Any]:
    """返回市场宽度、行业强弱、重点板块和期权 PCR 的单一快照。"""
    global _cache
    now = time.monotonic()
    with _cache_lock:
        if _cache and now - _cache[0] < _TTL_SECONDS:
            return _cache[1]
    data_dir = request.app.state.repo.store.data_dir
    daily = _daily_frame(data_dir)
    breadth, _ = _breadth_history(daily)
    payload = _to_json({
        "as_of": breadth[-1]["date"] if breadth else None,
        "breadth": breadth,
        "industry": _industry_rank(daily, data_dir),
        "watch_sectors": _watch_sector_history(daily, data_dir),
        "pcr": _pcr_history(data_dir),
        "requirements": {
            "industry": "扩展数据：symbol, sw_l2（申万二级）",
            "watch_sectors": "扩展数据：symbol, sector（重点板块名称）",
            "pcr": "扩展时序数据：date, hs300, zz500, kc50（Put/Call Ratio）",
        },
    })
    with _cache_lock:
        _cache = (now, payload)
    return payload
