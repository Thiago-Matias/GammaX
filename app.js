// ==========================================================
// GLD → GC → XAU GAMMA
// ALGOX GEX
//
// CORREÇÕES:
//
// 1. Captura robusta do Gamma AlgoX
// 2. Captura correta dos horários GLD / GC / XAU
// 3. Conversão de horário para NY e Brasil
// 4. Suporte a timestamps ISO / Unix / HH:MM:SS
// 5. Busca dentro de objetos específicos de cada ativo
// 6. Fallback controlado para snapshot
//
// FONTES
// ----------------------------------------------------------
// GEX / Gamma Flip / Fator:
//     AlgoX
//
// Preços GLD / GC / XAU:
//     Yahoo / backend
//
// CONVERSÕES
// ----------------------------------------------------------
// GC nível  = GLD nível × fator AlgoX
//
// Spread   = GC atual − XAU Spot atual
//
// XAU nível = GC nível − Spread
//
// ==========================================================


let gammaData = [];

let marketData = null;

let anchorData = null;

let mostrarTodosOsNiveis = false;

const MAX_NIVEIS_PADRAO = 19;


// ==========================================================
// DTE
// ==========================================================

let selectedDTE = 0;


// ==========================================================
// CONTROLE DO SNAPSHOT ALGOX
// ==========================================================

let lastAlgoXSnapshot = null;


// ==========================================================
// ELEMENTOS
// ==========================================================

const gldAnchorInput =
    document.getElementById("gldAnchor");

const gcAnchorInput =
    document.getElementById("gcAnchor");

const anchorTimeInput =
    document.getElementById("anchorTime");

const gammaTable =
    document.getElementById("gammaTable");

const statusElement =
    document.getElementById("status");

const calculateButton =
    document.getElementById("calculateButton");

const manualButton =
    document.getElementById("manualButton");


// ==========================================================
// FORMATAÇÃO
// ==========================================================

function formatNumber(value, decimals = 2) {

    const number = Number(value);

    if (!Number.isFinite(number)) {
        return "-";
    }

    return number.toLocaleString("pt-BR", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}


// ==========================================================
// GEX
// ==========================================================

function formatGEX(value) {

    const number = Number(value);

    if (!Number.isFinite(number)) {
        return "-";
    }

    const formatted =
        Math.abs(number).toLocaleString("pt-BR", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });

    return (
        number > 0
            ? "+" + formatted
            : number < 0
                ? "-" + formatted
                : formatted
    );
}


// ==========================================================
// GAMMA FLIP
// ==========================================================

function formatFlip(value) {

    const number = Number(value);

    if (!Number.isFinite(number)) {
        return "-";
    }

    return number.toFixed(2);
}


// ==========================================================
// STATUS DO FLIP
// ==========================================================

function getFlipStatus(spot, flip) {

    const current = Number(spot);
    const level = Number(flip);

    if (
        !Number.isFinite(current) ||
        !Number.isFinite(level)
    ) {
        return {
            text: "-",
            className: ""
        };
    }

    if (current > level) {
        return {
            text: "ACIMA DO FLIP",
            className: "above"
        };
    }

    if (current < level) {
        return {
            text: "ABAIXO DO FLIP",
            className: "below"
        };
    }

    return {
        text: "NO FLIP",
        className: "at-flip"
    };
}


// ==========================================================
// HORÁRIOS ALGOX
// ==========================================================

function getAlgoXTiming(data) {

    if (!data || typeof data !== "object") {
        return null;
    }

    const timing =
        data.algox_timing ||
        data.algoX_timing ||
        data.algoxTiming ||
        data.algoXTiming ||
        null;

    if (!timing || typeof timing !== "object") {
        return null;
    }

    return {

        snapshotNY:
            timing.snapshot_disponibilizado_ny ||
            timing.snapshot_disponibilizado_NY ||
            timing.snapshot_ny ||
            timing.snapshotNY ||
            null,

        snapshotBR:
            timing.snapshot_disponibilizado_br ||
            timing.snapshot_disponibilizado_BR ||
            timing.snapshot_br ||
            timing.snapshotBR ||
            null,

        capturedNY:
            timing.capturado_ny ||
            timing.capturado_NY ||
            timing.captured_ny ||
            timing.captured_NY ||
            timing.capturedNY ||
            null,

        capturedBR:
            timing.capturado_br ||
            timing.capturado_BR ||
            timing.captured_br ||
            timing.captured_BR ||
            timing.capturedBR ||
            null,

        delaySeconds:
            Number.isFinite(
                Number(
                    timing.delay_seconds
                )
            )
                ? Number(
                    timing.delay_seconds
                )
                : null
    };
}


// ==========================================================
// FORMATA ATRASO
// ==========================================================

function formatDelay(seconds) {

    const value = Number(seconds);

    if (!Number.isFinite(value)) {
        return "-";
    }

    const totalSeconds =
        Math.max(
            0,
            Math.round(value)
        );

    const hours =
        Math.floor(
            totalSeconds / 3600
        );

    const minutes =
        Math.floor(
            (totalSeconds % 3600) / 60
        );

    const secs =
        totalSeconds % 60;

    if (hours > 0) {
        return (
            `${hours}h ` +
            `${minutes}m ` +
            `${secs}s`
        );
    }

    if (minutes > 0) {
        return (
            `${minutes}m ` +
            `${secs}s`
        );
    }

    return `${secs}s`;
}


// ==========================================================
// NORMALIZA NOME DE CHAVE
// ==========================================================

function normalizeKey(key) {

    return String(key)
        .toLowerCase()
        .replace(/[\s\-]+/g, "_");
}


// ==========================================================
// TESTA SE PARECE HORÁRIO
// ==========================================================

function looksLikeTime(value) {

    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return false;
    }

    const text =
        String(value).trim();

    return (
        /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text) ||
        /^\d{4}-\d{2}-\d{2}/.test(text) ||
        /^\d{10,13}$/.test(text) ||
        /T\d{2}:\d{2}/.test(text)
    );
}


// ==========================================================
// NORMALIZA HORÁRIO
// ==========================================================
//
// Aceita:
//
// 09:17:34
// 09:17:34 NY
// 2026-10-02T13:17:34Z
// 2026-10-02 09:17:34
// timestamp segundos
// timestamp milissegundos
//
// Retorna o horário no timezone solicitado.
//
// ==========================================================

