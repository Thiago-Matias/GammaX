from flask import Flask, jsonify, send_from_directory, request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import json
import urllib.request
import urllib.parse
import time
import math
import os

import yfinance as yf
from dotenv import load_dotenv


# ============================================================
# ENV
# ============================================================

load_dotenv()

TWELVE_DATA_API_KEY = os.getenv(
    "TWELVE_DATA_API_KEY"
)


# ============================================================
# FLASK
# ============================================================

app = Flask(
    __name__,
    static_folder="."
)


# ============================================================
# CONFIGURAÇÃO
# ============================================================

GLD_SYMBOL = "GLD"
GC_SYMBOL = "GC=F"
XAU_SYMBOL = "XAUUSD=X"

TWELVE_XAU_SYMBOL = "XAU/USD"

MARKET_TZ = ZoneInfo(
    "America/New_York"
)

BRAZIL_TZ = ZoneInfo(
    "America/Sao_Paulo"
)

UTC_TZ = timezone.utc


# ============================================================
# INTERVALOS
# ============================================================

ALGOX_POLL_SECONDS = 60

ALGOX_MAX_AGE_SECONDS = 600

# ============================================================
# REGRA TEMPORAL
#
# AlgoX:
#
#     updated = 10:30:00
#
# GC/XAU:
#
#     alvo = 10:15:00
#
# O GLD NÃO recebe offset.
#
# ============================================================

SNAPSHOT_PRICE_OFFSET_MINUTES = 15

MAX_SNAPSHOT_PRICE_DISTANCE_SECONDS = 300

# Diferença máxima permitida entre o candle GC e XAU.
#
# 60 segundos porque ambos são candles de 1 minuto.
MAX_GC_XAU_TIMESTAMP_DIFFERENCE_SECONDS = 60


# ============================================================
# CACHE PRINCIPAL
# ============================================================

gamma_state = {

    "algox": None,

    "market": None,

    "data": None,

    "last_check": 0,

    "last_as_of": None

}


# ============================================================
# UTILITÁRIOS
# ============================================================

def safe_float(value):

    try:

        if value is None:
            return None

        value = float(value)

        if not math.isfinite(value):
            return None

        return value

    except Exception:

        return None


def now_ny():

    return datetime.now(
        MARKET_TZ
    )


def now_br():

    return datetime.now(
        BRAZIL_TZ
    )


def parse_datetime(value):

    if not value:
        return None

    if isinstance(
        value,
        datetime
    ):

        dt = value

    else:

        text_value = str(
            value
        ).strip()

        if not text_value:
            return None

        if text_value.endswith("Z"):

            text_value = (
                text_value[:-1]
                + "+00:00"
            )

        try:

            dt = datetime.fromisoformat(
                text_value
            )

        except Exception:

            return None

    if dt.tzinfo is None:

        dt = dt.replace(
            tzinfo=UTC_TZ
        )

    return dt


def format_timestamp(dt):

    if dt is None:

        return {

            "iso": None,
            "ny": None,
            "br": None

        }

    ny = dt.astimezone(
        MARKET_TZ
    )

    br = dt.astimezone(
        BRAZIL_TZ
    )

    return {

        "iso":
            dt.astimezone(
                UTC_TZ
            ).isoformat(),

        "ny":
            ny.strftime(
                "%H:%M:%S"
            ),

        "br":
            br.strftime(
                "%H:%M:%S"
            )

    }


def build_capture_metadata(
    captured_at,
    source_as_of=None
):

    captured_ts = format_timestamp(
        captured_at
    )

    source_dt = parse_datetime(
        source_as_of
    )

    source_ts = format_timestamp(
        source_dt
    )

    delay_seconds = None

    if (
        captured_at is not None
        and
        source_dt is not None
    ):

        delay_seconds = (
            captured_at.astimezone(
                UTC_TZ
            )
            -
            source_dt.astimezone(
                UTC_TZ
            )
        ).total_seconds()

    return {

        "snapshot_disponibilizado_utc":
            source_ts["iso"],

        "snapshot_disponibilizado_ny":
            source_ts["ny"],

        "snapshot_disponibilizado_br":
            source_ts["br"],

        "capturado_utc":
            captured_ts["iso"],

        "capturado_ny":
            captured_ts["ny"],

        "capturado_br":
            captured_ts["br"],

        "delay_seconds":
            delay_seconds

    }


# ============================================================
# HTTP JSON
# ============================================================

def http_json(
    url,
    headers=None,
    timeout=15
):

    req = urllib.request.Request(
        url,
        headers=headers or {}
    )

    with urllib.request.urlopen(
        req,
        timeout=timeout
    ) as response:

        raw = response.read()

    return json.loads(
        raw.decode("utf-8")
    )


# ============================================================
# NORMALIZAR ÍNDICE YAHOO
# ============================================================

def normalize_yahoo_index(
    history
):

    if history is None or history.empty:

        return history

    if history.index.tz is None:

        history.index = (
            history.index
            .tz_localize(
                UTC_TZ
            )
        )

    history.index = (
        history.index
        .tz_convert(
            MARKET_TZ
        )
    )

    return history


# ============================================================
# HISTÓRICO YAHOO
# ============================================================

def get_yahoo_history(
    symbol,
    period="5d",
    interval="1m"
):

    print(
        f"Buscando histórico Yahoo: {symbol}"
    )

    ticker = yf.Ticker(
        symbol
    )

    try:

        history = ticker.history(
            period=period,
            interval=interval,
            prepost=True,
            auto_adjust=False
        )

    except Exception as e:

        print(
            f"Yahoo history {symbol} falhou:",
            e
        )

        return None

    if history is None or history.empty:

        print(
            f"Yahoo não retornou histórico para {symbol}."
        )

        return None

    history = normalize_yahoo_index(
        history
    )

    return history


# ============================================================
# PREÇO ATUAL YAHOO
#
# Mantida apenas para outras partes antigas do sistema,
# como a âncora.
#
# NÃO é utilizada como fallback de GC/XAU do Gamma.
# ============================================================

