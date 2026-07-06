"use strict";

/* ==========================================================================
   GIS BENCHMARK APP — n8n Workflow Entegrasyonu
   4 model × 10 senaryo = 40 test
   Metrikler: tool_accuracy, spatial_accuracy, param_accuracy, schema_validity
   ========================================================================== */

/* --------------------------------------------------------------------------
   Model tanımları
   -------------------------------------------------------------------------- */
const BX_MODELS = [
  { key: "claude",   name: "Claude Sonnet 4.6",   color: "#d97757" },
  { key: "gpt",      name: "GPT 5.5",              color: "#19c37d" },
  { key: "groq",     name: "Llama 3.1",            color: "#f55036" },
  { key: "gemini",   name: "Gemini 2.5 Flash",     color: "#5b8def" },
  { key: "deepseek", name: "DeepSeek V4 Flash",    color: "#3b82f6" },
  { key: "qwen",     name: "Qwen 3.7 Flash",       color: "#a855f7" },
  { key: "glm",      name: "GLM 5.1",              color: "#14b8a6" },
];

// Eski veya yanlış senaryo sayısına sahip benchmark önbelleğini temizle
(function() {
  const cached = localStorage.getItem("bx_last_result");
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed) {
        if (parsed.test_case_count !== 9) {
          localStorage.removeItem("bx_last_result");
          return;
        }
        if (parsed.dashboard) {
          for (const key in parsed.dashboard) {
            const mData = parsed.dashboard[key];
            if (mData && mData.details && mData.details.length !== 9) {
              localStorage.removeItem("bx_last_result");
              break;
            }
          }
        }
      }
    } catch (e) {
      localStorage.removeItem("bx_last_result");
    }
  }
})();

const BX_METRICS = [
  { key: "tool_accuracy",    label: "Araç Doğruluğu",     shortLabel: "Araç",    icon: "🔧" },
  { key: "spatial_accuracy",  label: "Konum Doğruluğu",    shortLabel: "Konum",   icon: "📍" },
  { key: "param_accuracy",    label: "Parametre Doğruluğu", shortLabel: "Param",   icon: "⚙️" },
  { key: "schema_validity",   label: "GeoJSON Geçerliliği", shortLabel: "Schema",  icon: "✅" },
];

const RANK_ICONS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣"];

/* --------------------------------------------------------------------------
   DOM Referansları
   -------------------------------------------------------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  hero:       $("#bx-hero"),
  loading:    $("#bx-loading"),
  error:      $("#bx-error"),
  results:    $("#bx-results"),
  startBtn:   $("#bx-start-btn"),
  retryBtn:   $("#bx-retry-btn"),
  rerunBtn:   $("#bx-rerun-btn"),
  statusChip: $("#bx-status-chip"),
  errorMsg:   $("#bx-error-msg"),
  progressFill: $("#bx-progress-fill"),
  progressText: $("#bx-progress-text"),
  winnerName:   $("#bx-winner-name"),
  winnerScore:  $("#bx-winner-score"),
  overviewGrid: $("#bx-overview-grid"),
  detailTabs:   $("#bx-detail-tabs"),
  detailThead:  $("#bx-detail-thead"),
  detailTbody:  $("#bx-detail-tbody"),
  timestamp:    $("#bx-results-timestamp"),
};

/* --------------------------------------------------------------------------
   Durum Yönetimi
   -------------------------------------------------------------------------- */
let chartInstances = {};
let cachedData = null;
let activeDetailView = "all"; // "all" veya model key

/* --------------------------------------------------------------------------
   Olaylar
   -------------------------------------------------------------------------- */
dom.startBtn.addEventListener("click", runBenchmark);
dom.retryBtn.addEventListener("click", runBenchmark);
dom.rerunBtn.addEventListener("click", runBenchmark);