function normalizeCaptureTime(
    value,
    timezone = "America/New_York"
) {

    if (
        value === undefined ||
        value === null ||
        value === ""
    ) {
        return null;
    }


    // ------------------------------------------------------
    // Número / timestamp
    // ------------------------------------------------------

    if (
        typeof value === "number" ||
        (
            typeof value === "string" &&
            /^\d{10,13}$/.test(
                value.trim()
            )
        )
    ) {

        let timestamp = Number(value);

        if (Number.isFinite(timestamp)) {

            if (timestamp < 100000000000) {
                timestamp *= 1000;
            }

            const date =
                new Date(timestamp);

            if (!Number.isNaN(date.getTime())) {

                return date.toLocaleTimeString(
                    "pt-BR",
                    {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: false,
                        timeZone: timezone
                    }
                );

            }
        }
    }


    const stringValue =
        String(value).trim();

    if (!stringValue) {
        return null;
    }


    // ------------------------------------------------------
    // Horário simples
    // ------------------------------------------------------

    const timeMatch =
        stringValue.match(
            /(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM|NY|BR|ET|BRT|EST|EDT))?(?:\s|$)/i
        );


    if (timeMatch) {

        let hour =
            Number(timeMatch[1]);

        const minute =
            timeMatch[2];

        const second =
            (
                timeMatch[3] ||
                "00"
            ).padStart(2, "0");

        const suffix =
            String(
                timeMatch[4] || ""
            ).toUpperCase();


        // --------------------------------------------------
        // AM / PM
        // --------------------------------------------------

        if (suffix === "PM" && hour < 12) {
            hour += 12;
        }

        if (suffix === "AM" && hour === 12) {
            hour = 0;
        }


        // --------------------------------------------------
        // Horário simples sem timezone:
        // mantém o horário informado.
        // --------------------------------------------------

        if (
            !suffix ||
            suffix === "NY" ||
            suffix === "ET" ||
            suffix === "EST" ||
            suffix === "EDT" ||
            suffix === "BR" ||
            suffix === "BRT"
        ) {

            return (
                `${String(hour).padStart(2, "0")}:` +
                `${minute}:` +
                `${second}`
            );
        }
    }


    // ------------------------------------------------------
    // ISO / Date
    // ------------------------------------------------------

    const date =
        new Date(stringValue);

    if (!Number.isNaN(date.getTime())) {

        return date.toLocaleTimeString(
            "pt-BR",
            {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
                timeZone: timezone
            }
        );
    }


    return null;
}


// ==========================================================
// CONVERTE UM VALOR DE DATA PARA NY E BR
// ==========================================================
//
// Importante:
// quando a API fornece ISO/timestamp, usamos a mesma
// data absoluta e mostramos em dois fusos diferentes.
//
// ==========================================================

function normalizeCapturePair(value) {

    if (
        value === undefined ||
        value === null ||
        value === ""
    ) {
        return null;
    }


    // ------------------------------------------------------
    // Timestamp
    // ------------------------------------------------------

    if (
        typeof value === "number" ||
        (
            typeof value === "string" &&
            /^\d{10,13}$/.test(
                value.trim()
            )
        )
    ) {

        let timestamp = Number(value);

        if (Number.isFinite(timestamp)) {

            if (timestamp < 100000000000) {
                timestamp *= 1000;
            }

            const date =
                new Date(timestamp);

            if (!Number.isNaN(date.getTime())) {

                return {

                    ny:
                        date.toLocaleTimeString(
                            "pt-BR",
                            {
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                                hour12: false,
                                timeZone:
                                    "America/New_York"
                            }
                        ),

                    br:
                        date.toLocaleTimeString(
                            "pt-BR",
                            {
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                                hour12: false,
                                timeZone:
                                    "America/Sao_Paulo"
                            }
                        ),

                    absolute: true

                };
            }
        }
    }


    const text =
        String(value).trim();


    // ------------------------------------------------------
    // ISO / data completa
    // ------------------------------------------------------

    const looksAbsolute =
        /T\d{2}:\d{2}/.test(text) ||
        /Z$/i.test(text) ||
        /[+-]\d{2}:?\d{2}$/.test(text) ||
        /^\d{4}-\d{2}-\d{2}/.test(text);


    if (looksAbsolute) {

        const date =
            new Date(text);

        if (!Number.isNaN(date.getTime())) {

            return {

                ny:
                    date.toLocaleTimeString(
                        "pt-BR",
                        {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                            hour12: false,
                            timeZone:
                                "America/New_York"
                        }
                    ),

                br:
                    date.toLocaleTimeString(
                        "pt-BR",
                        {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                            hour12: false,
                            timeZone:
                                "America/Sao_Paulo"
                        }
                    ),

                absolute: true

            };
        }
    }


    // ------------------------------------------------------
    // Horário simples
    // ------------------------------------------------------

    const match =
        text.match(
            /(\d{1,2}):(\d{2})(?::(\d{2}))?/
        );


    if (match) {

        const hour =
            String(
                Number(match[1])
            ).padStart(2, "0");

        const minute =
            match[2];

        const second =
            (
                match[3] ||
                "00"
            ).padStart(2, "0");


        return {

            ny:
                `${hour}:${minute}:${second}`,

            br:
                `${hour}:${minute}:${second}`,

            absolute: false

        };
    }


    return null;
}


// ==========================================================
// BUSCA RECURSIVA
// ==========================================================

function findNestedValue(
    object,
    keys,
    maxDepth = 8,
    depth = 0
) {

    if (
        object === null ||
        object === undefined ||
        depth > maxDepth
    ) {
        return null;
    }

    if (
        typeof object !== "object"
    ) {
        return null;
    }


    const wantedKeys =
        keys.map(
            key =>
                normalizeKey(key)
        );


    // ------------------------------------------------------
    // Chaves diretas
    // ------------------------------------------------------

    for (
        const key of Object.keys(object)
    ) {

        const normalized =
            normalizeKey(key);

        if (
            wantedKeys.includes(
                normalized
            )
        ) {

            const value =
                object[key];

            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {

                return value;
            }
        }
    }


    // ------------------------------------------------------
    // Recursivo
    // ------------------------------------------------------

    for (
        const key of Object.keys(object)
    ) {

        const value =
            object[key];

        if (
            value &&
            typeof value === "object"
        ) {

            const found =
                findNestedValue(
                    value,
                    keys,
                    maxDepth,
                    depth + 1
                );

            if (
                found !== null &&
                found !== undefined &&
                found !== ""
            ) {

                return found;
            }
        }
    }


    return null;
}


// ==========================================================
// CHAVES DE HORÁRIO
// ==========================================================