def get_yahoo_current_price(
    symbol,
    return_metadata=False
):

    print(
        f"Buscando cotação atual Yahoo: {symbol}"
    )

    ticker = yf.Ticker(
        symbol
    )

    current_time = now_ny()

    try:

        fast = ticker.fast_info

        candidates = [

            fast.get(
                "last_price"
            ),

            fast.get(
                "regular_market_price"
            )

        ]

        for value in candidates:

            value = safe_float(
                value
            )

            if (
                value is not None
                and
                value > 0
            ):

                result = {

                    "price":
                        value,

                    "captured_at":
                        current_time,

                    "source":
                        "yahoo_current",

                    "status":
                        "ok"

                }

                if return_metadata:

                    return result

                return value

    except Exception as e:

        print(
            f"fast_info {symbol} falhou:",
            e
        )

    try:

        history = get_yahoo_history(
            symbol,
            period="1d",
            interval="1m"
        )

        if history is not None:

            close = (
                history["Close"]
                .dropna()
            )

            if not close.empty:

                last_index = close.index[-1]

                value = safe_float(
                    close.iloc[-1]
                )

                if (
                    value is not None
                    and
                    value > 0
                ):

                    actual_dt = (
                        last_index.to_pydatetime()
                    )

                    result = {

                        "price":
                            value,

                        "captured_at":
                            actual_dt,

                        "source":
                            "yahoo_history_current",

                        "status":
                            "ok"

                    }

                    if return_metadata:

                        return result

                    return value

    except Exception as e:

        print(
            f"history current {symbol} falhou:",
            e
        )

    raise RuntimeError(
        f"Yahoo não retornou preço atual válido para {symbol}."
    )


# ============================================================
# PREÇO YAHOO HISTÓRICO NO HORÁRIO ALVO
#
# IMPORTANTE:
#
# Usa OPEN.
#
# Não usa Close.
# Não usa preço atual.
#
# ============================================================

def get_yahoo_price_at(
    symbol,
    target_dt,
    max_distance_seconds=MAX_SNAPSHOT_PRICE_DISTANCE_SECONDS
):

    if target_dt is None:

        raise RuntimeError(
            f"Horário alvo inválido para {symbol}."
        )

    target_dt = target_dt.astimezone(
        MARKET_TZ
    )

    print()
    print(
        "------------------------------------------"
    )

    print(
        f"Buscando {symbol} no horário alvo:"
    )

    print(
        target_dt.strftime(
            "%Y-%m-%d %H:%M:%S ET"
        )
    )

    history = get_yahoo_history(
        symbol,
        period="5d",
        interval="1m"
    )

    if history is None or history.empty:

        raise RuntimeError(
            f"Yahoo não retornou histórico para {symbol}."
        )

    opens = (
        history["Open"]
        .dropna()
    )

    if opens.empty:

        raise RuntimeError(
            f"Yahoo não possui OPEN válido para {symbol}."
        )

    best_index = None
    best_distance = None

    for index in opens.index:

        dt = index.to_pydatetime()

        distance = abs(
            (
                dt
                -
                target_dt
            ).total_seconds()
        )

        if (
            best_distance is None
            or
            distance < best_distance
        ):

            best_distance = distance
            best_index = index

    if (
        best_index is None
        or
        best_distance is None
    ):

        raise RuntimeError(
            f"{symbol} não possui candle próximo ao horário solicitado."
        )

    if (
        best_distance
        >
        max_distance_seconds
    ):

        nearest_dt = (
            best_index
            .to_pydatetime()
        )

        raise RuntimeError(

            f"{symbol} não possui candle próximo de "
            f"{target_dt:%H:%M:%S} ET. "

            f"Mais próximo: "
            f"{nearest_dt:%H:%M:%S} ET. "

            f"Diferença: "
            f"{best_distance:.0f}s."
        )

    value = safe_float(
        opens.loc[
            best_index
        ]
    )

    if (
        value is None
        or
        value <= 0
    ):

        raise RuntimeError(
            f"OPEN inválido do Yahoo para {symbol}."
        )

    actual_dt = (
        best_index
        .to_pydatetime()
    )

    print(
        f"{symbol} OPEN:",
        value
    )

    print(
        "Horário do candle utilizado:",
        actual_dt.strftime(
            "%Y-%m-%d %H:%M:%S ET"
        )
    )

    print(
        "Diferença:",
        round(
            best_distance,
            2
        ),
        "segundos"
    )

    print(
        "------------------------------------------"
    )

    return {

        "price":
            value,

        "target_at":
            target_dt,

        "price_at":
            actual_dt,

        "distance_seconds":
            best_distance,

        "source":
            "yahoo_history_open",

        "price_type":
            "open",

        "status":
            "ok",

        "price_mode":
            "snapshot"

    }


# ============================================================
# GC HISTÓRICO
#
# SEM FALLBACK PARA PREÇO ATUAL.
#
# ============================================================

def get_gc_price_at(
    target_dt
):

    try:

        result = get_yahoo_price_at(
            GC_SYMBOL,
            target_dt
        )

        result["source"] = (
            "yahoo_gc_history_open"
        )

        return result

    except Exception as e:

        print()
        print(
            "GC histórico falhou:"
        )

        print(
            str(e)
        )

        raise RuntimeError(

            "GC não possui candle histórico "
            "no horário alvo. "
            +
            str(e)

        )


# ============================================================
# TWELVE DATA - XAU HISTÓRICO
#
# Usa OPEN.
#
# ============================================================