// Sayfa yüklendiğinde cache kontrol
window.addEventListener("load", () => {
  fetch("/api/benchmark", { method: "GET" })
    .then(res => res.json())
    .then(data => {
      if (data && data.dashboard && Object.keys(data.dashboard).length > 0) {
        localStorage.setItem("bx_last_result", JSON.stringify(data));
        cachedData = data;
        showResults(data);
      } else {
        // Fallback to cache if server has no data
        const cached = localStorage.getItem("bx_last_result");
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed && parsed.dashboard) {
              cachedData = parsed;
              showResults(parsed);
            }
          } catch(e) {}
        }
      }
    }).catch(() => {
      const cached = localStorage.getItem("bx_last_result");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed && parsed.dashboard) {
            cachedData = parsed;
            showResults(parsed);
          }
        } catch(e) {}
      }
    });
});

/* --------------------------------------------------------------------------
   Benchmark Çalıştır
   -------------------------------------------------------------------------- */
async function runBenchmark() {
  showState("loading");
  startProgressAnimation();

  try {
    const res = await fetch("/api/benchmark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    if (data.error) {
      showState("error", data.error);
      return;
    }

    if (!data.dashboard) {
      showState("error", "n8n'den beklenen veri formatı alınamadı. Workflow'un aktif ve doğru yapılandırılmış olduğundan emin olun.");
      return;
    }

    // Cache
    localStorage.setItem("bx_last_result", JSON.stringify(data));
    cachedData = data;

    showResults(data);

  } catch (err) {
    showState("error", `Sunucuya bağlanılamadı: ${err.message}`);
  }
}

/* --------------------------------------------------------------------------
   Durum Geçişleri
   -------------------------------------------------------------------------- */
function showState(state, errorMsg) {
  dom.hero.classList.toggle("hidden", state !== "hero");
  dom.loading.classList.toggle("hidden", state !== "loading");
  dom.error.classList.toggle("hidden", state !== "error");
  dom.results.classList.toggle("hidden", state !== "results");

  const chip = dom.statusChip;
  chip.className = "bx-status-chip";

  if (state === "loading") {
    chip.textContent = "Çalışıyor…";
    chip.classList.add("running");
  } else if (state === "error") {
    chip.textContent = "Hata";
    chip.classList.add("error");
    dom.errorMsg.textContent = errorMsg || "Bilinmeyen hata";
  } else if (state === "results") {
    chip.textContent = "Tamamlandı";
    chip.classList.add("done");
  } else {
    chip.textContent = "Hazır";
  }
}

/* --------------------------------------------------------------------------
   İlerleme Animasyonu
   -------------------------------------------------------------------------- */
function startProgressAnimation() {
  let progress = 0;
  dom.progressFill.style.width = "0%";

  const messages = [
    "Modellere bağlanılıyor…",
    "Claude Sonnet 4.6 test ediliyor…",
    "GPT 5.5 test ediliyor…",
    "Llama 3.1 test ediliyor…",
    "Gemini 2.5 Flash test ediliyor…",
    "DeepSeek V4 Flash test ediliyor…",
    "Qwen 3.7 Flash test ediliyor…",
    "GLM 5.1 test ediliyor…",
    "Senaryolar işleniyor…",
    "Geocoding doğruluğu hesaplanıyor…",
    "Sonuçlar toplanıyor…",
    "Neredeyse bitti…",
  ];

  let msgIdx = 0;
  const interval = setInterval(() => {
    progress = Math.min(progress + 2 + Math.random() * 3, 92);
    dom.progressFill.style.width = `${progress}%`;
    if (msgIdx < messages.length && progress > (msgIdx + 1) * 10) {
      dom.progressText.textContent = messages[msgIdx];
      msgIdx++;
    }
  }, 800);

  // Temizleme için global ref
  window._bxProgressInterval = interval;
}

function stopProgressAnimation() {
  if (window._bxProgressInterval) {
    clearInterval(window._bxProgressInterval);
    window._bxProgressInterval = null;
  }
  dom.progressFill.style.width = "100%";
  dom.progressText.textContent = "Tamamlandı!";
}