function getCaptureKeys(asset) {

    const a =
        String(asset)
            .toLowerCase();


    return [

        `${a}_captured_at`,
        `${a}_captured`,
        `${a}_capture_time`,
        `${a}_capture_timestamp`,

        `${a}_captured_time`,
        `${a}_quote_time`,
        `${a}_quote_timestamp`,
        `${a}_quote_at`,

        `${a}_timestamp`,
        `${a}_time`,
        `${a}_updated_at`,
        `${a}_updated`,

        "captured_at",
        "captured",
        "capture_time",
        "capture_timestamp",

        "quote_time",
        "quote_timestamp",
        "quote_at",

        "timestamp",
        "updated_at",
        "updated"

    ];
}


// ==========================================================
// EXTRAI OBJETOS DO ATIVO
// ==========================================================
//
// Exemplo:
//
// quotes.gld
// prices.gld
// market.gld
// assets.gld
// data.gld
//
// ==========================================================

function getAssetContainers(
    data,
    asset
) {

    if (
        !data ||
        typeof data !== "object"
    ) {
        return [];
    }


    const a =
        String(asset)
            .toLowerCase();

    const upper =
        a.toUpperCase();


    const containers = [];


    // ------------------------------------------------------
    // O próprio objeto raiz
    // ------------------------------------------------------

    containers.push(data);


    // ------------------------------------------------------
    // Objetos conhecidos
    // ------------------------------------------------------

    const parents = [

        data.quotes,
        data.prices,
        data.market,
        data.market_data,
        data.assets,
        data.cotacoes,
        data.quote_data,
        data.capture_times,
        data.captured_times,
        data.quote_timing,
        data.market_timing

    ];


    for (
        const parent of parents
    ) {

        if (
            parent &&
            typeof parent === "object"
        ) {

            if (parent[a]) {
                containers.push(
                    parent[a]
                );
            }

            if (parent[upper]) {
                containers.push(
                    parent[upper]
                );
            }
        }
    }


    // ------------------------------------------------------
    // Ativo diretamente
    // ------------------------------------------------------

    if (data[a]) {
        containers.push(
            data[a]
        );
    }

    if (data[upper]) {
        containers.push(
            data[upper]
        );
    }


    return containers;
}


// ==========================================================
// OBTÉM CAPTURA DE UM ATIVO
// ==========================================================

function getAssetCaptureValue(
    data,
    asset
) {

    const containers =
        getAssetContainers(
            data,
            asset
        );


    const keys =
        getCaptureKeys(
            asset
        );


    // ------------------------------------------------------
    // 1. Procura dentro dos objetos do ativo
    // ------------------------------------------------------

    for (
        const container of containers
    ) {

        if (
            !container ||
            typeof container !== "object"
        ) {
            continue;
        }


        const value =
            findNestedValue(
                container,
                keys,
                5
            );


        if (
            value !== null &&
            value !== undefined &&
            value !== ""
        ) {

            if (
                looksLikeTime(value)
            ) {
                return value;
            }
        }
    }


    // ------------------------------------------------------
    // 2. Chaves compostas diretamente no root
    // ------------------------------------------------------

    const a =
        String(asset)
            .toLowerCase();


    const directKeys = [

        `${a}_captured_at`,
        `${a}_captured`,
        `${a}_capture_time`,
        `${a}_captured_time`,
        `${a}_quote_time`,
        `${a}_quote_timestamp`,
        `${a}_timestamp`,
        `${a}_updated_at`,
        `${a}_time`,

        `${a}Captured`,
        `${a}CapturedAt`,
        `${a}CaptureTime`,
        `${a}QuoteTime`,
        `${a}Timestamp`,
        `${a}UpdatedAt`

    ];


    for (
        const key of directKeys
    ) {

        if (
            data[key] !== undefined &&
            data[key] !== null &&
            data[key] !== ""
        ) {

            if (
                looksLikeTime(
                    data[key]
                )
            ) {

                return data[key];
            }
        }
    }


    return null;
}


// ==========================================================
// RENDER HORÁRIOS DAS COTAÇÕES
// ==========================================================
//
// IMPORTANTE:
//
// GLD:
//     NÃO é mostrado aqui.
//     O horário do GLD pertence ao snapshot AlgoX.
//
// GC:
//     Mostra somente o horário real da cotação GC.
//
// XAU:
//     Mostra somente o horário real da cotação XAU.
//
// NÃO usar:
//     - snapshot AlgoX
//     - source_as_of
//     - timestamp global
//     - market_data_timestamp global
//
// como horário de GC/XAU.
//
// ==========================================================

function renderCaptureTimes(data) {

    if (!data || typeof data !== "object") {
        return;
    }

    // ======================================================
    // HORÁRIOS REAIS DO PRICE CAPTURE
    // ======================================================

    const priceCapture =
        data.price_capture || {};

    const gcCapture =
        priceCapture.gc || null;

    const xauCapture =
        priceCapture.xau || null;


    console.log(
        "========== HORÁRIOS REAIS =========="
    );

    console.log(
        "GC price_capture:",
        gcCapture
    );

    console.log(
        "XAU price_capture:",
        xauCapture
    );


    // ======================================================
    // ELEMENTOS
    // ======================================================

    const gcNY =
        document.getElementById(
            "gcCapturedNY"
        );

    const gcBR =
        document.getElementById(
            "gcCapturedBR"
        );

    const xauNY =
        document.getElementById(
            "xauCapturedNY"
        );

    const xauBR =
        document.getElementById(
            "xauCapturedBR"
        );


    // ======================================================
    // GC
    // ======================================================

    if (gcNY) {

        gcNY.textContent =
            gcCapture &&
            gcCapture.ny
                ? gcCapture.ny
                : "--:--:--";
    }


    if (gcBR) {

        gcBR.textContent =
            gcCapture &&
            gcCapture.br
                ? gcCapture.br
                : "--:--:--";
    }


    // ======================================================
    // XAU
    // ======================================================

    if (xauNY) {

        xauNY.textContent =
            xauCapture &&
            xauCapture.ny
                ? xauCapture.ny
                : "--:--:--";
    }


    if (xauBR) {

        xauBR.textContent =
            xauCapture &&
            xauCapture.br
                ? xauCapture.br
                : "--:--:--";
    }


    // ======================================================
    // LOG FINAL
    // ======================================================

    console.log(
        "GC:",
        gcCapture
    );

    console.log(
        "XAU:",
        xauCapture
    );
}



// ==========================================================
// FALLBACK DO SNAPSHOT
// ==========================================================

function getSnapshotCaptureFallback(data) {

    if (!data) {
        return null;
    }


    const candidates = [

        data.captured_at,
        data.capture_time,
        data.captured,
        data.updated_at,
        data.updated,
        data.quote_timestamp,
        data.quote_time,
        data.timestamp,
        data.source_as_of

    ];


    for (
        const value of candidates
    ) {

        const pair =
            normalizeCapturePair(
                value
            );

        if (pair) {
            return pair;
        }
    }


    return null;
}