def get_twelve_xau_price_at(
    target_dt,
    max_distance_seconds=MAX_SNAPSHOT_PRICE_DISTANCE_SECONDS
):

    if not TWELVE_DATA_API_KEY:

        raise RuntimeError(
            "TWELVE_DATA_API_KEY não configurada."
        )

    if target_dt is None:

        raise RuntimeError(
            "Horário alvo inválido para XAU."
        )

    target_dt = target_dt.astimezone(
        MARKET_TZ
    )

    print()
    print(
        "------------------------------------------"
    )

    print(
        "Buscando XAU histórico Twelve Data"
    )

    print(
        "Alvo:",
        target_dt.strftime(
            "%Y-%m-%d %H:%M:%S ET"
        )
    )

    # --------------------------------------------------------
    # Pequena janela em torno do alvo.
    #
    # Isso evita depender de um único candle exato.
    # --------------------------------------------------------

    start_dt = (
        target_dt
        -
        timedelta(
            minutes=5
        )
    )

    end_dt = (
        target_dt
        +
        timedelta(
            minutes=5
        )
    )

    params = urllib.parse.urlencode({

        "symbol":
            TWELVE_XAU_SYMBOL,

        "interval":
            "1min",

        "start_date":
            start_dt.strftime(
                "%Y-%m-%d %H:%M:%S"
            ),

        "end_date":
            end_dt.strftime(
                "%Y-%m-%d %H:%M:%S"
            ),

        "timezone":
            "America/New_York",

        "apikey":
            TWELVE_DATA_API_KEY

    })

    url = (
        "https://api.twelvedata.com/time_series?"
        +
        params
    )

    try:

        data = http_json(

            url,

            headers={
                "User-Agent":
                    "GLD-GC-XAU-Gamma/7.0"
            },

            timeout=15
        )

    except Exception as e:

        raise RuntimeError(
            "Twelve Data XAU histórico não respondeu: "
            +
            str(e)
        )

    if not isinstance(
        data,
        dict
    ):

        raise RuntimeError(
            "Twelve Data retornou formato inválido."
        )

    if data.get(
        "status"
    ) == "error":

        raise RuntimeError(

            "Twelve Data XAU: "
            +
            str(
                data.get(
                    "message",
                    "erro desconhecido"
                )
            )

        )

    values = data.get(
        "values"
    )

    if not isinstance(
        values,
        list
    ) or not values:

        raise RuntimeError(
            "Twelve Data não retornou histórico XAU."
        )

    best = None
    best_distance = None

    for candle in values:

        if not isinstance(
            candle,
            dict
        ):

            continue

        timestamp = candle.get(
            "datetime"
        )

        if not timestamp:

            continue

        try:

            candle_dt = datetime.strptime(
                timestamp,
                "%Y-%m-%d %H:%M:%S"
            ).replace(
                tzinfo=MARKET_TZ
            )

        except Exception:

            continue

        distance = abs(
            (
                candle_dt
                -
                target_dt
            ).total_seconds()
        )

        if (
            best_distance is None
            or
            distance < best_distance
        ):

            best_distance = distance
            best = candle

    if best is None:

        raise RuntimeError(
            "Nenhum candle XAU próximo do horário alvo."
        )

    if (
        best_distance
        >
        max_distance_seconds
    ):

        raise RuntimeError(

            f"XAU Twelve Data não possui candle próximo de "
            f"{target_dt:%H:%M:%S} ET. "

            f"Diferença: "
            f"{best_distance:.0f}s."

        )

    value = safe_float(
        best.get(
            "open"
        )
    )

    if (
        value is None
        or
        value <= 0
    ):

        raise RuntimeError(
            "Twelve Data não retornou OPEN XAU válido."
        )

    actual_dt = (
        datetime.strptime(
            best["datetime"],
            "%Y-%m-%d %H:%M:%S"
        )
        .replace(
            tzinfo=MARKET_TZ
        )
    )

    print(
        "XAU OPEN:",
        value
    )

    print(
        "Horário do candle utilizado:",
        actual_dt.strftime(
            "%Y-%m-%d %H:%M:%S ET"
        )
    )

    print(
        "Diferença:",
        round(
            best_distance,
            2
        ),
        "segundos"
    )

    print(
        "------------------------------------------"
    )

    return {

        "price":
            value,

        "target_at":
            target_dt,

        "price_at":
            actual_dt,

        "distance_seconds":
            best_distance,

        "source":
            "twelve_data_history_open",

        "price_type":
            "open",

        "status":
            "ok",

        "price_mode":
            "snapshot"

    }


# ============================================================
# XAU HISTÓRICO
#
# PRIMEIRA OPÇÃO:
#     Twelve Data
#
# SEGUNDA OPÇÃO:
#     Yahoo histórico
#
# NUNCA:
#     preço atual
# ============================================================

def get_xau_price_at(
    target_dt
):

    try:

        result = get_twelve_xau_price_at(
            target_dt
        )

        return result

    except Exception as e:

        print()
        print(
            "Twelve Data XAU histórico falhou:"
        )

        print(
            str(e)
        )

    # --------------------------------------------------------
    # SEGUNDA OPÇÃO
    #
    # Yahoo histórico.
    #
    # Também usa OPEN.
    # --------------------------------------------------------

    try:

        result = get_yahoo_price_at(
            XAU_SYMBOL,
            target_dt
        )

        result["source"] = (
            "yahoo_xau_history_open"
        )

        return result

    except Exception as e:

        print()
        print(
            "Yahoo XAU histórico também falhou:"
        )

        print(
            str(e)
        )

    return {

        "price":
            None,

        "target_at":
            target_dt,

        "price_at":
            None,

        "distance_seconds":
            None,

        "source":
            "unavailable",

        "price_type":
            "open",

        "status":
            "unavailable",

        "price_mode":
            "unavailable"

    }


# ============================================================
# PREÇOS DE MERCADO ALINHADOS AO SNAPSHOT ALGOX
#
# REGRA:
#
# AlgoX 10:30:00
#
# GLD:
#     AlgoX 10:30:00
#
# GC:
#     10:15:00 OPEN
#
# XAU:
#     10:15:00 OPEN
#
# ============================================================