/* --------------------------------------------------------------------------
   Sonuçları Göster
   -------------------------------------------------------------------------- */
function showResults(data) {
  stopProgressAnimation();
  showState("results");

  const dashboard = data.dashboard;
  const timestamp = data.generated_at
    ? new Date(data.generated_at).toLocaleString("tr-TR")
    : new Date().toLocaleString("tr-TR");

  dom.timestamp.textContent = `${timestamp} · ${data.test_case_count || 10} senaryo`;

  // Model sıralaması — genel puana göre
  const ranked = BX_MODELS.map(m => {
    const d = dashboard[m.key] || {};
    const overall = computeOverall(d);
    return { ...m, data: d, overall };
  }).sort((a, b) => b.overall - a.overall);

  // Kazanan
  const winner = ranked[0];
  dom.winnerName.textContent = winner.name;
  dom.winnerScore.textContent = `Genel Skor: %${winner.overall} · Araç: %${winner.data.tool_accuracy || 0} · Konum: %${winner.data.spatial_accuracy || 0}`;

  renderOverviewCards(ranked);
  renderRadarChart(ranked);
  renderBarChart(ranked);
  renderMetricCharts(ranked);
  renderLatencyChart(ranked);
  renderDetailTable(data, ranked);
}

function computeOverall(d) {
  const metrics = [
    d.tool_accuracy || 0,
    d.spatial_accuracy || 0,
    d.param_accuracy || 0,
    d.schema_validity || 0,
  ];
  return Math.round(metrics.reduce((a, b) => a + b, 0) / metrics.length);
}

/* --------------------------------------------------------------------------
   Genel Bakış Kartları
   -------------------------------------------------------------------------- */
function renderOverviewCards(ranked) {
  dom.overviewGrid.innerHTML = ranked.map((m, i) => {
    const d = m.data;
    const isWinner = i === 0;
    const rank = RANK_ICONS[i] || `#${i + 1}`;

    return `
      <div class="bx-model-card ${isWinner ? "is-winner" : ""}" style="--mc:${m.color}; animation-delay:${i * 0.1}s">
        <div class="bx-model-card-header">
          <div class="bx-model-dot" style="background:${m.color}"></div>
          <span class="bx-model-card-name">${m.name}</span>
          <span class="bx-model-card-rank">${rank}</span>
        </div>
        <div class="bx-model-overall">
          <span class="bx-model-overall-score" style="color:${m.color}">%${m.overall}</span>
          <span class="bx-model-overall-label">Genel Skor</span>
        </div>
        <div class="bx-model-metrics">
          ${BX_METRICS.map(metric => {
            const val = d[metric.key] || 0;
            const barColor = val >= 80 ? "#19c37d" : val >= 50 ? "#f59e0b" : "#f55036";
            return `
              <div class="bx-metric-row">
                <span class="bx-metric-label">${metric.shortLabel}</span>
                <div class="bx-metric-bar-bg">
                  <div class="bx-metric-bar-fill" style="width:${val}%; background:${barColor}"></div>
                </div>
                <span class="bx-metric-value">%${val}</span>
              </div>
            `;
          }).join("")}
        </div>
        <div class="bx-model-latency">
          <span>⏱ Ort. Gecikme</span>
          <strong>${d.avg_latency_ms ? (d.avg_latency_ms / 1000).toFixed(1) + "s" : "—"}</strong>
        </div>
        ${d.error_count > 0 ? `<div class="bx-model-errors">⚠ ${d.error_count} hatalı test</div>` : ""}
      </div>
    `;
  }).join("");
}

/* --------------------------------------------------------------------------
   Radar Chart
   -------------------------------------------------------------------------- */