// ==========================================================
// GAMMA FLIP
// ==========================================================

function renderGammaFlip() {

    if (!marketData) {
        return;
    }


    const flip =
        Number(
            marketData.gamma_flip
        );

    const spot =
        Number(
            marketData.gld_price
        );


    const flipElement =
        document.getElementById(
            "algoxGammaFlip"
        );


    if (flipElement) {

        flipElement.textContent =
            Number.isFinite(flip)
                ? formatFlip(flip)
                : "-";
    }


    const status =
        getFlipStatus(
            spot,
            flip
        );


    const flipStatusElement =
        document.getElementById(
            "algoxGammaStatus"
        );


    if (flipStatusElement) {

        flipStatusElement.textContent =
            status.text;

        flipStatusElement.className =
            "flip-status " +
            status.className;
    }


    const regimeElement =
        document.getElementById(
            "gammaRegime"
        );


    const regime =
        String(
            marketData.gamma_regime ||
            ""
        ).toLowerCase();


    if (regimeElement) {

        if (regime === "positive") {

            regimeElement.textContent =
                "GAMMA POSITIVO";

            regimeElement.className =
                "gamma-regime positive";

        }

        else if (regime === "negative") {

            regimeElement.textContent =
                "GAMMA NEGATIVO";

            regimeElement.className =
                "gamma-regime negative";

        }

        else {

            regimeElement.textContent =
                "-";

            regimeElement.className =
                "gamma-regime";
        }
    }


    const ageElement =
        document.getElementById(
            "algoxGammaAge"
        );


    if (ageElement) {

        const age =
            Number(
                marketData.source_age_seconds
            );


        if (Number.isFinite(age)) {

            if (age < 60) {

                ageElement.textContent =
                    `${Math.round(age)}s`;

            }

            else {

                ageElement.textContent =
                    `${Math.round(
                        age / 60
                    )} min`;
            }

        }

        else {

            ageElement.textContent =
                "-";
        }
    }
}


// ==========================================================
// FONTE
// ==========================================================

function updateGammaSource(data) {

    const sourceElement =
        document.getElementById(
            "gammaSource"
        );


    if (!sourceElement) {
        return;
    }


    sourceElement.className =
        "gamma-source";


    const source =
        String(
            data.source ||
            ""
        ).toLowerCase();


    if (
        source === "algox" ||
        source === "algox_flow" ||
        source === "algox-flow"
    ) {

        const age =
            Number(
                data.source_age_seconds
            );


        if (
            Number.isFinite(age) &&
            age > 900
        ) {

            sourceElement.textContent =
                "🟡 FONTE: ALGOX · SNAPSHOT ANTIGO";

            sourceElement.classList.add(
                "old"
            );

        }

        else {

            sourceElement.textContent =
                "🟣 FONTE: ALGOX FLOW";

            sourceElement.classList.add(
                "algox"
            );
        }

        return;
    }


    // Se houver dados AlgoX mesmo sem source explícito

    if (
        data.algox_snapshot ||
        data.algox_timing ||
        data.gamma_flip !== undefined
    ) {

        sourceElement.textContent =
            "🟣 FONTE: ALGOX FLOW";

        sourceElement.classList.add(
            "algox"
        );

        return;
    }


    sourceElement.textContent =
        "FONTE: —";
}


// ==========================================================
// STATUS
// ==========================================================

function setStatus(
    message,
    type = ""
) {

    if (!statusElement) {
        return;
    }

    statusElement.textContent =
        message;

    statusElement.className =
        "status " + type;
}


// ==========================================================
// DTE
// ==========================================================

function getDteLabel() {

    return selectedDTE === 0
        ? "0DTE"
        : "1DTE";
}


// ==========================================================
// CONVERSÃO GLD → GC
// ==========================================================

function converterGLDparaGC(gldPrice) {

    if (!marketData) {
        return null;
    }


    const factor =
        Number(
            marketData.factor
        );

    const gld =
        Number(
            gldPrice
        );


    if (
        !Number.isFinite(factor) ||
        !Number.isFinite(gld)
    ) {
        return null;
    }


    return gld * factor;
}


// ==========================================================
// SPREAD GC → XAU
// ==========================================================

function calcularSpreadGCXAU() {

    if (!marketData) {
        return null;
    }


    const gc =
        Number(
            marketData.gc_price
        );

    const xau =
        Number(
            marketData.xau_spot
        );


    if (
        !Number.isFinite(gc) ||
        !Number.isFinite(xau)
    ) {
        return null;
    }


    return gc - xau;
}


// ==========================================================
// CONVERSÃO GC → XAU
// ==========================================================

function converterGCparaXAU(gcPrice) {

    const gc =
        Number(
            gcPrice
        );


    const spread =
        calcularSpreadGCXAU();


    if (
        !Number.isFinite(gc) ||
        !Number.isFinite(spread)
    ) {
        return null;
    }


    return gc - spread;
}


// ==========================================================
// CONVERSÃO GLD → GC → XAU
// ==========================================================

function converterGLDparaGCXAU(gldPrice) {

    const gc =
        converterGLDparaGC(
            gldPrice
        );


    if (!Number.isFinite(gc)) {
        return null;
    }


    const xau =
        converterGCparaXAU(
            gc
        );


    return {
        gc,
        xau
    };
}


// ==========================================================
// CARREGAR ÂNCORA
// ==========================================================

async function carregarAnchor() {

    try {

        const response =
            await fetch(
                "/api/anchor?ts=" +
                Date.now(),
                {
                    cache: "no-store"
                }
            );


        const result =
            await response.json();


        if (
            !response.ok ||
            !result.ok
        ) {

            throw new Error(
                result.error ||
                "Erro ao buscar âncora."
            );
        }


        anchorData =
            result.data;


        if (gldAnchorInput) {

            gldAnchorInput.value =
                Number(
                    anchorData.gld
                ).toFixed(2);
        }


        if (gcAnchorInput) {

            gcAnchorInput.value =
                Number(
                    anchorData.gc
                ).toFixed(2);
        }


        if (anchorTimeInput) {

            anchorTimeInput.value =
                anchorData.display_time;
        }


        const showGLD =
            document.getElementById(
                "showGLD"
            );

        const showGC =
            document.getElementById(
                "showGC"
            );

        const showXAU =
            document.getElementById(
                "showXAU"
            );

        const showFactor =
            document.getElementById(
                "showFactor"
            );

        const showSpread =
            document.getElementById(
                "showSpread"
            );

        const showTime =
            document.getElementById(
                "showTime"
            );


        if (showGLD) {

            showGLD.textContent =
                marketData
                    ? formatNumber(
                        marketData.gld_price
                    )
                    : formatNumber(
                        anchorData.gld
                    );
        }


        if (showGC) {

            showGC.textContent =
                marketData
                    ? formatNumber(
                        marketData.gc_price
                    )
                    : formatNumber(
                        anchorData.gc
                    );
        }


        if (showXAU) {

            showXAU.textContent =
                marketData
                    ? formatNumber(
                        marketData.xau_spot
                    )
                    : "-";
        }


        if (showFactor) {

            showFactor.textContent =
                marketData
                    ? Number(
                        marketData.factor
                    ).toFixed(8)
                    : Number(
                        anchorData.factor
                    ).toFixed(8);
        }


        if (showSpread) {

            const spread =
                calcularSpreadGCXAU();


            showSpread.textContent =
                Number.isFinite(spread)
                    ? formatNumber(spread)
                    : "-";
        }


        if (showTime) {

            showTime.textContent =
                anchorData.display_time;
        }


        renderizar();

    }

    catch (error) {

        console.error(
            "ERRO ÂNCORA:",
            error
        );


        setStatus(
            "Erro na âncora: " +
            error.message,
            "error"
        );
    }
}