def get_market_prices(
    snapshot_dt,
    algox_spot
):

    if snapshot_dt is None:

        raise RuntimeError(
            "Snapshot AlgoX inválido."
        )

    snapshot_dt = snapshot_dt.astimezone(
        MARKET_TZ
    )

    # ========================================================
    # GLD
    # ========================================================

    gld = safe_float(
        algox_spot
    )

    if (
        gld is None
        or
        gld <= 0
    ):

        raise RuntimeError(
            "AlgoX não retornou spot GLD válido."
        )

    gld_price_at = snapshot_dt

    # ========================================================
    # GC / XAU TARGET
    # ========================================================

    target_dt = (
        snapshot_dt
        -
        timedelta(
            minutes=
            SNAPSHOT_PRICE_OFFSET_MINUTES
        )
    )

    print()
    print(
        "=========================================="
    )

    print(
        "PREÇOS TEMPORALMENTE ALINHADOS"
    )

    print(
        "=========================================="
    )

    print(
        "GLD AlgoX snapshot:",
        snapshot_dt.strftime(
            "%Y-%m-%d %H:%M:%S ET"
        )
    )

    print(
        "GLD AlgoX:",
        gld
    )

    print(
        "GC/XAU horário alvo:",
        target_dt.strftime(
            "%Y-%m-%d %H:%M:%S ET"
        )
    )

    print(
        "GC/XAU preço:",
        "OPEN"
    )

    print(
        "=========================================="
    )

    # ========================================================
    # GC
    # ========================================================

    try:

        gc_snapshot = get_gc_price_at(
            target_dt
        )

    except Exception as e:

        raise RuntimeError(

            "Não foi possível obter GC "
            "no horário alvo. "
            "Snapshot não será substituído. "
            +
            str(e)

        )

    # ========================================================
    # XAU
    # ========================================================

    xau_snapshot = get_xau_price_at(
        target_dt
    )

    if (
        xau_snapshot.get(
            "price"
        )
        is None
    ):

        raise RuntimeError(

            "Não foi possível obter XAU "
            "no horário alvo. "
            "Snapshot não será substituído."

        )

    # ========================================================
    # PREÇOS
    # ========================================================

    gc = safe_float(
        gc_snapshot.get(
            "price"
        )
    )

    xau = safe_float(
        xau_snapshot.get(
            "price"
        )
    )

    if (
        gc is None
        or
        gc <= 0
    ):

        raise RuntimeError(
            "GC retornou preço inválido."
        )

    if (
        xau is None
        or
        xau <= 0
    ):

        raise RuntimeError(
            "XAU retornou preço inválido."
        )

    # ========================================================
    # HORÁRIOS DOS CANDLES
    # ========================================================

    gc_price_at = (
        gc_snapshot.get(
            "price_at"
        )
    )

    xau_price_at = (
        xau_snapshot.get(
            "price_at"
        )
    )

    if (
        gc_price_at is None
        or
        xau_price_at is None
    ):

        raise RuntimeError(
            "GC e XAU não possuem horário real de candle."
        )

    gc_price_at = (
        gc_price_at.astimezone(
            MARKET_TZ
        )
    )

    xau_price_at = (
        xau_price_at.astimezone(
            MARKET_TZ
        )
    )

    # ========================================================
    # VERIFICAR SINCRONIZAÇÃO
    # ========================================================

    timestamp_difference = abs(
        (
            gc_price_at
            -
            xau_price_at
        ).total_seconds()
    )

    if (
        timestamp_difference
        >
        MAX_GC_XAU_TIMESTAMP_DIFFERENCE_SECONDS
    ):

        raise RuntimeError(

            "GC e XAU não foram obtidos "
            "no mesmo horário alvo. "

            f"GC={gc_price_at:%H:%M:%S} ET "

            f"XAU={xau_price_at:%H:%M:%S} ET "

            f"Diferença="
            f"{timestamp_difference:.0f}s. "

            "Snapshot não será substituído."

        )

    # ========================================================
    # FACTOR
    # ========================================================

    factor = (
        gc /
        gld
    )

    # ========================================================
    # SPREAD
    # ========================================================

    spread = (
        gc -
        xau
    )

    # ========================================================
    # LOG
    # ========================================================

    print()
    print(
        "------------------------------------------"
    )

    print(
        "RESULTADO DOS PREÇOS"
    )

    print(
        "------------------------------------------"
    )

    print(
        "GLD:",
        gld
    )

    print(
        "GLD horário:",
        gld_price_at.strftime(
            "%Y-%m-%d %H:%M:%S ET"
        )
    )

    print(
        "GC OPEN:",
        gc
    )

    print(
        "GC horário:",
        gc_price_at.strftime(
            "%Y-%m-%d %H:%M:%S ET"
        )
    )

    print(
        "XAU OPEN:",
        xau
    )

    print(
        "XAU horário:",
        xau_price_at.strftime(
            "%Y-%m-%d %H:%M:%S ET"
        )
    )

    print(
        "Diferença GC/XAU:",
        timestamp_difference,
        "segundos"
    )

    print(
        "Factor:",
        factor
    )

    print(
        "Spread GC-XAU:",
        spread
    )

    print(
        "------------------------------------------"
    )

    # ========================================================
    # OBJETO GLD
    # ========================================================

    gld_snapshot = {

        "price":
            gld,

        "price_at":
            gld_price_at,

        "target_at":
            snapshot_dt,

        "distance_seconds":
            0,

        "source":
            "algox",

        "price_mode":
            "snapshot",

        "price_type":
            "spot",

        "status":
            "ok"

    }

    # ========================================================
    # RESULTADO
    # ========================================================

    return {

        "gld_price":
            gld,

        "gc_price":
            gc,

        "xau_spot":
            xau,

        "xau_source":
            xau_snapshot.get(
                "source"
            ),

        "factor":
            factor,

        "gc_xau_spread":
            spread,

        "price_mode":
            "snapshot",

        "gc_price_mode":
            "snapshot",

        "xau_price_mode":
            "snapshot",

        "snapshot_target_at":
            target_dt,

        "algox_snapshot_at":
            snapshot_dt,

        "gld_price_at":
            gld_price_at,

        "gc_price_at":
            gc_price_at,

        "xau_price_at":
            xau_price_at,

        "gld_snapshot":
            gld_snapshot,

        "gc_snapshot":
            gc_snapshot,

        "xau_snapshot":
            xau_snapshot,

        "gld_error":
            None,

        "gc_error":
            None,

        "updated":
            now_ny().isoformat(),

        "market_open":
            True

    }


# ============================================================
# ALGOX FLOW - GEXMAP
# ============================================================