function renderRadarChart(ranked) {
  destroyChart("radar");
  const ctx = document.getElementById("bx-radar-chart")?.getContext("2d");
  if (!ctx) return;

  chartInstances.radar = new Chart(ctx, {
    type: "radar",
    data: {
      labels: BX_METRICS.map(m => m.label),
      datasets: ranked.map(m => ({
        label: m.name,
        data: BX_METRICS.map(metric => m.data[metric.key] || 0),
        borderColor: m.color,
        backgroundColor: m.color + "18",
        borderWidth: 2.5,
        pointBackgroundColor: m.color,
        pointBorderColor: "#12161f",
        pointBorderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 7,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800 },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#8b94a7",
            font: { family: "Inter", size: 11 },
            boxWidth: 14,
            padding: 16,
          },
        },
        tooltip: {
          backgroundColor: "#12161f",
          borderColor: "#232a38",
          borderWidth: 1,
          titleColor: "#e9ecf2",
          bodyColor: "#8b94a7",
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: %${ctx.raw}`,
          },
        },
      },
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: {
            stepSize: 20,
            color: "#5c6478",
            backdropColor: "transparent",
            font: { size: 10 },
          },
          grid: { color: "#232a38" },
          angleLines: { color: "#1c222e" },
          pointLabels: {
            color: "#8b94a7",
            font: { family: "Inter", size: 11.5, weight: 500 },
          },
        },
      },
    },
  });
}

/* --------------------------------------------------------------------------
   Bar Chart — Genel Sıralama
   -------------------------------------------------------------------------- */
function renderBarChart(ranked) {
  destroyChart("bar");
  const ctx = document.getElementById("bx-bar-chart")?.getContext("2d");
  if (!ctx) return;

  chartInstances.bar = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ranked.map(m => m.name),
      datasets: [{
        label: "Genel Skor (%)",
        data: ranked.map(m => m.overall),
        backgroundColor: ranked.map(m => m.color + "bb"),
        borderColor: ranked.map(m => m.color),
        borderWidth: 2,
        borderRadius: 8,
        barThickness: 48,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      animation: { duration: 600 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#12161f",
          borderColor: "#232a38",
          borderWidth: 1,
          titleColor: "#e9ecf2",
          bodyColor: "#8b94a7",
          callbacks: {
            label: (ctx) => ` Genel Skor: %${ctx.raw}`,
          },
        },
      },
      scales: {
        x: {
          min: 0,
          max: 100,
          ticks: { color: "#5c6478", font: { size: 11 } },
          grid: { color: "#1c222e" },
        },
        y: {
          ticks: {
            color: "#8b94a7",
            font: { family: "Space Grotesk", size: 12, weight: 600 },
          },
          grid: { display: false },
        },
      },
    },
  });
}

/* --------------------------------------------------------------------------
   Metrik Bazlı Bar Charts
   -------------------------------------------------------------------------- */
function renderMetricCharts(ranked) {
  BX_METRICS.forEach(metric => {
    const chartKey = `metric_${metric.key}`;
    destroyChart(chartKey);

    const canvasId = `bx-chart-${metric.key.split("_")[0]}`;
    const ctx = document.getElementById(canvasId)?.getContext("2d");
    if (!ctx) return;

    chartInstances[chartKey] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: ranked.map(m => m.name),
        datasets: [{
          data: ranked.map(m => m.data[metric.key] || 0),
          backgroundColor: ranked.map(m => m.color + "bb"),
          borderColor: ranked.map(m => m.color),
          borderWidth: 2,
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        animation: { duration: 500 },
        plugins: { legend: { display: false } },
        scales: {
          x: {
            ticks: { color: "#5c6478", font: { size: 10 } },
            grid: { display: false },
          },
          y: {
            min: 0, max: 100,
            ticks: { color: "#5c6478", stepSize: 25, font: { size: 10 } },
            grid: { color: "#1c222e" },
          },
        },
      },
    });
  });
}

/* --------------------------------------------------------------------------
   Gecikme Chart
   -------------------------------------------------------------------------- */
function renderLatencyChart(ranked) {
  destroyChart("latency");
  const ctx = document.getElementById("bx-chart-latency")?.getContext("2d");
  if (!ctx) return;

  chartInstances.latency = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ranked.map(m => m.name),
      datasets: [{
        label: "Ort. Gecikme (ms)",
        data: ranked.map(m => m.data.avg_latency_ms || 0),
        backgroundColor: ranked.map(m => m.color + "88"),
        borderColor: ranked.map(m => m.color),
        borderWidth: 2,
        borderRadius: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#12161f",
          borderColor: "#232a38",
          borderWidth: 1,
          titleColor: "#e9ecf2",
          bodyColor: "#8b94a7",
          callbacks: {
            label: (ctx) => ` ${(ctx.raw / 1000).toFixed(1)}s (${ctx.raw}ms)`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#8b94a7",
            font: { family: "Space Grotesk", size: 12, weight: 600 },
          },
          grid: { display: false },
        },
        y: {
          ticks: {
            color: "#5c6478",
            font: { size: 10 },
            callback: (v) => (v / 1000).toFixed(0) + "s",
          },
          grid: { color: "#1c222e" },
        },
      },
    },
  });
}

/* --------------------------------------------------------------------------
   Detay Tablosu
   -------------------------------------------------------------------------- */
function renderDetailTable(data, ranked) {
  // Tab'lar — "Tümü" + her model
  const tabs = [{ key: "all", label: "📋 Tüm Modeller" }];
  ranked.forEach(m => tabs.push({ key: m.key, label: m.name }));

  dom.detailTabs.innerHTML = tabs.map(t =>
    `<button class="bx-detail-tab ${t.key === activeDetailView ? "active" : ""}" data-tab="${t.key}">${t.label}</button>`
  ).join("");

  dom.detailTabs.querySelectorAll(".bx-detail-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      activeDetailView = btn.dataset.tab;
      dom.detailTabs.querySelectorAll(".bx-detail-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      fillDetailTable(data, ranked);
    });
  });

  fillDetailTable(data, ranked);
}

function fillDetailTable(data, ranked) {
  const dashboard = data.dashboard;
  const view = activeDetailView;

  // --- Yardımcı: tek kriter rozeti ---
  function badge(ok, label) {
    if (ok === null) {
      return `<span style="background:rgba(255,255,255,0.05);color:var(--text-faint);padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700;font-family:var(--font-mono);">${label}</span>`;
    }
    const bg     = ok ? "rgba(25,195,125,0.15)" : "rgba(245,80,54,0.15)";
    const border = ok ? "rgba(25,195,125,0.4)"  : "rgba(245,80,54,0.4)";
    const color  = ok ? "#19c37d" : "#f55036";
    const icon   = ok ? "✓" : "✗";
    return `<span title="${label}: ${ok ? "Doğru" : "YANLIŞ"}" style="background:${bg};border:1px solid ${border};color:${color};padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700;font-family:var(--font-mono);">${icon}${label}</span>`;
  }

  // --- Yardımcı: parametre doğruluğu hesapla ---
  function getParamOk(row) {
    const parts = [];
    if (row.feature_type_match !== undefined) parts.push(row.feature_type_match);
    if (row.distance_match !== undefined)     parts.push(row.distance_match);
    if (!parts.length) return null;
    return parts.every(v => v === 1);
  }

  if (view === "all") {
    // ═══ BAŞLIK ═══
    dom.detailThead.innerHTML = `
      <tr>
        <th style="min-width:100px">İşlem</th>
        <th style="min-width:150px">Sorgu</th>
        ${ranked.map(m => `
          <th style="color:${m.color};text-align:center;min-width:120px">
            <div style="display:flex;align-items:center;justify-content:center;gap:5px">
              <span style="width:8px;height:8px;border-radius:50%;background:${m.color};display:inline-block"></span>
              ${m.name}
            </div>
            <div style="display:flex;gap:3px;justify-content:center;margin-top:3px;font-size:9px;color:var(--text-faint)">
              <span style="background:#1c222e;padding:1px 4px;border-radius:3px;font-weight:700">A</span>
              <span style="background:#1c222e;padding:1px 4px;border-radius:3px;font-weight:700">K</span>
              <span style="background:#1c222e;padding:1px 4px;border-radius:3px;font-weight:700">P</span>
              <span style="background:#1c222e;padding:1px 4px;border-radius:3px;font-weight:700">Ş</span>
            </div>
          </th>
        `).join("")}
      </tr>
    `;

    // ═══ SENARYO SATIRLARI ═══
    const firstModel = ranked[0];
    const details = dashboard[firstModel.key]?.details || [];

    const scenarioRows = details.map((row, idx) => {
      return `
        <tr>
          <td><span class="bx-cell-tool">${escHtml(row.expected_tool)}</span></td>
          <td class="bx-cell-query" title="${escHtml(row.query)}">${escHtml(row.query)}</td>
          ${ranked.map(m => {
            const mRow = dashboard[m.key]?.details?.[idx];
            if (!mRow) return `<td style="text-align:center">—</td>`;

            const toolOk   = mRow.tool_match === 1;
            const geoOk    = mRow.geocode_correct === 1;
            const paramOk  = getParamOk(mRow);
            const schemaOk = mRow.schema_valid === 1;

            const allOk = toolOk && geoOk && schemaOk && (paramOk !== false);
            const outerBg     = allOk ? "rgba(25,195,125,0.04)" : "rgba(245,80,54,0.04)";
            const outerBorder = allOk ? "rgba(25,195,125,0.18)" : "rgba(245,80,54,0.18)";

            return `
              <td style="text-align:center;padding:5px 4px">
                <div style="display:flex;gap:3px;justify-content:center;background:${outerBg};border:1px solid ${outerBorder};border-radius:6px;padding:5px 4px">
                  ${badge(toolOk,   "A")}
                  ${badge(geoOk,    "K")}
                  ${badge(paramOk,  "P")}
                  ${badge(schemaOk, "Ş")}
                </div>
              </td>
            `;
          }).join("")}
        </tr>
      `;
    }).join("");

    // ═══ ÖZET / YÜZDE SATIRI ═══
    function pctBadge(val, label) {
      if (val === null) return `<span style="background:rgba(255,255,255,0.05);color:var(--text-faint);padding:1px 5px;border-radius:3px;font-size:9px;font-family:var(--font-mono)">${label}:–</span>`;
      const color  = val >= 80 ? "#19c37d" : val >= 50 ? "#f59e0b" : "#f55036";
      const bg     = val >= 80 ? "rgba(25,195,125,0.12)" : val >= 50 ? "rgba(245,158,11,0.12)" : "rgba(245,80,54,0.12)";
      const border = val >= 80 ? "rgba(25,195,125,0.3)"  : val >= 50 ? "rgba(245,158,11,0.3)"  : "rgba(245,80,54,0.3)";
      return `<span style="background:${bg};border:1px solid ${border};color:${color};padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700;font-family:var(--font-mono)">${label}:%${val}</span>`;
    }

    const summaryRow = `
      <tr style="border-top:2px solid var(--border);background:rgba(139,92,246,0.05)">
        <td colspan="2" style="font-weight:700;font-size:12px;color:var(--text-dim);padding:10px 12px">
          📊 Genel Başarı %
        </td>
        ${ranked.map(m => {
          const rows = dashboard[m.key]?.details || [];
          if (!rows.length) return `<td style="text-align:center">—</td>`;

          const n = rows.length;
          const toolPct   = Math.round(rows.filter(r => r.tool_match === 1).length / n * 100);
          const geoPct    = Math.round(rows.filter(r => r.geocode_correct === 1).length / n * 100);
          const schemaPct = Math.round(rows.filter(r => r.schema_valid === 1).length / n * 100);

          const paramRows   = rows.filter(r => r.feature_type_match !== undefined || r.distance_match !== undefined);
          const paramOkRows = paramRows.filter(r => getParamOk(r) === true);
          const paramPct    = paramRows.length ? Math.round(paramOkRows.length / paramRows.length * 100) : null;

          const d = dashboard[m.key];
          const overallPct = d ? Math.round((d.tool_accuracy + d.spatial_accuracy + (d.param_accuracy || 0) + d.schema_validity) / 4) : 0;
          const overallColor = overallPct >= 80 ? "#19c37d" : overallPct >= 50 ? "#f59e0b" : "#f55036";

          return `
            <td style="text-align:center;padding:8px 4px;vertical-align:top">
              <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
                <div style="display:flex;gap:3px;flex-wrap:wrap;justify-content:center">
                  ${pctBadge(toolPct,   "A")}
                  ${pctBadge(geoPct,    "K")}
                  ${pctBadge(paramPct,  "P")}
                  ${pctBadge(schemaPct, "Ş")}
                </div>
                <div style="font-size:14px;font-weight:700;color:${overallColor};font-family:var(--font-display);margin-top:2px">%${overallPct}</div>
                <div style="font-size:9.5px;color:var(--text-faint)">Genel</div>
              </div>
            </td>
          `;
        }).join("")}
      </tr>
    `;

    dom.detailTbody.innerHTML = scenarioRows + summaryRow;

  } else {
    // ═══ TEK MODEL DETAYI ═══
    const details = dashboard[view]?.details || [];

    dom.detailThead.innerHTML = `
      <tr>
        <th>#</th>
        <th>Sorgu</th>
        <th>Beklenen Araç</th>
        <th>Seçilen Araç</th>
        <th title="Araç Doğruluğu">A</th>
        <th title="Konum Doğruluğu">K</th>
        <th title="Parametre Doğruluğu">P</th>
        <th title="Schema Geçerliliği">Ş</th>
        <th>Süre (ms)</th>
        <th>Hata</th>
      </tr>
    `;

    dom.detailTbody.innerHTML = details.map((row, idx) => {
      const toolOk   = row.tool_match === 1;
      const geoOk    = row.geocode_correct === 1;
      const schemaOk = row.schema_valid === 1;
      const paramOk  = getParamOk(row);

      function cell(ok, label) {
        if (ok === null) return `<td style="text-align:center;color:var(--text-faint)">–</td>`;
        return `<td class="${ok ? "bx-cell-pass" : "bx-cell-fail"}" style="text-align:center;font-weight:700" title="${label}: ${ok ? "Doğru" : "YANLIŞ"}">${ok ? "✓" : "✗"}</td>`;
      }

      const rowBg = (!toolOk || !geoOk || !schemaOk || paramOk === false) ? "background:rgba(245,80,54,0.03)" : "";

      return `
        <tr style="${rowBg}">
          <td>${idx + 1}</td>
          <td class="bx-cell-query" title="${escHtml(row.query)}">${escHtml(row.query)}</td>
          <td><span class="bx-cell-tool">${escHtml(row.expected_tool)}</span></td>
          <td><span class="bx-cell-tool" style="${toolOk ? "" : "color:#f55036;border-color:rgba(245,80,54,0.3)"}">${escHtml(row.actual_tool || "—")}</span></td>
          ${cell(toolOk,   "Araç")}
          ${cell(geoOk,    "Konum")}
          ${cell(paramOk,  "Parametre")}
          ${cell(schemaOk, "Schema")}
          <td>${row.processing_time_ms ?? "—"}</td>
          <td style="color:var(--status-error);font-size:10px;max-width:120px;overflow:hidden;text-overflow:ellipsis" title="${escHtml(row.error || "")}">${row.error ? "⚠ " + escHtml(row.error).substring(0, 30) : "—"}</td>
        </tr>
      `;
    }).join("");
  }
}

/* --------------------------------------------------------------------------
   Yardımcılar
   -------------------------------------------------------------------------- */
function destroyChart(key) {
  if (chartInstances[key]) {
    chartInstances[key].destroy();
    delete chartInstances[key];
  }
}

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