// ==========================================================
// EXTRAI SNAPSHOT ALGOX
// ==========================================================

function getAlgoXSnapshot(data) {

    if (!data) {
        return null;
    }


    const candidates = [

        data.algox_snapshot,
        data.algoxSnapshot,
        data.algoX_snapshot,

        data.source_as_of,

        data.snapshot,

        data.snapshot_id,
        data.snapshot_time,
        data.snapshot_timestamp,

        data.algox &&
            data.algox.snapshot,

        data.algox &&
            data.algox.snapshot_id,

        data.algox &&
            data.algox.timestamp,

        data.algox &&
            data.algox.source_as_of

    ];


    for (
        const value of candidates
    ) {

        if (
            value !== undefined &&
            value !== null &&
            value !== ""
        ) {

            return String(value);
        }
    }


    return null;
}


// ==========================================================
// VERIFICA SE RESPOSTA É GAMMA VÁLIDO
// ==========================================================

function validateGammaResponse(data) {

    if (!data) {
        return false;
    }


    if (
        !Array.isArray(
            data.rows
        )
    ) {
        return false;
    }


    if (
        data.rows.length === 0
    ) {
        return false;
    }


    return true;
}


// ==========================================================
// CARREGAR GAMMA
// ==========================================================

async function carregarGamma(force = false) {

    try {

        setStatus(
            "Verificando novo snapshot AlgoX..."
        );


        const response =
            await fetch(
                `/api/gamma?dte=${selectedDTE}&force=${force ? 1 : 0}&ts=${Date.now()}`,
                {
                    cache: "no-store",
                    headers: {
                        "Cache-Control": "no-cache"
                    }
                }
            );


        const result =
            await response.json();


        if (
            !response.ok ||
            !result.ok
        ) {

            throw new Error(
                result.error ||
                "Erro ao carregar Gamma."
            );
        }


        if (
            !validateGammaResponse(
                result.data
            )
        ) {

            throw new Error(
                "API retornou Gamma sem rows válidos."
            );
        }


        marketData =
            result.data;


        // --------------------------------------------------
        // SNAPSHOT
        // --------------------------------------------------

        const snapshot =
            getAlgoXSnapshot(
                marketData
            );


        const snapshotChanged =
            snapshot !==
            lastAlgoXSnapshot;


        lastAlgoXSnapshot =
            snapshot;


        // --------------------------------------------------
        // HORÁRIOS ALGOX
        // --------------------------------------------------

        renderAlgoXTiming(
            marketData
        );


        // --------------------------------------------------
        // HORÁRIOS DAS COTAÇÕES
        // --------------------------------------------------

        renderCaptureTimes(
            marketData
        );


        // --------------------------------------------------
        // FONTE
        // --------------------------------------------------

        updateGammaSource(
            marketData
        );


        // --------------------------------------------------
        // GAMMA FLIP
        // --------------------------------------------------

        renderGammaFlip();


        // --------------------------------------------------
        // SPREAD
        // --------------------------------------------------

        const spread =
            calcularSpreadGCXAU();


        // --------------------------------------------------
        // DADOS DOS NÍVEIS
        // --------------------------------------------------

        gammaData =
            marketData.rows
                .map(row => ({

                    gld:
                        Number(
                            row.gld
                        ),

                    gc:
                        Number(
                            row.gc
                        ),

                    xau:
                        row.xau === null ||
                        row.xau === undefined
                            ? null
                            : Number(
                                row.xau
                            ),

                    gex:
                        Number(
                            row.gex
                        ),

                    intensity:
                        Number(
                            row.intensity
                        )

                }))
                .filter(row =>
                    Number.isFinite(
                        row.gld
                    ) &&
                    Number.isFinite(
                        row.gc
                    ) &&
                    Number.isFinite(
                        row.gex
                    )
                );


        if (
            gammaData.length === 0
        ) {

            throw new Error(
                "A API retornou 0 níveis GEX."
            );
        }


        // --------------------------------------------------
        // PREÇOS
        // --------------------------------------------------

        const showGLD =
            document.getElementById(
                "showGLD"
            );

        const showGC =
            document.getElementById(
                "showGC"
            );

        const showXAU =
            document.getElementById(
                "showXAU"
            );

        const showFactor =
            document.getElementById(
                "showFactor"
            );

        const showSpread =
            document.getElementById(
                "showSpread"
            );


        if (showGLD) {

            showGLD.textContent =
                formatNumber(
                    marketData.gld_price
                );
        }


        if (showGC) {

            showGC.textContent =
                formatNumber(
                    marketData.gc_price
                );
        }


        if (showXAU) {

            showXAU.textContent =
                formatNumber(
                    marketData.xau_spot
                );
        }


        if (showFactor) {

            showFactor.textContent =
                Number(
                    marketData.factor
                ).toFixed(8);
        }


        if (showSpread) {

            showSpread.textContent =
                Number.isFinite(spread)
                    ? formatNumber(spread)
                    : "-";
        }


        // --------------------------------------------------
        // STATUS
        // --------------------------------------------------

        const age =
            Number(
                marketData.source_age_seconds
            );


        let ageText = "";


        if (Number.isFinite(age)) {

            if (age < 60) {

                ageText =
                    `${Math.round(age)}s`;

            }

            else {

                ageText =
                    `${Math.round(
                        age / 60
                    )} min`;
            }
        }


        let snapshotText = "-";


        if (marketData.source_as_of) {

            const date =
                new Date(
                    marketData.source_as_of
                );


            if (
                !Number.isNaN(
                    date.getTime()
                )
            ) {

                snapshotText =
                    date.toLocaleTimeString(
                        "pt-BR",
                        {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                            hour12: false,
                            timeZone:
                                "America/New_York"
                        }
                    );
            }

            else {

                snapshotText =
                    String(
                        marketData.source_as_of
                    );
            }

        }

        else if (snapshot) {

            const normalized =
                normalizeCaptureTime(
                    snapshot,
                    "America/New_York"
                );


            if (normalized) {
                snapshotText =
                    normalized;
            }
        }


        // --------------------------------------------------
        // HORÁRIOS ALGOX
        // --------------------------------------------------

        const timing =
            getAlgoXTiming(
                marketData
            );


        let timingText = "";


        if (timing) {

            timingText =
                ` · Disponibilizado ` +
                `${timing.snapshotNY || "-"} NY` +
                ` | ` +
                `${timing.snapshotBR || "-"} BR` +
                ` · Capturado ` +
                `${timing.capturedNY || "-"} NY` +
                ` | ` +
                `${timing.capturedBR || "-"} BR`;
        }


        // --------------------------------------------------
        // STATUS
        // --------------------------------------------------

        setStatus(

            `ALGOX · snapshot ${snapshotText} ET`

            +

            (
                ageText
                    ? ` · idade ${ageText}`
                    : ""
            )

            +

            timingText

            +

            ` · ${gammaData.length} níveis`,

            "success"
        );


        // --------------------------------------------------
        // DTE
        // --------------------------------------------------

        atualizarIndicadorDTE();


        // --------------------------------------------------
        // RENDER
        // --------------------------------------------------

        renderizar();

        renderGammaFlip();

        renderCaptureTimes(
            marketData
        );


        // --------------------------------------------------
        // LOG
        // --------------------------------------------------

        console.log(
            "=========================================="
        );

        console.log(
            "          ALGOX SNAPSHOT"
        );

        console.log(
            "=========================================="
        );

        console.log(
            "SNAPSHOT:",
            snapshot
        );

        console.log(
            "SNAPSHOT MUDOU:",
            snapshotChanged
        );

        console.log(
            "DISPONIBILIZADO NY:",
            timing
                ? timing.snapshotNY
                : "-"
        );

        console.log(
            "DISPONIBILIZADO BR:",
            timing
                ? timing.snapshotBR
                : "-"
        );

        console.log(
            "CAPTURADO NY:",
            timing
                ? timing.capturedNY
                : "-"
        );

        console.log(
            "CAPTURADO BR:",
            timing
                ? timing.capturedBR
                : "-"
        );

        console.log(
            "ATRASO:",
            timing
                ? formatDelay(
                    timing.delaySeconds
                )
                : "-"
        );

        console.log(
            "GLD:",
            marketData.gld_price
        );

        console.log(
            "GC:",
            marketData.gc_price
        );

        console.log(
            "XAU:",
            marketData.xau_spot
        );

        console.log(
            "FATOR:",
            marketData.factor
        );

        console.log(
            "SPREAD:",
            spread
        );

        console.log(
            "NÍVEIS:",
            gammaData.length
        );

        console.log(
            "COTAÇÕES COMPLETAS:",
            {
                capture_times:
                    marketData.capture_times,

                captured_times:
                    marketData.captured_times,

                quote_timing:
                    marketData.quote_timing,

                market_timing:
                    marketData.market_timing,

                quotes:
                    marketData.quotes,

                prices:
                    marketData.prices,

                gld:
                    marketData.gld,

                gc:
                    marketData.gc,

                xau:
                    marketData.xau,

                gld_captured_at:
                    marketData.gld_captured_at,

                gc_captured_at:
                    marketData.gc_captured_at,

                xau_captured_at:
                    marketData.xau_captured_at
            }
        );

    }

    catch (error) {

        console.error(
            "ERRO GAMMA:",
            error
        );


        setStatus(
            "Erro no Gamma: " +
            error.message,
            "error"
        );
    }
}