def get_algox_gamma():

    base_url = (
        "https://algoxflow.com/api/gexmap"
    )

    print()
    print(
        "=========================================="
    )

    print(
        "CONSULTANDO ALGOX GEXMAP"
    )

    print(
        base_url
    )

    print(
        "=========================================="
    )

    def request_algox(
        cache_buster=False
    ):

        params = {

            "ticker":
                "GLD"

        }

        if cache_buster:

            params["_cb"] = (
                str(
                    int(
                        time.time() * 1000
                    )
                )
                +
                "_"
                +
                str(
                    time.perf_counter_ns()
                )
            )

        url = (
            base_url
            +
            "?"
            +
            urllib.parse.urlencode(
                params
            )
        )

        print()
        print(
            "GET AlgoX GEXMAP:"
        )

        print(
            url
        )

        req = urllib.request.Request(

            url,

            headers={

                "User-Agent":
                    (
                        "Mozilla/5.0 "
                        "(Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 "
                        "(KHTML, like Gecko) "
                        "Chrome/154.0.0.0 "
                        "Safari/537.36"
                    ),

                "Accept":
                    "application/json",

                "Referer":
                    "https://algoxflow.com/gex?t=GLD",

                "Cache-Control":
                    "no-cache, no-store, max-age=0",

                "Pragma":
                    "no-cache",

                "Expires":
                    "0",

                "Connection":
                    "close"

            }

        )

        request_started = now_ny()

        with urllib.request.urlopen(
            req,
            timeout=15
        ) as response:

            raw = response.read()

            response_headers = dict(
                response.headers
            )

            response_status = (
                response.status
            )

        request_finished = now_ny()

        print(
            "HTTP:",
            response_status
        )

        print(
            "Content-Length:",
            response_headers.get(
                "Content-Length"
            )
        )

        print(
            "Cache-Control:",
            response_headers.get(
                "Cache-Control"
            )
        )

        print(
            "Age:",
            response_headers.get(
                "Age"
            )
        )

        print(
            "Cache-Status:",
            response_headers.get(
                "Cache-Status"
            )
        )

        print(
            "ETag:",
            response_headers.get(
                "ETag"
            )
        )

        data = json.loads(
            raw.decode(
                "utf-8"
            )
        )

        if not isinstance(
            data,
            dict
        ):

            raise RuntimeError(
                "AlgoX GEXMAP retornou JSON inválido."
            )

        return {

            "data":
                data,

            "request_started":
                request_started,

            "request_finished":
                request_finished,

            "response_headers":
                response_headers

        }

    try:

        response = request_algox(
            cache_buster=False
        )

        data = response["data"]

        request_finished = (
            response["request_finished"]
        )

        source_as_of = data.get(
            "updated"
        )

        if not source_as_of:

            raise RuntimeError(
                "AlgoX GEXMAP não retornou campo 'updated'."
            )

        source_dt = parse_datetime(
            source_as_of
        )

        if source_dt is None:

            raise RuntimeError(
                "Campo 'updated' do AlgoX é inválido: "
                +
                str(source_as_of)
            )

        age_seconds = (
            request_finished.astimezone(
                UTC_TZ
            )
            -
            source_dt.astimezone(
                UTC_TZ
            )
        ).total_seconds()

        print()
        print(
            "------------------------------------------"
        )

        print(
            "ALGOX GEXMAP"
        )

        print(
            "updated:",
            source_as_of
        )

        print(
            "snapshot NY:",
            source_dt.astimezone(
                MARKET_TZ
            ).strftime(
                "%Y-%m-%d %H:%M:%S"
            )
        )

        print(
            "snapshot BR:",
            source_dt.astimezone(
                BRAZIL_TZ
            ).strftime(
                "%Y-%m-%d %H:%M:%S"
            )
        )

        print(
            "consulta NY:",
            request_finished.strftime(
                "%Y-%m-%d %H:%M:%S"
            )
        )

        print(
            "idade calculada:",
            round(
                age_seconds,
                2
            ),
            "segundos"
        )

        print(
            "------------------------------------------"
        )

        payload = data

        spot = safe_float(
            payload.get(
                "spot"
            )
        )

        flip = safe_float(
            payload.get(
                "flip"
            )
        )

        call_wall = safe_float(
            payload.get(
                "callWall"
            )
        )

        put_wall = safe_float(
            payload.get(
                "putWall"
            )
        )

        max_pain = safe_float(
            payload.get(
                "maxPain"
            )
        )

        net_gex = safe_float(
            payload.get(
                "totalGex"
            )
        )

        regime = payload.get(
            "regime"
        )

        exp_move = safe_float(
            payload.get(
                "expMove"
            )
        )

        exp_move_pct = safe_float(
            payload.get(
                "expMovePct"
            )
        )

        expected_move = {

            "value":
                exp_move,

            "pct":
                exp_move_pct,

            "expiry":
                payload.get(
                    "nearestExp"
                )

        }

        raw_strikes = payload.get(
            "strikes",
            []
        )

        if not isinstance(
            raw_strikes,
            list
        ):

            raise RuntimeError(
                "AlgoX GEXMAP não retornou lista 'strikes'."
            )

        normalized_strikes = []

        for item in raw_strikes:

            if not isinstance(
                item,
                dict
            ):

                continue

            strike = safe_float(
                item.get(
                    "k"
                )
            )

            gex = safe_float(
                item.get(
                    "g"
                )
            )

            if strike is None:
                continue

            if gex is None:
                continue

            normalized_strikes.append({

                "strike":
                    strike,

                "gex":
                    gex

            })

        if not normalized_strikes:

            raise RuntimeError(
                "AlgoX GEXMAP não retornou GEX válido por strike."
            )

        algox_capture = (
            build_capture_metadata(
                request_finished,
                source_as_of
            )
        )

        print()
        print(
            "=========================================="
        )

        print(
            "ALGOX SNAPSHOT FINAL"
        )

        print(
            "Ticker:",
            payload.get(
                "ticker"
            )
        )

        print(
            "Spot:",
            spot
        )

        print(
            "Spot source:",
            payload.get(
                "spotSrc"
            )
        )

        print(
            "Regime:",
            regime
        )

        print(
            "Total GEX:",
            net_gex
        )

        print(
            "Call Wall:",
            call_wall
        )

        print(
            "Put Wall:",
            put_wall
        )

        print(
            "Max Pain:",
            max_pain
        )

        print(
            "Snapshot:",
            source_as_of
        )

        print(
            "Strikes:",
            len(
                normalized_strikes
            )
        )

        print(
            "=========================================="
        )

        return {

            "ticker":
                payload.get(
                    "ticker",
                    "GLD"
                ),

            "as_of":
                source_as_of,

            "spot":
                spot,

            "flip":
                flip,

            "regime":
                regime,

            "age_seconds":
                age_seconds,

            "call_wall":
                call_wall,

            "put_wall":
                put_wall,

            "max_pain":
                max_pain,

            "net_gex_millions":
                net_gex,

            "expected_move":
                expected_move,

            "strikes":
                normalized_strikes,

            "capture":
                algox_capture,

            "chg_pct":
                safe_float(
                    payload.get(
                        "chgPct"
                    )
                ),

            "spot_source":
                payload.get(
                    "spotSrc"
                ),

            "regime_basis":
                payload.get(
                    "regimeBasis"
                ),

            "gex_above_spot":
                safe_float(
                    payload.get(
                        "gexAboveSpot"
                    )
                ),

            "gex_below_spot":
                safe_float(
                    payload.get(
                        "gexBelowSpot"
                    )
                ),

            "exp_move":
                exp_move,

            "exp_move_pct":
                exp_move_pct,

            "atm_iv":
                safe_float(
                    payload.get(
                        "atmIv"
                    )
                ),

            "expiries":
                payload.get(
                    "expiries"
                ),

            "nearest_exp":
                payload.get(
                    "nearestExp"
                ),

            "last_expiry":
                payload.get(
                    "lastExpiry"
                ),

            "contracts":
                payload.get(
                    "contracts"
                ),

            "truncated":
                payload.get(
                    "truncated"
                )

        }

    except Exception as e:

        print()
        print(
            "ERRO ALGOX GEXMAP:"
        )

        print(
            str(e)
        )

        raise RuntimeError(
            "Erro consultando AlgoX GEXMAP: "
            +
            str(e)
        )


# ============================================================
# CONVERTER GEX ALGOX
# ============================================================

def build_rows(
    algox,
    market
):

    strikes = algox.get(
        "strikes",
        []
    )

    factor = safe_float(
        market.get(
            "factor"
        )
    )

    spread = safe_float(
        market.get(
            "gc_xau_spread"
        )
    )

    if factor is None:

        raise RuntimeError(
            "Fator GLD → GC inválido."
        )

    rows_data = []

    for item in strikes:

        gld = safe_float(
            item.get(
                "strike"
            )
        )

        gex = safe_float(
            item.get(
                "gex"
            )
        )

        if gld is None:
            continue

        if gex is None:
            continue

        gc = (
            gld *
            factor
        )

        xau = None

        if spread is not None:

            xau = (
                gc -
                spread
            )

        rows_data.append({

            "gld":
                gld,

            "gc":
                gc,

            "xau":
                xau,

            "gex":
                gex

        })

    if not rows_data:

        raise RuntimeError(
            "Nenhum nível GEX válido."
        )

    max_positive_gex = 0.0
    max_negative_gex = 0.0

    for item in rows_data:

        gex = item["gex"]

        if gex > 0:

            max_positive_gex = max(
                max_positive_gex,
                gex
            )

        elif gex < 0:

            max_negative_gex = max(
                max_negative_gex,
                abs(gex)
            )

    rows = []

    for item in sorted(
        rows_data,
        key=lambda x:
            x["gld"],
        reverse=True
    ):

        gex = item["gex"]

        if gex >= 0:

            if max_positive_gex > 0:

                intensity = (
                    abs(gex)
                    /
                    max_positive_gex
                ) * 100.0

            else:

                intensity = 0.0

        else:

            if max_negative_gex > 0:

                intensity = (
                    abs(gex)
                    /
                    max_negative_gex
                ) * 100.0

            else:

                intensity = 0.0

        rows.append({

            "gld":
                item["gld"],

            "gc":
                item["gc"],

            "xau":
                item["xau"],

            "gex":
                item["gex"],

            "intensity":
                intensity

        })

    positive = [

        x
        for x in rows
        if x["gex"] > 0

    ]

    negative = [

        x
        for x in rows
        if x["gex"] < 0

    ]

    max_positive = None

    if positive:

        max_positive = max(
            positive,
            key=lambda x:
                x["gex"]
        )["gld"]

    max_negative = None

    if negative:

        max_negative = min(
            negative,
            key=lambda x:
                x["gex"]
        )["gld"]

    return {

        "rows":
            rows,

        "max_positive":
            max_positive,

        "max_negative":
            max_negative,

        "max_positive_gex":
            max_positive_gex,

        "max_negative_gex":
            max_negative_gex

    }


# ============================================================
# NOVO SNAPSHOT
# ============================================================

def build_new_snapshot(
    algox
):

    print()
    print(
        "=========================================="
    )

    print(
        "NOVO SNAPSHOT ALGOX"
    )

    print(
        "=========================================="
    )

    snapshot_dt = parse_datetime(
        algox.get(
            "as_of"
        )
    )

    if snapshot_dt is None:

        raise RuntimeError(
            "Snapshot AlgoX inválido."
        )

    algox_spot = safe_float(
        algox.get(
            "spot"
        )
    )

    if (
        algox_spot is None
        or
        algox_spot <= 0
    ):

        raise RuntimeError(
            "AlgoX não possui spot GLD válido."
        )

    market = get_market_prices(
        snapshot_dt,
        algox_spot
    )

    print(
        "GLD AlgoX:",
        market["gld_price"]
    )

    print(
        "GC:",
        market["gc_price"]
    )

    print(
        "XAU:",
        market["xau_spot"]
    )

    print(
        "XAU fonte:",
        market["xau_source"]
    )

    print(
        "Modo preço:",
        market["price_mode"]
    )

    print(
        "Factor:",
        market["factor"]
    )

    print(
        "Spread GC-XAU:",
        market["gc_xau_spread"]
    )

    # ========================================================
    # CAPTURAS
    # ========================================================

    gld_capture = format_timestamp(
        market.get(
            "gld_price_at"
        )
    )

    gc_capture = format_timestamp(
        market.get(
            "gc_price_at"
        )
    )

    xau_capture = format_timestamp(
        market.get(
            "xau_price_at"
        )
    )

    target_capture = format_timestamp(
        market.get(
            "snapshot_target_at"
        )
    )

    algox_capture = format_timestamp(
        market.get(
            "algox_snapshot_at"
        )
    )

    regions = build_rows(
        algox,
        market
    )

    now = now_ny()

    expected_move = (
        algox.get(
            "expected_move"
        )
        or {}
    )

    expiration = (
        expected_move.get(
            "expiry"
        )
    )

    gld_snapshot_info = (
        market.get(
            "gld_snapshot"
        )
        or {}
    )

    gc_snapshot_info = (
        market.get(
            "gc_snapshot"
        )
        or {}
    )

    xau_snapshot_info = (
        market.get(
            "xau_snapshot"
        )
        or {}
    )

    # ========================================================
    # RESULTADO
    # ========================================================

    result = {

        "ticker":
            "GLD",

        "source":
            "algox",

        "source_label":
            "AlgoX Flow",

        "source_age_seconds":
            algox.get(
                "age_seconds"
            ),

        "source_as_of":
            algox.get(
                "as_of"
            ),

        "updated":
            now.isoformat(),

        "dte":
            0,

        "expiration":
            expiration
            or "-",

        # ====================================================
        # PREÇOS
        # ====================================================

        "gld_price":
            market["gld_price"],

        "gc_price":
            market["gc_price"],

        "xau_spot":
            market["xau_spot"],

        "xau_source":
            market["xau_source"],

        "factor":
            market["factor"],

        "gc_xau_spread":
            market["gc_xau_spread"],

        # ====================================================
        # MODOS
        # ====================================================

        "price_mode":
            market["price_mode"],

        "gc_price_mode":
            market.get(
                "gc_price_mode"
            ),

        "xau_price_mode":
            market.get(
                "xau_price_mode"
            ),

        # ====================================================
        # ALINHAMENTO
        # ====================================================

        "snapshot_price_target":
            target_capture,

        "algox_snapshot_at":
            algox_capture,

        # ====================================================
        # COTAÇÕES UTILIZADAS
        #
        # IMPORTANTE:
        #
        # Estes horários são os horários REAIS dos candles.
        #
        # Não são os horários em que a API foi consultada.
        #
        # ====================================================

        "price_capture": {

            "gld": {

                "ny":
                    gld_capture["ny"],

                "br":
                    gld_capture["br"],

                "iso":
                    gld_capture["iso"],

                "source":
                    "algox",

                "price_mode":
                    "snapshot",

                "price_type":
                    "spot",

                "target_ny":
                    algox_capture["ny"],

                "target_iso":
                    algox_capture["iso"],

                "distance_seconds":
                    0

            },

            "gc": {

                "ny":
                    gc_capture["ny"],

                "br":
                    gc_capture["br"],

                "iso":
                    gc_capture["iso"],

                "source":
                    gc_snapshot_info.get(
                        "source"
                    ),

                "price_mode":
                    gc_snapshot_info.get(
                        "price_mode"
                    ),

                "price_type":
                    "open",

                "target_ny":
                    target_capture["ny"],

                "target_iso":
                    target_capture["iso"],

                "distance_seconds":
                    gc_snapshot_info.get(
                        "distance_seconds"
                    )

            },

            "xau": {

                "ny":
                    xau_capture["ny"],

                "br":
                    xau_capture["br"],

                "iso":
                    xau_capture["iso"],

                "source":
                    xau_snapshot_info.get(
                        "source"
                    ),

                "price_mode":
                    xau_snapshot_info.get(
                        "price_mode"
                    ),

                "price_type":
                    "open",

                "target_ny":
                    target_capture["ny"],

                "target_iso":
                    target_capture["iso"],

                "distance_seconds":
                    xau_snapshot_info.get(
                        "distance_seconds"
                    )

            }

        },

        # ====================================================
        # ALGOX
        # ====================================================

        "algox_snapshot":
            algox.get(
                "as_of"
            ),

        "algox_timing":
            algox.get(
                "capture"
            ),

        # ====================================================
        # GEX
        # ====================================================

        "gamma_flip":
            algox.get(
                "flip"
            ),

        "gamma_regime":
            algox.get(
                "regime"
            ),

        "call_wall":
            algox.get(
                "call_wall"
            ),

        "put_wall":
            algox.get(
                "put_wall"
            ),

        "max_pain":
            algox.get(
                "max_pain"
            ),

        "net_gex_millions":
            algox.get(
                "net_gex_millions"
            ),

        "expected_move":
            expected_move,

        "max_positive":
            regions["max_positive"],

        "max_negative":
            regions["max_negative"],

        "rows":
            regions["rows"],

        "frozen":
            False,

        "source_status":
            (
                "OK"
                if (
                    market["gld_price"] is not None
                    and
                    market["gc_price"] is not None
                    and
                    market["xau_spot"] is not None
                )
                else
                "Dados de mercado incompletos"
            )

    }

    return result