// ==========================================================
// RENDER ALGOX TIMING
// ==========================================================

function renderAlgoXTiming(data) {

    const timing =
        getAlgoXTiming(
            data
        );


    const snapshotNY =
        document.getElementById(
            "algoxSnapshotNY"
        );

    const snapshotBR =
        document.getElementById(
            "algoxSnapshotBR"
        );

    const capturedNY =
        document.getElementById(
            "algoxCapturedNY"
        );

    const capturedBR =
        document.getElementById(
            "algoxCapturedBR"
        );

    const delay =
        document.getElementById(
            "algoxDelay"
        );


    if (!timing) {

        if (snapshotNY) {
            snapshotNY.textContent =
                "--:--:--";
        }

        if (snapshotBR) {
            snapshotBR.textContent =
                "--:--:--";
        }

        if (capturedNY) {
            capturedNY.textContent =
                "--:--:--";
        }

        if (capturedBR) {
            capturedBR.textContent =
                "--:--:--";
        }

        if (delay) {
            delay.textContent =
                "--";
        }

        return;
    }


    if (snapshotNY) {

        snapshotNY.textContent =
            timing.snapshotNY ||
            "--:--:--";
    }


    if (snapshotBR) {

        snapshotBR.textContent =
            timing.snapshotBR ||
            "--:--:--";
    }


    if (capturedNY) {

        capturedNY.textContent =
            timing.capturedNY ||
            "--:--:--";
    }


    if (capturedBR) {

        capturedBR.textContent =
            timing.capturedBR ||
            "--:--:--";
    }


    if (delay) {

        delay.textContent =
            formatDelay(
                timing.delaySeconds
            );
    }
}


// ==========================================================
// DTE
// ==========================================================

function atualizarIndicadorDTE() {

    const dteElement =
        document.getElementById(
            "currentDTE"
        );


    if (dteElement) {

        dteElement.textContent =
            getDteLabel();
    }


    const expirationElement =
        document.getElementById(
            "currentExpiration"
        );


    if (
        expirationElement &&
        marketData
    ) {

        expirationElement.textContent =
            marketData.expiration &&
            marketData.expiration !== "-"

                ? marketData.expiration

                : "AlgoX · nearest expiry";
    }


    const frozenElement =
        document.getElementById(
            "gammaFrozen"
        );


    if (frozenElement) {

        frozenElement.textContent =
            "ALGOX";

        frozenElement.className =
            "gamma-algox";
    }


    document
        .querySelectorAll(
            "[data-dte]"
        )
        .forEach(
            button => {

                const value =
                    Number(
                        button.dataset.dte
                    );


                button.classList.toggle(
                    "active",
                    value === selectedDTE
                );
            }
        );
}