# ============================================================
# ATUALIZAR ESTADO
# ============================================================

def refresh_gamma_if_needed(
    force=False
):

    global gamma_state

    now = time.time()

    if (
        not force
        and
        gamma_state["data"] is not None
        and
        (
            now
            -
            gamma_state["last_check"]
        )
        <
        ALGOX_POLL_SECONDS
    ):

        return gamma_state["data"]

    gamma_state["last_check"] = now

    try:

        algox = get_algox_gamma()

    except Exception as e:

        print(
            "Falha consultando AlgoX:",
            e
        )

        if gamma_state.get(
            "data"
        ) is not None:

            fallback = dict(
                gamma_state["data"]
            )

            fallback["source_status"] = (
                "AlgoX indisponível — "
                "mantendo último snapshot"
            )

            fallback["frozen"] = True

            return fallback

        raise

    new_as_of = algox.get(
        "as_of"
    )

    old_as_of = gamma_state.get(
        "last_as_of"
    )

    if (
        not force
        and
        old_as_of is not None
        and
        new_as_of == old_as_of
        and
        gamma_state.get(
            "data"
        ) is not None
    ):

        print()
        print(
            "Snapshot AlgoX igual ao anterior."
        )

        print(
            "Mantendo cache local."
        )

        return gamma_state["data"]

    print()
    print(
        "****************************************"
    )

    print(
        "NOVO AS_OF ALGOX DETECTADO"
    )

    print(
        "Anterior:",
        old_as_of
    )

    print(
        "Novo:",
        new_as_of
    )

    print(
        "****************************************"
    )

    try:

        data = build_new_snapshot(
            algox
        )

    except Exception as e:

        print(
            "Erro montando novo snapshot:",
            e
        )

        if gamma_state.get(
            "data"
        ) is not None:

            fallback = dict(
                gamma_state["data"]
            )

            fallback["source_status"] = (
                "Novo AlgoX detectado, "
                "mas GC/XAU não puderam "
                "ser alinhados no horário "
                "solicitado. "
                "Mantendo último snapshot completo."
            )

            fallback["frozen"] = True

            return fallback

        raise

    gamma_state["algox"] = algox

    gamma_state["market"] = {

        "gld_price":
            data["gld_price"],

        "gc_price":
            data["gc_price"],

        "xau_spot":
            data["xau_spot"],

        "xau_source":
            data["xau_source"],

        "factor":
            data["factor"],

        "gc_xau_spread":
            data["gc_xau_spread"],

        "updated":
            data["updated"]

    }

    gamma_state["data"] = data

    gamma_state["last_as_of"] = (
        new_as_of
    )

    return data


# ============================================================
# API GAMMA
# ============================================================

@app.route(
    "/api/gamma"
)
def api_gamma():

    try:

        dte = int(
            request.args.get(
                "dte",
                "0"
            )
        )

    except Exception:

        dte = 0

    if dte not in (
        0,
        1
    ):

        return jsonify({

            "ok":
                False,

            "error":
                "DTE inválido. Use 0 ou 1."

        }), 400

    try:

        force = (
            request.args.get(
                "force",
                "0"
            )
            ==
            "1"
        )

        data = refresh_gamma_if_needed(
            force=force
        )

        return jsonify({

            "ok":
                True,

            "data":
                data,

            "source":
                data.get(
                    "source"
                ),

            "source_age_seconds":
                data.get(
                    "source_age_seconds"
                ),

            "algox_snapshot":
                data.get(
                    "algox_snapshot"
                ),

            "algox_timing":
                data.get(
                    "algox_timing"
                ),

            "price_capture":
                data.get(
                    "price_capture"
                ),

            "price_mode":
                data.get(
                    "price_mode"
                ),

            "cached":
                True,

            "frozen":
                data.get(
                    "frozen",
                    False
                )

        })

    except Exception as e:

        print()
        print(
            "ERRO /api/gamma:"
        )

        print(
            str(e)
        )

        print()

        return jsonify({

            "ok":
                False,

            "error":
                str(e)

        }), 500


# ============================================================
# ÂNCORA HORÁRIA
#
# Mantida separada da lógica principal do Gamma.
# ============================================================