// ==========================================================
// RENDERIZAR
// ==========================================================

function renderizar() {

    if (!marketData) {
        return;
    }


    if (!gammaData.length) {
        return;
    }


    // ======================================================
    // RESUMO
    // ======================================================

    const showGLD =
        document.getElementById(
            "showGLD"
        );

    const showGC =
        document.getElementById(
            "showGC"
        );

    const showXAU =
        document.getElementById(
            "showXAU"
        );

    const showFactor =
        document.getElementById(
            "showFactor"
        );

    const showSpread =
        document.getElementById(
            "showSpread"
        );

    const showTime =
        document.getElementById(
            "showTime"
        );


    if (showGLD) {

        showGLD.textContent =
            formatNumber(
                marketData.gld_price
            );
    }


    if (showGC) {

        showGC.textContent =
            formatNumber(
                marketData.gc_price
            );
    }


    if (showXAU) {

        showXAU.textContent =
            formatNumber(
                marketData.xau_spot
            );
    }


    if (showFactor) {

        showFactor.textContent =
            Number(
                marketData.factor
            ).toFixed(8);
    }


    if (showSpread) {

        const spread =
            calcularSpreadGCXAU();


        showSpread.textContent =
            Number.isFinite(spread)
                ? formatNumber(spread)
                : "-";
    }


    if (
        showTime &&
        anchorData
    ) {

        showTime.textContent =
            anchorData.display_time;
    }


    // ======================================================
    // MAIOR POSITIVO
    // ======================================================

    const positiveRows =
        gammaData.filter(
            item =>
                item.gex > 0
        );


    const positive =
        positiveRows.length

            ? positiveRows.reduce(
                (max, item) =>
                    item.gex > max.gex
                        ? item
                        : max
            )

            : null;


    // ======================================================
    // MAIOR NEGATIVO
    // ======================================================

    const negativeRows =
        gammaData.filter(
            item =>
                item.gex < 0
        );


    const negative =
        negativeRows.length

            ? negativeRows.reduce(
                (min, item) =>
                    item.gex < min.gex
                        ? item
                        : min
            )

            : null;


    // ======================================================
    // MAIOR POSITIVO
    // ======================================================

    const maxPositive =
        document.getElementById(
            "maxPositive"
        );


    if (maxPositive) {

        maxPositive.textContent =
            positive
                ? formatNumber(
                    positive.gld
                )
                : "-";
    }


    // ======================================================
    // MAIOR NEGATIVO
    // ======================================================

    const maxNegative =
        document.getElementById(
            "maxNegative"
        );


    if (maxNegative) {

        maxNegative.textContent =
            negative
                ? formatNumber(
                    negative.gld
                )
                : "-";
    }


    // ======================================================
    // GAMMA LONG GC
    // ======================================================

    const gammaLong =
        document.getElementById(
            "gammaLong"
        );


    if (gammaLong) {

        gammaLong.textContent =
            positive
                ? formatNumber(
                    positive.gc
                )
                : "-";
    }


    // ======================================================
    // GAMMA SHORT GC
    // ======================================================

    const gammaShort =
        document.getElementById(
            "gammaShort"
        );


    if (gammaShort) {

        gammaShort.textContent =
            negative
                ? formatNumber(
                    negative.gc
                )
                : "-";
    }


    // ======================================================
    // TABELA
    // ======================================================

    if (!gammaTable) {
        return;
    }


    gammaTable.innerHTML =
        "";


    const sortedData =
        [...gammaData].sort(
            (a, b) =>
                b.gld -
                a.gld
        );


    const dadosParaMostrar =
        mostrarTodosOsNiveis
            ? sortedData
            : sortedData.slice(
                0,
                MAX_NIVEIS_PADRAO
            );


    const moreLevelsButton =
        document.getElementById(
            "moreLevelsButton"
        );


    if (moreLevelsButton) {

        moreLevelsButton.textContent =
            mostrarTodosOsNiveis
                ? "MOSTRAR MENOS NÍVEIS"
                : "MOSTRAR MAIS NÍVEIS";
    }


    // ======================================================
    // LINHAS
    // ======================================================

    dadosParaMostrar.forEach(
        item => {

            const isPositive =
                item.gex >= 0;


            const barClass =
                isPositive
                    ? "positive"
                    : "negative";


            const textClass =
                isPositive
                    ? "positive-text"
                    : "negative-text";


            let marker = "";


            // ------------------------------------------------
            // MAX +
            // ------------------------------------------------

            if (
                marketData &&
                marketData.max_positive !== null &&
                Number(item.gld) ===
                Number(
                    marketData.max_positive
                )
            ) {

                marker += `

                    <span class="marker long">
                        MAX +
                    </span>

                `;
            }


            // ------------------------------------------------
            // MAX -
            // ------------------------------------------------

            if (
                marketData &&
                marketData.max_negative !== null &&
                Number(item.gld) ===
                Number(
                    marketData.max_negative
                )
            ) {

                marker += `

                    <span class="marker short">
                        MAX -
                    </span>

                `;
            }


            const row =
                document.createElement(
                    "div"
                );


            row.className =
                "row";


            const intensity =
                Number(
                    item.intensity
                );


            // ------------------------------------------------
            // XAU DO NÍVEL
            // ------------------------------------------------

            const converted =
                converterGCparaXAU(
                    item.gc
                );


            const xauLevel =
                Number.isFinite(
                    converted
                )
                    ? formatNumber(
                        converted
                    )
                    : "-";


            row.innerHTML = `

                <div class="price">

                    ${formatNumber(
                        item.gld
                    )}

                    ${marker}

                </div>


                <div class="price gc-price">

                    ${formatNumber(
                        item.gc
                    )}

                </div>


                <div class="price xau-price">

                    ${xauLevel}

                </div>


                <div class="bar-cell">

                    <div class="bar-container">

                        <div
                            class="bar ${barClass}"
                            style="width:${Math.min(
                                100,
                                Math.max(
                                    0,
                                    intensity
                                )
                            )}%"
                            title="GEX: ${formatGEX(
                                item.gex
                            )}"
                        ></div>

                    </div>

                </div>


                <div class="gex ${textClass}">

                    ${formatGEX(
                        item.gex
                    )}

                </div>

            `;


            gammaTable.appendChild(
                row
            );
        }
    );
}


// ==========================================================
// TESTE MANUAL
// ==========================================================