def get_last_hour_anchor():

    print()
    print(
        "========== BUSCANDO ÂNCORA =========="
    )

    now = now_ny()

    anchor_hour = now.replace(
        minute=0,
        second=0,
        microsecond=0
    )

    market_open = anchor_hour.replace(
        hour=10,
        minute=30,
        second=0,
        microsecond=0
    )

    # ========================================================
    # GLD
    # ========================================================

    gld = get_yahoo_history(
        GLD_SYMBOL,
        period="5d",
        interval="1m"
    )

    # ========================================================
    # GC
    # ========================================================

    gc = get_yahoo_history(
        GC_SYMBOL,
        period="5d",
        interval="1m"
    )

    # ========================================================
    # GC
    # ========================================================

    gc_bar = None

    if gc is not None and not gc.empty:

        gc_target = anchor_hour

        gc_matches = gc[
            (
                gc.index.date
                ==
                gc_target.date()
            )
            &
            (
                gc.index.hour
                ==
                gc_target.hour
            )
            &
            (
                gc.index.minute
                ==
                0
            )
        ]

        if not gc_matches.empty:

            gc_bar = gc_matches.iloc[0]

        if gc_bar is None:

            gc_before = gc[
                gc.index <= gc_target
            ]

            if not gc_before.empty:

                gc_bar = gc_before.iloc[-1]

    if gc_bar is not None:

        # ----------------------------------------------------
        # ÂNCORA USA OPEN
        # ----------------------------------------------------

        gc_price = safe_float(
            gc_bar["Open"]
        )

        try:

            gc_price_at = (
                gc_bar.name.to_pydatetime()
            )

        except Exception:

            gc_price_at = None

        gc_source = (
            "yahoo_history_open"
        )

    else:

        raise RuntimeError(
            "GC não possui candle histórico para a âncora."
        )

    if gc_price is None or gc_price <= 0:

        raise RuntimeError(
            "GC não possui OPEN válido para a âncora."
        )

    # ========================================================
    # GLD
    # ========================================================

    gld_bar = None
    gld_source = "yahoo_history_open"
    gld_price_at = None
    gld_price = None

    if gld is not None and not gld.empty:

        if anchor_hour < market_open:

            previous_day = (
                anchor_hour.date()
                -
                timedelta(days=1)
            )

            previous_gld = gld[
                gld.index.date
                ==
                previous_day
            ]

            if previous_gld.empty:

                previous_gld = gld[
                    gld.index < anchor_hour
                ]

            if not previous_gld.empty:

                gld_bar = previous_gld.iloc[-1]

        else:

            gld_matches = gld[
                (
                    gld.index.date
                    ==
                    anchor_hour.date()
                )
                &
                (
                    gld.index.hour
                    ==
                    anchor_hour.hour
                )
                &
                (
                    gld.index.minute
                    ==
                    0
                )
            ]

            if not gld_matches.empty:

                gld_bar = gld_matches.iloc[0]

            if gld_bar is None:

                gld_hour = gld[
                    (
                        gld.index.date
                        ==
                        anchor_hour.date()
                    )
                    &
                    (
                        gld.index.hour
                        ==
                        anchor_hour.hour
                    )
                ]

                if not gld_hour.empty:

                    gld_bar = gld_hour.iloc[0]

    if gld_bar is not None:

        # ----------------------------------------------------
        # ÂNCORA GLD USA OPEN
        # ----------------------------------------------------

        gld_price = safe_float(
            gld_bar["Open"]
        )

        try:

            gld_price_at = (
                gld_bar.name.to_pydatetime()
            )

        except Exception:

            gld_price_at = None

    if (
        gld_price is None
        or
        gld_price <= 0
    ):

        raise RuntimeError(
            "GLD não possui OPEN histórico para a âncora."
        )

    # ========================================================
    # FACTOR
    # ========================================================

    factor = (
        gc_price /
        gld_price
    )

    # ========================================================
    # HORÁRIOS
    # ========================================================

    anchor_ts = format_timestamp(
        anchor_hour
    )

    gld_ts = format_timestamp(
        gld_price_at
    )

    gc_ts = format_timestamp(
        gc_price_at
    )

    return {

        "time":
            anchor_hour.isoformat(),

        "display_time":
            anchor_hour.strftime(
                "%H:%M"
            ),

        "gld":
            gld_price,

        "gc":
            gc_price,

        "factor":
            factor,

        "price_mode":
            "snapshot",

        "anchor_capture": {

            "target": {

                "iso":
                    anchor_ts["iso"],

                "ny":
                    anchor_ts["ny"],

                "br":
                    anchor_ts["br"]

            },

            "gld": {

                "price":
                    gld_price,

                "iso":
                    gld_ts["iso"],

                "ny":
                    gld_ts["ny"],

                "br":
                    gld_ts["br"],

                "source":
                    gld_source,

                "price_type":
                    "open"

            },

            "gc": {

                "price":
                    gc_price,

                "iso":
                    gc_ts["iso"],

                "ny":
                    gc_ts["ny"],

                "br":
                    gc_ts["br"],

                "source":
                    gc_source,

                "price_type":
                    "open"

            }

        }

    }


# ============================================================
# API ÂNCORA
# ============================================================

@app.route(
    "/api/anchor"
)
def api_anchor():

    try:

        anchor = (
            get_last_hour_anchor()
        )

        return jsonify({

            "ok":
                True,

            "data":
                anchor

        })

    except Exception as e:

        print(
            "ERRO /api/anchor:",
            e
        )

        return jsonify({

            "ok":
                False,

            "error":
                str(e)

        }), 500


# ============================================================
# FRONTEND
# ============================================================

@app.route("/")
def index():

    return send_from_directory(
        ".",
        "index.html"
    )


@app.route(
    "/style.css"
)
def css():

    return send_from_directory(
        ".",
        "style.css"
    )


@app.route(
    "/app.js"
)
def javascript():

    return send_from_directory(
        ".",
        "app.js"
    )


# ============================================================
# START
# ============================================================

if __name__ == "__main__":

    print()
    print(
        "=========================================="
    )

    print(
        " GLD → GC → XAU GAMMA"
    )

    print(
        " AlgoX GEX + Yahoo histórico"
    )

    print(
        " GLD: SPOT DIRETO DO ALGOX"
    )

    print(
        " GC/XAU: 15 MINUTOS ATRÁS DO ALGOX"
    )

    print(
        " GC/XAU: MESMO TIMESTAMP"
    )

    print(
        " GC: OPEN DO CANDLE"
    )

    print(
        " XAU: Twelve Data → Yahoo histórico"
    )

    print(
        " NUNCA USA COTAÇÃO ATUAL NO GAMMA"
    )

    print(
        " HORÁRIOS: NY + BR"
    )

    print(
        " OFFSET GC/XAU:",
        SNAPSHOT_PRICE_OFFSET_MINUTES,
        "MIN"
    )

    print(
        "=========================================="
    )

    print()

    print(
        "Fuso NY:",
        now_ny().strftime(
            "%Y-%m-%d %H:%M:%S %Z"
        )
    )

    print(
        "Fuso BR:",
        now_br().strftime(
            "%Y-%m-%d %H:%M:%S %Z"
        )
    )

    print()

    if TWELVE_DATA_API_KEY:

        print(
            "Twelve Data: CONFIGURADA"
        )

    else:

        print(
            "Twelve Data: NÃO CONFIGURADA"
        )

    print()

    app.run(
        host="0.0.0.0",
        port=5000,
        debug=True
    )