function calcularManual() {

    if (
        !gldAnchorInput ||
        !gcAnchorInput
    ) {
        return;
    }


    let factor =
        marketData
            ? Number(
                marketData.factor
            )
            : NaN;


    if (!Number.isFinite(factor)) {

        const gldAnchor =
            Number(
                gldAnchorInput.value
            );

        const gcAnchor =
            Number(
                gcAnchorInput.value
            );


        if (
            !Number.isFinite(gldAnchor) ||
            !Number.isFinite(gcAnchor) ||
            gldAnchor === 0
        ) {

            setStatus(
                "Digite primeiro o GLD e o GC da âncora.",
                "error"
            );

            return;
        }


        factor =
            gcAnchor /
            gldAnchor;
    }


    function converter(gldLevel) {

        return (
            gldLevel *
            factor
        );
    }


    const levels = [

        {
            input: "manual393",
            gld: "manualGld393",
            gc: "manualGc393"
        },

        {
            input: "manual392",
            gld: "manualGld392",
            gc: "manualGc392"
        },

        {
            input: "manual391",
            gld: "manualGld391",
            gc: "manualGc391"
        },

        {
            input: "manual390",
            gld: "manualGld390",
            gc: "manualGc390"
        }

    ];


    levels.forEach(
        item => {

            const input =
                document.getElementById(
                    item.input
                );


            if (!input) {
                return;
            }


            const gldValue =
                Number(
                    input.value
                );


            const gldElement =
                document.getElementById(
                    item.gld
                );


            const gcElement =
                document.getElementById(
                    item.gc
                );


            if (gldElement) {

                gldElement.textContent =
                    Number.isFinite(
                        gldValue
                    )
                        ? gldValue.toFixed(2)
                        : "-";
            }


            if (gcElement) {

                gcElement.textContent =
                    Number.isFinite(
                        gldValue
                    )
                        ? converter(
                            gldValue
                        ).toFixed(2)
                        : "-";
            }
        }
    );


    const showFactor =
        document.getElementById(
            "showFactor"
        );


    if (showFactor) {

        showFactor.textContent =
            factor.toFixed(8);
    }


    const spread =
        calcularSpreadGCXAU();


    setStatus(

        `Teste manual realizado · fator ${factor.toFixed(8)}`

        +

        (
            Number.isFinite(spread)
                ? ` · spread ${formatNumber(spread)}`
                : ""
        ),

        "success"
    );
}


// ==========================================================
// BOTÃO ATUALIZAR
// ==========================================================

if (calculateButton) {

    calculateButton.addEventListener(
        "click",
        async function() {

            await carregarAnchor();

            await carregarGamma(
                true
            );
        }
    );
}


// ==========================================================
// BOTÃO MANUAL
// ==========================================================

if (manualButton) {

    manualButton.addEventListener(
        "click",
        calcularManual
    );
}


// ==========================================================
// DTE
// ==========================================================

document.addEventListener(
    "click",
    async function(event) {

        const button =
            event.target.closest(
                "[data-dte]"
            );


        if (!button) {
            return;
        }


        const dte =
            Number(
                button.dataset.dte
            );


        if (
            dte !== 0 &&
            dte !== 1
        ) {
            return;
        }


        if (
            dte === selectedDTE
        ) {
            return;
        }


        selectedDTE =
            dte;


        atualizarIndicadorDTE();


        await carregarGamma(
            false
        );
    }
);


// ==========================================================
// MAIS NÍVEIS
// ==========================================================

document.addEventListener(
    "click",
    function(event) {

        if (
            event.target &&
            event.target.id ===
            "moreLevelsButton"
        ) {

            mostrarTodosOsNiveis =
                !mostrarTodosOsNiveis;


            renderizar();
        }
    }
);


// ==========================================================
// MINIMIZAR GAMMA FLIP
// ==========================================================

const toggleGammaFlip =
    document.getElementById(
        "toggleGammaFlip"
    );


const gammaFlipPanel =
    document.getElementById(
        "gammaFlipPanel"
    );


if (
    toggleGammaFlip &&
    gammaFlipPanel
) {

    toggleGammaFlip.addEventListener(
        "click",
        function() {

            const minimized =
                gammaFlipPanel.classList.toggle(
                    "minimized"
                );


            toggleGammaFlip.textContent =
                minimized
                    ? "+"
                    : "−";
        }
    );
}


// ==========================================================
// VERIFICAR NOVO SNAPSHOT ALGOX
// ==========================================================

async function verificarAlgoX() {

    try {

        const response =
            await fetch(
                `/api/gamma?dte=${selectedDTE}&ts=${Date.now()}`,
                {
                    cache: "no-store",
                    headers: {
                        "Cache-Control": "no-cache"
                    }
                }
            );


        const result =
            await response.json();


        if (
            !response.ok ||
            !result.ok ||
            !result.data
        ) {
            return;
        }


        const snapshot =
            getAlgoXSnapshot(
                result.data
            );


        if (
            snapshot &&
            snapshot !==
            lastAlgoXSnapshot
        ) {

            console.log(
                "NOVO SNAPSHOT ALGOX:",
                snapshot
            );


            await carregarGamma(
                false
            );
        }
    }

    catch (error) {

        console.error(
            "Erro verificando AlgoX:",
            error
        );
    }
}


// ==========================================================
// VERIFICAR VIRADA DE HORA DA ÂNCORA
// ==========================================================

let lastAnchorHour = null;


async function verificarVirada() {

    try {

        const response =
            await fetch(
                "/api/anchor?ts=" +
                Date.now(),
                {
                    cache: "no-store",
                    headers: {
                        "Cache-Control": "no-cache"
                    }
                }
            );


        const result =
            await response.json();


        if (
            !response.ok ||
            !result.ok
        ) {
            return;
        }


        const newAnchor =
            result.data;


        if (
            lastAnchorHour === null
        ) {

            lastAnchorHour =
                newAnchor.time;

            return;
        }


        if (
            newAnchor.time !==
            lastAnchorHour
        ) {

            console.log(
                "Nova hora-chave:",
                newAnchor.display_time
            );


            lastAnchorHour =
                newAnchor.time;


            await carregarAnchor();
        }
    }

    catch (error) {

        console.error(
            "Erro verificando virada:",
            error
        );
    }
}


// ==========================================================
// INICIALIZAÇÃO
// ==========================================================

async function iniciar() {

    console.log(
        "========== INICIANDO APP =========="
    );


    atualizarIndicadorDTE();


    await carregarAnchor();


    await carregarGamma(
        true
    );


    // ------------------------------------------------------
    // ALGOX
    // ------------------------------------------------------

    setInterval(
        verificarAlgoX,
        60000
    );


    // ------------------------------------------------------
    // ÂNCORA
    // ------------------------------------------------------

    setInterval(
        verificarVirada,
        30000
    );
}


// ==========================================================
// START
// ==========================================================

iniciar();
