"use strict";

/* ==========================================================================
   Sabitler
   ========================================================================== */

const MODELS = [
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

// Tarayıcı hafıza limit aşım hatası (QuotaExceededError) alınırsa akışın kilitlenmesini engellemek için güvenli setItem
function safeSetLocalStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn("[GIS Console] LocalStorage yazma limiti aşıldı, bellek temizleniyor...", e);
    // Eski/büyük verileri temizleyip yer açmaya çalışalım
    try {
      localStorage.removeItem("bx_last_result");
    } catch(err) {}
    try {
      localStorage.setItem(key, value);
    } catch(err) {
      console.error("[GIS Console] LocalStorage tamamen dolu, veri belleğe yazılamadı.");
    }
  }
}

// Son API sonucu — Benchmark paneli için saklanır
let lastAPIResults = null;
const lastGeoJSONs = {};
const activePopups = {};

const ISTANBUL_CENTER = [41.0082, 28.9784];
const ISTANBUL_ZOOM = 11;

const STATUS_LABELS = {
  idle: "Hazır",
  running: "Çalışıyor…",
  success: "Tamamlandı",
  empty: "Sonuç bulunamadı",
  error: "Hata",
};

const STATUS_CLASS = {
  idle: "",
  running: "status-running",
  success: "status-ok",
  empty: "status-empty",
  error: "status-error",
};

/* ==========================================================================
   Harita kurulumu
   ========================================================================== */

const maps = {};

// helper to calculate bounds
function getGeoJSONBounds(geojson) {
  const bounds = new maplibregl.LngLatBounds();
  let hasCoords = false;
  
  function processGeom(geometry) {
    if (!geometry) return;
    if (geometry.type === 'Point') {
      bounds.extend(geometry.coordinates);
      hasCoords = true;
    } else if (geometry.type === 'LineString' || geometry.type === 'MultiPoint') {
      geometry.coordinates.forEach(c => { bounds.extend(c); hasCoords = true; });
    } else if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString') {
      geometry.coordinates.forEach(ring => ring.forEach(c => { bounds.extend(c); hasCoords = true; }));
    } else if (geometry.type === 'MultiPolygon') {
      geometry.coordinates.forEach(poly => poly.forEach(ring => ring.forEach(c => { bounds.extend(c); hasCoords = true; })));
    } else if (geometry.type === 'GeometryCollection') {
      geometry.geometries.forEach(processGeom);
    }
  }

  if (geojson.features) {
    geojson.features.forEach(f => processGeom(f.geometry));
  } else if (geojson.geometry) {
    processGeom(geojson.geometry);
  }
  
  return hasCoords ? bounds : null;
}

for (const model of MODELS) {
  const map = new maplibregl.Map({
    container: `map-${model.key}`,
    style: {
      version: 8,
      sources: {
        "osm-tiles": {
          type: "raster",
          tiles: ["https://a.tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors"
        }
      },
      layers: [
        {
          id: "osm-layer",
          type: "raster",
          source: "osm-tiles",
          minzoom: 0,
          maxzoom: 19
        }
      ]
    },
    center: [ISTANBUL_CENTER[1], ISTANBUL_CENTER[0]], // [lng, lat]
    zoom: ISTANBUL_ZOOM - 0.5,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  map.on('load', () => {
    map._loaded = true;
    // Add dynamic source
    map.addSource(`source-${model.key}`, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });

    // Add polygon layer (with buffer/fill styling)
    map.addLayer({
      id: `layer-polygons-${model.key}`,
      type: 'fill',
      source: `source-${model.key}`,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-color': model.color,
        'fill-opacity': 0.08
      }
    });

    // Polygon border outer glow
    map.addLayer({
      id: `layer-polygons-glow-${model.key}`,
      type: 'line',
      source: `source-${model.key}`,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'line-color': model.color,
        'line-width': 10,
        'line-blur': 4,
        'line-opacity': 0.6
      }
    });

    // Polygon border inner core
    map.addLayer({
      id: `layer-polygons-core-${model.key}`,
      type: 'line',
      source: `source-${model.key}`,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'line-color': '#ffffff',
        'line-width': 2,
        'line-opacity': 0.95
      }
    });

    // Add line layer outer glow (neon tube outer part)
    map.addLayer({
      id: `layer-lines-glow-${model.key}`,
      type: 'line',
      source: `source-${model.key}`,
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: {
        'line-color': model.color,
        'line-width': 12,
        'line-blur': 4,
        'line-opacity': 0.7
      }
    });

    // Add line layer inner core (neon tube inner part)
    map.addLayer({
      id: `layer-lines-core-${model.key}`,
      type: 'line',
      source: `source-${model.key}`,
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: {
        'line-color': '#ffffff',
        'line-width': 3.5,
        'line-opacity': 1.0
      }
    });

    // Add point layer outer glow
    map.addLayer({
      id: `layer-points-glow-${model.key}`,
      type: 'circle',
      source: `source-${model.key}`,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 12, 16, 24],
        'circle-color': model.color,
        'circle-blur': 0.8,
        'circle-opacity': 0.8
      }
    });

    // Add point layer inner core
    map.addLayer({
      id: `layer-points-core-${model.key}`,
      type: 'circle',
      source: `source-${model.key}`,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 16, 9],
        'circle-color': model.color,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
        'circle-opacity': 1.0
      }
    });

    // Add click events for popups
    const layerIds = [`layer-points-core-${model.key}`, `layer-lines-core-${model.key}`, `layer-polygons-core-${model.key}`];
    layerIds.forEach(layerId => {
      map.on('click', layerId, (e) => {
        if (e.features && e.features.length > 0) {
          const feature = e.features[0];
          const props = feature.properties || {};
          const popupHtml = buildPopupHtml(props);
          if (popupHtml) {
            if (activePopups[model.key]) activePopups[model.key].remove();
            
            const popup = new maplibregl.Popup({ maxWidth: '280px' })
              .setLngLat(e.lngLat)
              .setHTML(popupHtml)
              .addTo(map);
              
            activePopups[model.key] = popup;
          }
        }
      });

      // Change cursor on hover
      map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
    });
  });

  maps[model.key] = map;
}

window.addEventListener("load", () => {
  for (const model of MODELS) {
    maps[model.key].resize();
  }

  // Sidebar navigation toggles
  const gridContainer = document.getElementById("grid-container");
  const btnViewAll = document.getElementById("btn-view-all");
  const modelSelectItems = document.querySelectorAll(".model-select-item");

  const btnLiveComp = document.getElementById("btn-view-live-comparison");
  const btnBenchmark = document.getElementById("btn-view-benchmark");
  const liveCompView = document.getElementById("live-comparison-view");
  const benchmarkView = document.getElementById("benchmark-analysis-view");

  const topbar = document.querySelector(".topbar-modern");

  function clearActiveNav() {
    btnViewAll.classList.remove("active");
    btnLiveComp.classList.remove("active");
    if (btnBenchmark) btnBenchmark.classList.remove("active");
    modelSelectItems.forEach(item => item.classList.remove("active"));
  }

  function hideAllViews() {
    gridContainer.classList.add("hidden");
    liveCompView.classList.add("hidden");
    benchmarkView.classList.add("hidden");
    if (topbar) topbar.style.display = "";
  }

  btnViewAll.addEventListener("click", (e) => {
    e.preventDefault();
    clearActiveNav();
    hideAllViews();
    btnViewAll.classList.add("active");
    gridContainer.classList.remove("hidden");
    gridContainer.classList.remove("single-view");
    
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active-single"));
    
    setTimeout(() => {
      for (const m of MODELS) {
        maps[m.key].resize();
      }
    }, 150);
  });

  modelSelectItems.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      clearActiveNav();
      hideAllViews();
      item.classList.add("active");
      
      const key = item.dataset.modelKey;
      gridContainer.classList.remove("hidden");
      gridContainer.classList.add("single-view");
      
      document.querySelectorAll(".panel").forEach(p => {
        if (p.dataset.model === key) {
          p.classList.add("active-single");
        } else {
          p.classList.remove("active-single");
        }
      });
      
      setTimeout(() => {
        if (maps[key]) maps[key].resize();
      }, 150);
    });
  });

  btnLiveComp.addEventListener("click", (e) => {
    e.preventDefault();
    clearActiveNav();
    hideAllViews();
    btnLiveComp.classList.add("active");
    liveCompView.classList.remove("hidden");

    if (lastAPIResults) {
      const rows = MODELS.map((m) => {
        const r = lastAPIResults[m.key] || {};
        return {
          key: m.key,
          name: m.name,
          color: m.color,
          latency: r.processing_time_ms,
          cost: r.usage ? r.usage.estimated_cost_usd : 0,
          tokens: r.usage ? r.usage.total_tokens : 0,
          featureCount: r.feature_count || 0
        };
      });
      setTimeout(() => updateLiveCharts(rows), 100);
    }
  });

  if (btnBenchmark) {
    btnBenchmark.addEventListener("click", (e) => {
      e.preventDefault();
      clearActiveNav();
      hideAllViews();
      if (topbar) topbar.style.display = "none";
      benchmarkView.classList.remove("hidden");

      fetch("/api/benchmark", { method: "GET" })
        .then(res => res.json())
        .then(data => {
          if (data && data.dashboard && Object.keys(data.dashboard).length > 0) {
            safeSetLocalStorage("bx_last_result", JSON.stringify(data));
            populateSidebarBenchmark(data);
            renderBenchmarkAnalysis(data);
          }
        }).catch(() => {
          const cached = localStorage.getItem("bx_last_result");
          if (cached) {
            try {
              const parsed = JSON.parse(cached);
              renderBenchmarkAnalysis(parsed);
            } catch(err) {}
          }
        });
    });
  }

  // Click on Benchmark Scores accordion summary also opens benchmark view
  const accBenchScores = document.getElementById("acc-bench-scores");
  if (accBenchScores) {
    accBenchScores.querySelector("summary").addEventListener("click", () => {
      clearActiveNav();
      hideAllViews();
      if (topbar) topbar.style.display = "none";
      benchmarkView.classList.remove("hidden");

      fetch("/api/benchmark", { method: "GET" })
        .then(res => res.json())
        .then(data => {
          if (data && data.dashboard && Object.keys(data.dashboard).length > 0) {
            safeSetLocalStorage("bx_last_result", JSON.stringify(data));
            populateSidebarBenchmark(data);
            renderBenchmarkAnalysis(data);
          }
        }).catch(() => {
          const cached = localStorage.getItem("bx_last_result");
          if (cached) {
            try {
              const parsed = JSON.parse(cached);
              renderBenchmarkAnalysis(parsed);
            } catch(err) {}
          }
        });
    });
  }

  // Load benchmark scores into sidebar
  console.log("[GIS Console] Initiating GET /api/benchmark...");
  fetch("/api/benchmark", { method: "GET" })
    .then(res => {
      console.log("[GIS Console] GET status:", res.status);
      return res.json();
    })
    .then(data => {
      console.log("[GIS Console] GET response parsed:", data);
      if (data && data.dashboard && Object.keys(data.dashboard).length > 0) {
        console.log("[GIS Console] Dashboard keys found:", Object.keys(data.dashboard));
        safeSetLocalStorage("bx_last_result", JSON.stringify(data));
        populateSidebarBenchmark(data);
      } else {
        console.warn("[GIS Console] Dashboard key not found or empty in GET response");
        const scoresEl = document.getElementById("sidebar-benchmark-scores");
        if (scoresEl) scoresEl.innerHTML = '<div style="color:var(--text-faint)">Önbellekte benchmark verisi yok. Testi çalıştırın.</div>';
      }
    }).catch((err) => {
      console.error("[GIS Console] GET /api/benchmark failed:", err);
      const cached = localStorage.getItem("bx_last_result");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          console.log("[GIS Console] Found cache, loading sidebar benchmark score");
          populateSidebarBenchmark(parsed);
          return;
        } catch(err) {}
      }
      const scoresEl = document.getElementById("sidebar-benchmark-scores");
      if (scoresEl) scoresEl.innerHTML = '<div style="color:var(--text-faint)">Benchmark yüklenemedi.</div>';
    });

  // Benchmark Yeniden Calistirma Butonlari
  const btnSidebarRunBench = document.getElementById("btn-sidebar-run-bench");
  const btnRunBenchmarkSuite = document.getElementById("btn-run-benchmark-suite");

  async function triggerBenchmarkExecution() {
    const originalSidebarText = btnSidebarRunBench ? btnSidebarRunBench.innerHTML : "";
    const originalSuiteText = btnRunBenchmarkSuite ? btnRunBenchmarkSuite.innerHTML : "";
    
    if (btnSidebarRunBench) {
      btnSidebarRunBench.disabled = true;
      btnSidebarRunBench.innerHTML = "<span>⏳</span> Test Ediliyor...";
    }
    if (btnRunBenchmarkSuite) {
      btnRunBenchmarkSuite.disabled = true;
      btnRunBenchmarkSuite.innerHTML = "<span>⏳</span> Test Ediliyor...";
    }
    if (benchmarkView) {
      benchmarkView.classList.add("loading-state");
    }
    
    const container = document.getElementById("sidebar-benchmark-scores");
    if (container) {
      container.innerHTML = '<div class="score-loading" style="font-size:11.5px;color:var(--text-faint)">🔄 10 test senaryosu çalıştırılıyor (yaklaşık 1 dakika)...</div>';
    }

    try {
      const response = await fetch("/api/benchmark", { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      
      if (data && data.error) {
        alert(data.error);
        const cached = localStorage.getItem("bx_last_result");
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            populateSidebarBenchmark(parsed);
            renderBenchmarkAnalysis(parsed);
          } catch(e) {}
        }
        return;
      }
      
      if (data && data.dashboard) {
        safeSetLocalStorage("bx_last_result", JSON.stringify(data));
        populateSidebarBenchmark(data);
        renderBenchmarkAnalysis(data);
        // Toplu test bittiği an ilk senaryoyu (Zeytinburnu buffer) haritalara otomatik doldur
        const firstQuery = data.dashboard[MODELS[0].key]?.details?.[0]?.query;
        if (firstQuery) {
          loadScenarioToMainGrid(firstQuery, data);
        }
      } else {
        throw new Error("Geçersiz veri formatı.");
      }
    } catch (err) {
      console.error("Benchmark çalıştırma hatası:", err);
      if (container) {
        container.innerHTML = `<div style="color:var(--status-error);font-size:11.5px;">Hata: ${err.message}</div>`;
      }
    } finally {
      if (btnSidebarRunBench) {
        btnSidebarRunBench.disabled = false;
        btnSidebarRunBench.innerHTML = originalSidebarText;
      }
      if (btnRunBenchmarkSuite) {
        btnRunBenchmarkSuite.disabled = false;
        btnRunBenchmarkSuite.innerHTML = originalSuiteText;
      }
      if (benchmarkView) {
        benchmarkView.classList.remove("loading-state");
      }
    }
  }

  if (btnSidebarRunBench) {
    btnSidebarRunBench.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      triggerBenchmarkExecution();
    });
  }
  if (btnRunBenchmarkSuite) {
    btnRunBenchmarkSuite.addEventListener("click", (e) => {
      e.preventDefault();
      triggerBenchmarkExecution();
    });
  }

  // Tekli Model Testi tetikleyicisi
  const btnRunSingleBench = document.getElementById("btn-run-single-bench");
  const inputSingleModel = document.getElementById("input-single-model");

  async function runSingleModelBenchmark(modelKey, buttonElement) {
    if (!modelKey) return;
    
    const mName = (MODELS.find(m => m.key === modelKey) || {}).name || modelKey;
    const originalBtnText = buttonElement.innerHTML;
    buttonElement.style.pointerEvents = "none";
    buttonElement.innerHTML = "⏳...";

    try {
      const response = await fetch(`/api/benchmark/${modelKey}`, { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      if (data && data.error) {
        alert(data.error);
        return;
      }

      if (data && data.dashboard && data.dashboard[modelKey]) {
        // Mevcut sonuçları localStorage'dan al
        let cached = localStorage.getItem("bx_last_result");
        let mergedData = {};
        if (cached) {
          try {
            mergedData = JSON.parse(cached);
          } catch(e) {
            mergedData = {};
          }
        }
        
        if (!mergedData.dashboard) {
          mergedData.dashboard = {};
        }
        
        // Yeni tekli model sonucunu eskisinin üzerine yaz (Merge)
        mergedData.dashboard[modelKey] = data.dashboard[modelKey];
        mergedData.generated_at = new Date().toISOString();
        mergedData.test_case_count = data.test_case_count || 10;
        
        // Güncel veriyi kaydet
        safeSetLocalStorage("bx_last_result", JSON.stringify(mergedData));
        
        // Sol menü skorlarını ve ana grafik/tabloları yenile
        populateSidebarBenchmark(mergedData);
        renderBenchmarkAnalysis(mergedData);
        
        alert(`${mName} başarıyla test edildi! Sonuçları genel tabloya eklendi ve sıralama güncellendi.`);
      } else {
        throw new Error("Sunucudan geçersiz veri döndü.");
      }
    } catch (err) {
      console.error("Tekli benchmark çalıştırma hatası:", err);
      alert(`Model testi başarısız oldu: ${err.message}`);
    } finally {
      buttonElement.style.pointerEvents = "";
      buttonElement.innerHTML = originalBtnText;
    }
  }

  async function triggerSingleBenchmark() {
    const rawVal = inputSingleModel ? inputSingleModel.value.trim().toLowerCase() : "";
    if (!rawVal) {
      alert("Lütfen bir model adı girin (gpt, claude, deepseek, gemini, groq, glm, qwen).");
      return;
    }
    
    // Model anahtarına eşle
    let modelKey = "";
    if (rawVal.includes("gpt")) modelKey = "gpt";
    else if (rawVal.includes("claude") || rawVal.includes("sonnet")) modelKey = "claude";
    else if (rawVal.includes("deepseek")) modelKey = "deepseek";
    else if (rawVal.includes("gemini")) modelKey = "gemini";
    else if (rawVal.includes("groq") || rawVal.includes("llama")) modelKey = "groq";
    else if (rawVal.includes("glm")) modelKey = "glm";
    else if (rawVal.includes("qwen")) modelKey = "qwen";
    
    if (!modelKey) {
      alert("Geçersiz model adı. Lütfen listedeki anahtarlardan birini girin (gpt, claude, deepseek, gemini, groq, glm, qwen).");
      return;
    }

    await runSingleModelBenchmark(modelKey, btnRunSingleBench);
  }

  if (btnRunSingleBench) {
    btnRunSingleBench.addEventListener("click", (e) => {
      e.preventDefault();
      triggerSingleBenchmark();
    });
  }

  // Sidebar test butonlarını bağla
  const btnSidebarTestModels = document.querySelectorAll(".btn-sidebar-test-model");
  btnSidebarTestModels.forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation(); // Parent link tıklamasını engelle
      const modelKey = btn.dataset.model;
      if (modelKey) {
        await runSingleModelBenchmark(modelKey, btn);
      }
    });
  });
});

function populateSidebarBenchmark(data) {
  const container = document.getElementById("sidebar-benchmark-scores");
  if (!container || !data || !data.dashboard) return;
  
  let html = "";
  const sortedModels = MODELS.map(m => {
    const d = data.dashboard[m.key] || {};
    const overall = Math.round(((d.tool_accuracy || 0) + (d.spatial_accuracy || 0) + (d.param_accuracy || 0) + (d.schema_validity || 0)) / 4);
    return { ...m, overall, details: d };
  }).sort((a, b) => b.overall - a.overall);

  for (const m of sortedModels) {
    const d = m.details;
    html += `
      <div class="mini-score-card">
        <div class="mini-score-header">
          <span class="mini-score-model-name"><span class="model-dot" style="background:${m.color}"></span>${m.name}</span>
          <span class="mini-score-value" style="color:${m.color}">%${m.overall}</span>
        </div>
        <div class="mini-score-bars">
          <div class="mini-score-bar-row">
            <span>Araç: %${d.tool_accuracy || 0}</span>
            <div class="mini-score-bar-bg"><div class="mini-score-bar-fill" style="width:${d.tool_accuracy || 0}%; background:${m.color}"></div></div>
          </div>
          <div class="mini-score-bar-row">
            <span>Konum: %${d.spatial_accuracy || 0}</span>
            <div class="mini-score-bar-bg"><div class="mini-score-bar-fill" style="width:${d.spatial_accuracy || 0}%; background:${m.color}"></div></div>
          </div>
        </div>
      </div>
    `;
  }
  container.innerHTML = html;
}

/* ==========================================================================
   Analiz akışı (mor buton)
   ========================================================================== */

const form = document.getElementById("query-form");
const input = document.getElementById("query-input");
const runBtn = document.getElementById("run-btn");

document.querySelectorAll(".example-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    input.value = chip.dataset.example;
    input.focus();
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;

  setRunning(true);
  for (const model of MODELS) {
    setPanelState(model.key, {
      status: "running",
      time: "",
      tokens: "",
      tool: "—",
      explanation: "Analiz yapılıyor…",
      count: "",
      sql: "",
      table: [],
    });
    if (activePopups[model.key]) activePopups[model.key].remove();
    const map = maps[model.key];
    if (map) {
      const src = map.getSource(`source-${model.key}`);
      if (src) src.setData({ type: "FeatureCollection", features: [] });
    }
  }

  const resultsCombined = {};
  
  const promises = MODELS.map(async (model, index) => {
    // Sunucu taraflı çakışmayı önlemek için her modele küçük bir gecikme veriyoruz (0.4 sn stagger)
    await new Promise(resolve => setTimeout(resolve, index * 400));
    
    try {
      const response = await fetch(`/api/analyze/${model.key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      resultsCombined[model.key] = data;
      renderResult(model.key, data);
      
      // Her model tamamlandıkça grafikleri ve tabloları anlık olarak kısmi verilerle güncelliyoruz (Eş zamanlı hissetmesi için)
      renderComparison(resultsCombined, message);
      
    } catch (error) {
      const errObj = {
        model: model.key,
        status: "error",
        error: error.message,
        geojson: { type: "FeatureCollection", features: [] },
        attribute_table: []
      };
      resultsCombined[model.key] = errObj;
      renderResult(model.key, errObj);
      renderComparison(resultsCombined, message);
    }
  });

  try {
    await Promise.all(promises);
    lastAPIResults = resultsCombined;
  } catch (error) {
    console.error("Analiz akışı genel hata:", error);
  } finally {
    setRunning(false);
    // Konsoldaki analiz çalıştıktan sonra benchmark sonuçlarını sessizce güncelle
    fetch("/api/benchmark", { method: "GET" })
      .then(res => res.json())
      .then(data => {
        if (data && data.dashboard && Object.keys(data.dashboard).length > 0) {
          safeSetLocalStorage("bx_last_result", JSON.stringify(data));
          populateSidebarBenchmark(data);
        }
      }).catch(() => {});
  }
});

function setRunning(isRunning) {
  runBtn.disabled = isRunning;
  runBtn.classList.toggle("is-running", isRunning);
  runBtn.querySelector(".run-btn-label").textContent = isRunning ? "Çalışıyor" : "Analiz Et";
}

/* ==========================================================================
   Sonuçların haritaya ve panele işlenmesi
   ========================================================================== */

function renderResult(key, result) {
  if (activePopups[key]) {
    activePopups[key].remove();
  }

  if (!result) {
    setPanelState(key, { status: "error", explanation: "Bu model için yanıt alınamadı." });
    return;
  }

  if (result.status === "error") {
    setPanelState(key, {
      status: "error",
      explanation: result.error || "Bilinmeyen bir hata oluştu.",
      tool: "—",
      count: "",
      sql: "",
      table: [],
    });
    return;
  }

  const geojson = result.geojson || { type: "FeatureCollection", features: [] };
  lastGeoJSONs[key] = geojson;

  const map = maps[key];
  if (map) {
    const renderData = () => {
      const src = map.getSource(`source-${key}`);
      if (src) {
        src.setData(geojson);
        
        const bounds = getGeoJSONBounds(geojson);
        if (bounds) {
          map.fitBounds(bounds, { padding: 40, maxZoom: 16 });
        }
      }
    };
    
    if (map._loaded) {
      renderData();
    } else {
      map.once('load', renderData);
    }
  }

  const featureCount = geojson.features ? geojson.features.length : 0;

  const timeLabel =
    typeof result.processing_time_ms === "number"
      ? `${(result.processing_time_ms / 1000).toFixed(2)} s`
      : "";

  const usage = result.usage || null;
  const tokenLabel = usage
    ? `${usage.total_tokens} tok · $${usage.estimated_cost_usd.toFixed(4)}`
    : "";

  setPanelState(key, {
    status: result.status === "empty" ? "empty" : "success",
    time: timeLabel,
    tokens: tokenLabel,
    tool: result.selected_tool || "—",
    explanation: result.explanation || "(açıklama dönmedi)",
    count: featureCount > 0 ? `${featureCount} nesne` : "",
    sql: result.sql_equivalent ? `SQL: ${result.sql_equivalent}` : "",
    table: result.attribute_table || [],
  });
}

function buildPopupHtml(props) {
  if (!props || Object.keys(props).length === 0) return null;
  const hidden = new Set(["osm_id", "role"]);
  const rows = Object.entries(props)
    .filter(([k]) => !hidden.has(k))
    .slice(0, 12)
    .map(
      ([k, v]) =>
        `<tr><td class="popup-key">${escapeHtml(k)}</td><td class="popup-val">${escapeHtml(
          v === null || v === undefined ? "" : String(v)
        )}</td></tr>`
    )
    .join("");
  return `<table class="popup-table">${rows}</table>`;
}

/* ==========================================================================
   Panel durumunu güncelleme
   ========================================================================== */

function setPanelState(key, state) {
  const panel = document.querySelector(`.panel[data-model="${key}"]`);
  if (!panel) return;

  if (state.status !== undefined) {
    const statusEl = panel.querySelector('[data-field="status"]');
    statusEl.textContent = STATUS_LABELS[state.status] || state.status;
    statusEl.className = "panel-status " + (STATUS_CLASS[state.status] || "");
  }

  if (state.time !== undefined) {
    panel.querySelector('[data-field="time"]').textContent = state.time;
  }

  if (state.tokens !== undefined) {
    const tokensEl = panel.querySelector('[data-field="tokens"]');
    if (tokensEl) tokensEl.textContent = state.tokens;
  }

  if (state.tool !== undefined) {
    panel.querySelector('[data-field="tool"]').textContent = state.tool;
  }

  if (state.explanation !== undefined) {
    panel.querySelector('[data-field="explanation"]').textContent = state.explanation;
  }

  if (state.count !== undefined) {
    panel.querySelector('[data-field="count"]').textContent = state.count;
  }

  if (state.sql !== undefined) {
    panel.querySelector('[data-field="sql"]').textContent = state.sql;
  }

  if (state.table !== undefined) {
    const tableEl = panel.querySelector('[data-field="table"]');
    renderAttributeTable(tableEl, state.table, key);

    // AttributeTable veya AttributeQuery seçildiyse ve veri varsa otomatik aç
    const detailsEl = panel.querySelector('.attr-table-wrap');
    if (detailsEl) {
      const toolText = state.tool || panel.querySelector('[data-field="tool"]').textContent;
      if ((toolText === "AttributeTable" || toolText === "AttributeQuery") && state.table && state.table.length > 0) {
        detailsEl.open = true;
      }
    }
  }
}

function renderAttributeTable(tableEl, rows, modelKey) {
  const thead = tableEl.querySelector("thead");
  const tbody = tableEl.querySelector("tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";

  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td class="empty-cell">Veri yok</td></tr>';
    return;
  }

  const HIDDEN_COLUMNS = new Set(["osm_id", "role"]);
  const columns = Object.keys(rows[0])
    .filter((col) => !HIDDEN_COLUMNS.has(col))
    .slice(0, 6);

  thead.innerHTML = `<tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr>`;

  const visibleRows = rows.slice(0, 50);

  tbody.innerHTML = visibleRows
    .map((row, idx) => {
      const cells = columns
        .map(
          (c) =>
            `<td>${escapeHtml(
              row[c] !== undefined && row[c] !== null ? String(row[c]) : ""
            )}</td>`
        )
        .join("");
      return `<tr data-row-idx="${idx}" class="clickable-row" title="Haritada göster">${cells}</tr>`;
    })
    .join("");

  tbody.querySelectorAll("tr.clickable-row").forEach((tr) => {
    tr.addEventListener("click", () => {
      const idx = parseInt(tr.dataset.rowIdx, 10);
      const row = visibleRows[idx];
      zoomToFeatureByAttributes(modelKey, row, tr);
    });
  });
}

function zoomToFeatureByAttributes(modelKey, row, trEl) {
  const geojson = lastGeoJSONs[modelKey];
  if (!geojson || !geojson.features || geojson.features.length === 0) return;

  const lookupKey = row.name || row.from || row.to || row.sequence;
  let matchedFeature = null;

  if (lookupKey !== undefined) {
    matchedFeature = geojson.features.find((f) => {
      const p = f.properties || {};
      return (
        p.name === lookupKey ||
        p.from === lookupKey ||
        p.to === lookupKey ||
        p.sequence === lookupKey
      );
    });
  }

  if (!matchedFeature) {
    const idx = parseInt(trEl.dataset.rowIdx, 10);
    matchedFeature = geojson.features[idx];
  }

  if (!matchedFeature || !matchedFeature.geometry) return;

  const map = maps[modelKey];
  if (!map) return;

  const bounds = getGeoJSONBounds(matchedFeature);
  if (bounds) {
    map.fitBounds(bounds, { padding: 50, maxZoom: 17 });
  }

  let popupLngLat = null;
  const geom = matchedFeature.geometry;
  if (geom.type === 'Point') {
    popupLngLat = geom.coordinates;
  } else if (geom.type === 'LineString') {
    popupLngLat = geom.coordinates[Math.floor(geom.coordinates.length / 2)];
  } else if (geom.type === 'Polygon') {
    popupLngLat = geom.coordinates[0][0];
  }

  if (popupLngLat) {
    const props = matchedFeature.properties || {};
    const popupHtml = buildPopupHtml(props);
    if (popupHtml) {
      if (activePopups[modelKey]) activePopups[modelKey].remove();
      const popup = new maplibregl.Popup({ maxWidth: '280px' })
        .setLngLat(popupLngLat)
        .setHTML(popupHtml)
        .addTo(map);
      activePopups[modelKey] = popup;
    }
  }

  trEl.parentElement.querySelectorAll("tr.is-selected").forEach((t) => t.classList.remove("is-selected"));
  trEl.classList.add("is-selected");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ==========================================================================
   Canlı Model Karşılaştırma (her sorguda otomatik dolar)
   ========================================================================== */

const comparisonWrap = document.getElementById("sidebar-live-comparison");

function renderComparison(data, userQuery) {
  if (!data || typeof data !== "object") {
    if (comparisonWrap) {
      comparisonWrap.innerHTML = '<p class="dashboard-empty">Veri alınamadı.</p>';
    }
    const mainTableEl = document.getElementById("main-live-comparison-table");
    if (mainTableEl) {
      mainTableEl.innerHTML = '<p class="dashboard-empty">Veri alınamadı.</p>';
    }
    return;
  }

  const rows = MODELS.map((m) => {
    const r = data[m.key] || {};
    const isErr = r.status === "error";
    const isEmpty = r.status === "empty";
    return {
      key: m.key,
      name: m.name,
      color: m.color,
      tool: r.selected_tool || "—",
      latency: r.processing_time_ms,
      tokens: r.usage ? r.usage.total_tokens : null,
      cost: r.usage ? r.usage.estimated_cost_usd : null,
      featureCount: r.feature_count || 0,
      isErr,
      isEmpty,
    };
  });

  const okRows = rows.filter((r) => !r.isErr);
  const fastest = okRows.reduce(
    (best, r) => (r.latency != null && (best == null || r.latency < best.latency) ? r : best),
    null
  );
  const cheapest = okRows.reduce(
    (best, r) => (r.cost != null && (best == null || r.cost < best.cost) ? r : best),
    null
  );

  const tableRows = rows
    .map((r) => {
      const latencyTxt = r.latency != null ? `${(r.latency / 1000).toFixed(2)} s` : "—";
      const tokenTxt = r.tokens != null ? r.tokens : "—";
      const costTxt = r.cost != null ? `$${r.cost.toFixed(4)}` : "—";
      let statusBadge;
      if (r.isErr) statusBadge = '<span class="cmp-badge cmp-err">Hata</span>';
      else if (r.isEmpty) statusBadge = '<span class="cmp-badge cmp-empty">Boş</span>';
      else statusBadge = '<span class="cmp-badge cmp-ok">✓</span>';

      const fastestBadge = fastest && fastest.key === r.key ? ' <span class="cmp-tag">⚡ Hız</span>' : "";
      const cheapestBadge = cheapest && cheapest.key === r.key ? ' <span class="cmp-tag">💰 Ucuz</span>' : "";

      return `
        <tr>
          <td><span class="cmp-dot" style="background:${r.color}"></span>${escapeHtml(r.name)}${fastestBadge}${cheapestBadge}</td>
          <td>${statusBadge}</td>
          <td>${escapeHtml(r.tool)}</td>
          <td>${r.featureCount}</td>
          <td>${latencyTxt}</td>
          <td>${tokenTxt}</td>
          <td>${costTxt}</td>
        </tr>
      `;
    })
    .join("");

  const tableHtml = `
    <div class="cmp-query-label">Sorgu: <span>${escapeHtml(userQuery)}</span></div>
    <div class="cmp-table-scroll">
      <table class="cmp-table">
        <thead>
          <tr><th>Model</th><th>Durum</th><th>Araç</th><th>#</th><th>Süre</th><th>Token</th><th>Maliyet</th></tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div class="cmp-footnote">⚡ = en hızlı   ·   💰 = en ucuz   ·   # = bulunan nesne sayısı</div>
  `;

  if (comparisonWrap) {
    comparisonWrap.innerHTML = tableHtml;
  }

  const mainTableEl = document.getElementById("main-live-comparison-table");
  if (mainTableEl) {
    mainTableEl.innerHTML = tableHtml;
  }

  // Update Charts
  updateLiveCharts(rows);

  // Update Sidebar Live Stats Accordions
  populateSidebarLiveStats(rows);
}

/* ==========================================================================
   CHARTS YARDIMCI FONKSİYONLARI (CHART.JS)
   ========================================================================== */

let liveChartInstances = {};

// Chart.js global font style
if (window.Chart) {
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = "#475569";
}

const COMMON_SCALES = {
  x: {
    grid: { color: '#f1f5f9' },
    ticks: { color: '#64748b' }
  },
  y: {
    grid: { color: '#f1f5f9' },
    ticks: { color: '#64748b' },
    beginAtZero: true
  }
};

const COMMON_PLUGINS = {
  legend: { display: false },
  tooltip: {
    backgroundColor: '#0f172a',
    padding: 12,
    titleColor: '#ffffff',
    titleFont: { size: 12, weight: 'bold' },
    bodyColor: '#cbd5e1',
    bodyFont: { size: 12 },
    cornerRadius: 8,
    boxPadding: 4
  }
};

function updateLiveCharts(rows) {
  const labels = rows.map(r => r.name);
  const colors = rows.map(r => r.color);

  // Latency Chart
  if (liveChartInstances.latency) liveChartInstances.latency.destroy();
  const ctxLatency = document.getElementById("chart-live-latency")?.getContext("2d");
  if (ctxLatency) {
    liveChartInstances.latency = new Chart(ctxLatency, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Süre (Saniye)",
          data: rows.map(r => r.latency != null ? r.latency / 1000 : 0),
          backgroundColor: colors.map(c => c + "cc"),
          borderColor: colors,
          borderWidth: 1.5,
          borderRadius: 8,
          maxBarThickness: 28
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: COMMON_PLUGINS,
        scales: COMMON_SCALES
      }
    });
  }

  // Cost Chart using History
  const totalCost = rows.reduce((sum, r) => sum + (r.cost || 0), 0);
  const totalCostEl = document.getElementById("live-cost-total-val");
  if (totalCostEl) {
    totalCostEl.textContent = `$${totalCost.toFixed(4)}`;
  }

  const categoriesEl = document.getElementById("live-cost-categories");
  if (categoriesEl) {
    categoriesEl.innerHTML = rows.map(r => {
      const val = r.cost != null ? `$${r.cost.toFixed(4)}` : "$0.0000";
      return `
        <div class="cost-cat-item">
          <span class="cost-cat-dot" style="background:${r.color}"></span>
          <span class="cost-cat-name">${r.name}</span>
          <span class="cost-cat-val">${val}</span>
        </div>
      `;
    }).join("");
  }

  // Load history from localStorage
  let costHistory = [];
  try {
    const cachedHist = localStorage.getItem("query_cost_history");
    if (cachedHist) costHistory = JSON.parse(cachedHist);
  } catch(e) {}

  // If empty, populate mock initial history so it looks nice immediately
  if (costHistory.length === 0) {
    costHistory = [
      {
        query: "Eczane Bul & Buffer",
        costs: { claude: 0.0035, gpt: 0.0062, groq: 0.0005, gemini: 0.0021, deepseek: 0.0011, qwen: 0.0018, glm: 0.0008 }
      },
      {
        query: "Hastane Rota Analizi",
        costs: { claude: 0.0041, gpt: 0.0075, groq: 0.0007, gemini: 0.0028, deepseek: 0.0015, qwen: 0.0022, glm: 0.0010 }
      },
      {
        query: "Park Tampon Bölgeleri",
        costs: { claude: 0.0032, gpt: 0.0058, groq: 0.0004, gemini: 0.0019, deepseek: 0.0009, qwen: 0.0016, glm: 0.0007 }
      },
    ];
  }

  // Check if we need to add the current run.
  const currentQuery = document.getElementById("query-input")?.value?.trim() || "Canlı Sorgu";
  
  if (window.lastProcessedQueryForCharts !== currentQuery && totalCost > 0) {
    window.lastProcessedQueryForCharts = currentQuery;
    
    // Add current run
    const currentCosts = {};
    rows.forEach(r => {
      currentCosts[r.key] = r.cost || 0;
    });
    costHistory.push({ query: currentQuery, costs: currentCosts });
    
    // Keep max 6 items
    if (costHistory.length > 6) costHistory.shift();
    localStorage.setItem("query_cost_history", JSON.stringify(costHistory));
  }

  if (liveChartInstances.cost) liveChartInstances.cost.destroy();
  const ctxCost = document.getElementById("chart-live-cost")?.getContext("2d");
  if (ctxCost) {
    const xLabels = costHistory.map(h => h.query.length > 20 ? h.query.substring(0, 18) + "..." : h.query);
    
    const datasets = MODELS.map(m => {
      return {
        label: m.name,
        data: costHistory.map(h => h.costs[m.key] || 0),
        borderColor: m.color,
        backgroundColor: m.color + "10",
        borderWidth: 2.5,
        tension: 0.35,
        fill: true,
        pointBackgroundColor: "#ffffff",
        pointBorderColor: m.color,
        pointBorderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6,
      };
    });

    liveChartInstances.cost = new Chart(ctxCost, {
      type: "line",
      data: {
        labels: xLabels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0f172a',
            padding: 12,
            titleColor: '#ffffff',
            titleFont: { size: 12, weight: 'bold' },
            bodyColor: '#cbd5e1',
            bodyFont: { size: 12 },
            cornerRadius: 8,
            boxPadding: 4,
            callbacks: {
              label: function(context) {
                return ` ${context.dataset.label}: $${context.raw.toFixed(4)}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: '#f1f5f9' },
            ticks: { color: '#64748b' }
          },
          y: {
            grid: { color: '#f1f5f9' },
            ticks: {
              color: '#64748b',
              callback: function(value) {
                return "$" + value.toFixed(4);
              }
            },
            beginAtZero: true
          }
        }
      }
    });
  }

  // Tokens Chart
  if (liveChartInstances.tokens) liveChartInstances.tokens.destroy();
  const ctxTokens = document.getElementById("chart-live-tokens")?.getContext("2d");
  if (ctxTokens) {
    liveChartInstances.tokens = new Chart(ctxTokens, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Toplam Token",
          data: rows.map(r => r.tokens || 0),
          backgroundColor: colors.map(c => c + "cc"),
          borderColor: colors,
          borderWidth: 1.5,
          borderRadius: 8,
          maxBarThickness: 28
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: COMMON_PLUGINS,
        scales: COMMON_SCALES
      }
    });
  }

  // Features Chart
  if (liveChartInstances.features) liveChartInstances.features.destroy();
  const ctxFeatures = document.getElementById("chart-live-features")?.getContext("2d");
  if (ctxFeatures) {
    liveChartInstances.features = new Chart(ctxFeatures, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Nesne Sayısı",
          data: rows.map(r => r.featureCount || 0),
          backgroundColor: colors.map(c => c + "cc"),
          borderColor: colors,
          borderWidth: 1.5,
          borderRadius: 8,
          maxBarThickness: 28
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: COMMON_PLUGINS,
        scales: COMMON_SCALES
      }
    });
  }
}

let benchChartInstances = {};

function renderBenchmarkAnalysis(data) {
  const dashboard = data.dashboard;
  const sortedModels = MODELS.map(m => {
    const d = dashboard[m.key] || {};
    const overall = Math.round(((d.tool_accuracy || 0) + (d.spatial_accuracy || 0) + (d.param_accuracy || 0) + (d.schema_validity || 0)) / 4);
    return { ...m, overall, data: d };
  }).sort((a, b) => b.overall - a.overall);

  // Compute KPI values
  const bestToolModel = [...sortedModels].sort((a, b) => (b.data.tool_accuracy || 0) - (a.data.tool_accuracy || 0))[0];
  const bestSpatialModel = [...sortedModels].sort((a, b) => (b.data.spatial_accuracy || 0) - (a.data.spatial_accuracy || 0))[0];
  const fastestModel = [...sortedModels].sort((a, b) => (a.data.avg_latency_ms || Infinity) - (b.data.avg_latency_ms || Infinity))[0];
  const avgSchemaVal = Math.round(sortedModels.reduce((acc, m) => acc + (m.data.schema_validity || 0), 0) / sortedModels.length);

  // Populate KPIs in UI
  const toolKpi = document.getElementById("kpi-best-tool");
  if (toolKpi) {
    toolKpi.querySelector(".kpi-value").textContent = `%${bestToolModel.data.tool_accuracy || 0}`;
    toolKpi.querySelector(".kpi-trend").innerHTML = `<span class="model-dot" style="background:${bestToolModel.color}"></span> ${bestToolModel.name}`;
  }

  const spatialKpi = document.getElementById("kpi-best-spatial");
  if (spatialKpi) {
    spatialKpi.querySelector(".kpi-value").textContent = `%${bestSpatialModel.data.spatial_accuracy || 0}`;
    spatialKpi.querySelector(".kpi-trend").innerHTML = `<span class="model-dot" style="background:${bestSpatialModel.color}"></span> ${bestSpatialModel.name}`;
  }

  const latencyKpi = document.getElementById("kpi-lowest-latency");
  if (latencyKpi) {
    const latSec = fastestModel.data.avg_latency_ms ? (fastestModel.data.avg_latency_ms / 1000).toFixed(2) + " s" : "—";
    latencyKpi.querySelector(".kpi-value").textContent = latSec;
    latencyKpi.querySelector(".kpi-trend").innerHTML = `<span class="model-dot" style="background:${fastestModel.color}"></span> ${fastestModel.name}`;
  }

  const schemaKpi = document.getElementById("kpi-valid-schema");
  if (schemaKpi) {
    schemaKpi.querySelector(".kpi-value").textContent = `%${avgSchemaVal}`;
    schemaKpi.querySelector(".kpi-trend").textContent = "Tüm modeller ortalaması";
  }

  const labels = sortedModels.map(m => m.name);
  const colors = sortedModels.map(m => m.color);

  // Overall Chart (Pie / Doughnut Chart for Overall Performance)
  if (benchChartInstances.bar) benchChartInstances.bar.destroy();
  const ctxBar = document.getElementById("chart-bench-bar")?.getContext("2d");
  if (ctxBar) {
    benchChartInstances.bar = new Chart(ctxBar, {
      type: "doughnut",
      data: {
        labels: sortedModels.map(m => m.name),
        datasets: [{
          data: sortedModels.map(m => m.overall),
          backgroundColor: sortedModels.map(m => m.color),
          borderWidth: 2,
          borderColor: "#ffffff",
          hoverOffset: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "60%",
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0f172a',
            padding: 12,
            titleColor: '#ffffff',
            titleFont: { size: 12, weight: 'bold' },
            bodyColor: '#cbd5e1',
            bodyFont: { size: 12 },
            cornerRadius: 8,
            boxPadding: 4,
            callbacks: {
              label: function(context) {
                return ` ${context.label}: %${context.raw}`;
              }
            }
          }
        }
      }
    });
  }

  // Populate Ranking Panel (🥇, 🥈, 🥉)
  const rankingPanel = document.getElementById("ranking-panel");
  if (rankingPanel) {
    rankingPanel.innerHTML = sortedModels.map((m, index) => {
      const rank = index + 1;
      let badge = `${rank}.`;
      let rankClass = "ranking-item";
      if (rank === 1) {
        badge = "🏆 🥇";
        rankClass = "ranking-item rank-1";
      } else if (rank === 2) {
        badge = "🥈";
        rankClass = "ranking-item rank-2";
      } else if (rank === 3) {
        badge = "🥉";
        rankClass = "ranking-item rank-3";
      }
      
      return `
        <div class="${rankClass}">
          <div class="ranking-left">
            <span class="ranking-badge">${badge}</span>
            <span class="ranking-name">
              <span class="model-dot" style="background:${m.color}"></span>
              ${m.name}
            </span>
          </div>
          <span class="ranking-score" style="color:${m.color}">%${m.overall}</span>
        </div>
      `;
    }).join("");
  }

  // Radar Chart
  if (benchChartInstances.radar) benchChartInstances.radar.destroy();
  const ctxRadar = document.getElementById("chart-bench-radar")?.getContext("2d");
  const metrics = [
    { key: "tool_accuracy", label: "Araç Doğruluğu" },
    { key: "spatial_accuracy", label: "Konum Doğruluğu" },
    { key: "param_accuracy", label: "Parametre Doğruluğu" },
    { key: "schema_validity", label: "Şema Geçerliliği" }
  ];
  if (ctxRadar) {
    benchChartInstances.radar = new Chart(ctxRadar, {
      type: "radar",
      data: {
        labels: metrics.map(m => m.label),
        datasets: sortedModels.map(m => ({
          label: m.name,
          data: metrics.map(mt => m.data[mt.key] || 0),
          borderColor: m.color,
          backgroundColor: m.color + "10",
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 10, padding: 12, color: '#475569' }
          }
        },
        scales: {
          r: {
            grid: { color: '#f1f5f9' },
            angleLines: { color: '#f1f5f9' },
            ticks: { backdropColor: 'transparent', color: '#64748b', z: 10 },
            pointLabels: { color: '#475569', font: { size: 10, weight: '600' } },
            min: 0,
            max: 100
          }
        }
      }
    });
  }

  // Helper for metric bar charts
  function drawMetricChart(chartId, key, label) {
    if (benchChartInstances[key]) benchChartInstances[key].destroy();
    const ctx = document.getElementById(chartId)?.getContext("2d");
    if (ctx) {
      benchChartInstances[key] = new Chart(ctx, {
        type: "bar",
        data: {
          labels,
          datasets: [{
            label,
            data: sortedModels.map(m => m.data[key] || 0),
            backgroundColor: colors.map(c => c + "cc"),
            borderColor: colors,
            borderWidth: 1.5,
            borderRadius: 8,
            maxBarThickness: 28
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: COMMON_PLUGINS,
          scales: {
            x: { grid: { display: false }, ticks: { color: '#64748b' } },
            y: { grid: { color: '#f1f5f9' }, ticks: { color: '#64748b' }, min: 0, max: 100 }
          }
        }
      });
    }
  }

  drawMetricChart("chart-bench-tool", "tool_accuracy", "Araç Seçim (%)");
  drawMetricChart("chart-bench-spatial", "spatial_accuracy", "Konum Bulma (%)");
  drawMetricChart("chart-bench-param", "param_accuracy", "Parametre Çıkarımı (%)");
  drawMetricChart("chart-bench-schema", "schema_validity", "Şema Geçerliliği (%)");

  // Latency Chart
  if (benchChartInstances.latency) benchChartInstances.latency.destroy();
  const ctxLatency = document.getElementById("chart-bench-latency")?.getContext("2d");
  if (ctxLatency) {
    benchChartInstances.latency = new Chart(ctxLatency, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Ortalama Gecikme (ms)",
          data: sortedModels.map(m => m.data.avg_latency_ms || 0),
          backgroundColor: colors.map(c => c + "cc"),
          borderColor: colors,
          borderWidth: 1.5,
          borderRadius: 8,
          maxBarThickness: 32
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: COMMON_PLUGINS,
        scales: COMMON_SCALES
      }
    });
  }

  // Render scenario details table
  renderDetailTable(data, sortedModels);
}

/* ==========================================================================
   SIDEBAR LİVE STATS POPULATOR
   ========================================================================== */

function populateSidebarLiveStats(rows) {
  const latencyEl = document.getElementById("sidebar-live-latency");
  const costEl = document.getElementById("sidebar-live-cost");
  const tokensEl = document.getElementById("sidebar-live-tokens");

  if (latencyEl) {
    latencyEl.innerHTML = rows.map(r => {
      const sec = r.latency != null ? (r.latency / 1000).toFixed(2) + "s" : "Hata/Boş";
      const pct = r.latency != null ? Math.min((r.latency / 5000) * 100, 100) : 0;
      return `
        <div style="margin-bottom:8px;">
          <div style="display:flex; justify-content:space-between; margin-bottom:2px; font-size:11.5px;">
            <span><span class="model-dot" style="background:${r.color}"></span> ${r.name}</span>
            <strong>${sec}</strong>
          </div>
          <div class="mini-score-bar-bg" style="width:100%; height:4px; margin-top:2px;">
            <div class="mini-score-bar-fill" style="width:${pct}%; background:${r.color}; height:100%;"></div>
          </div>
        </div>
      `;
    }).join("");
  }

  if (costEl) {
    costEl.innerHTML = rows.map(r => {
      const val = r.cost != null && r.cost > 0 ? "$" + r.cost.toFixed(4) : "—";
      return `
        <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:11.5px;">
          <span><span class="model-dot" style="background:${r.color}"></span> ${r.name}</span>
          <strong>${val}</strong>
        </div>
      `;
    }).join("");
  }

  if (tokensEl) {
    tokensEl.innerHTML = rows.map(r => {
      const val = r.tokens != null && r.tokens > 0 ? r.tokens : "—";
      return `
        <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:11.5px;">
          <span><span class="model-dot" style="background:${r.color}"></span> ${r.name}</span>
          <strong>${val} tok</strong>
        </div>
      `;
    }).join("");
  }
}

/* ==========================================================================
   SCENARIO DETAIL TABLE RENDERER (BENCHMARK.HTML TABLO KODU)
   ========================================================================== */

let activeDetailView = "all";

function renderDetailTable(data, sortedModels) {
  const tabsContainer = document.getElementById("bx-detail-tabs");
  const thead = document.getElementById("bx-detail-thead");
  const tbody = document.getElementById("bx-detail-tbody");

  if (!tabsContainer || !thead || !tbody) return;

  const tabs = [{ key: "all", label: "📋 Tüm Modeller" }];
  sortedModels.forEach(m => tabs.push({ key: m.key, label: m.name }));

  tabsContainer.innerHTML = tabs.map(t =>
    `<button class="bx-detail-tab ${t.key === activeDetailView ? "active" : ""}" data-tab="${t.key}">${t.label}</button>`
  ).join("");

  tabsContainer.querySelectorAll(".bx-detail-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      activeDetailView = btn.dataset.tab;
      tabsContainer.querySelectorAll(".bx-detail-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      fillDetailTable(data, sortedModels, thead, tbody);
    });
  });

  fillDetailTable(data, sortedModels, thead, tbody);
}

const CRITERIA_MAP = {
  "Zeytinburnu'ndaki eczanelerin etrafina 200m buffer at": "Buffer (Zeytinburnu, 200m)",
  "Kadikoy'deki kafeleri goster": "AttributeTable (Kadıköy, cafe)",
  "Uskudar'da adinda Merkez gecen eczaneleri bul": "AttributeQuery (Üsküdar, SQL)",
  "Sisli'deki eczanelere en yakin hastaneyi bul": "NearestSearch (Şişli)",
  "Fatih'teki okullarin yogunluk analizini yap": "PointDensity (Fatih, school)",
  "Beyoglu'nu haritada goster": "Geocode (Beyoğlu)",
  "Bahcelievler'deki eczanelerin 400m bufferi ile okullarin 300m bufferinin kesisimini bul": "Intersection (Bahçelievler)",
  "Besiktas'taki hastanelere en yakin eczanelere ugrayan rota ver": "Route (Beşiktaş)"
};

function loadScenarioToMainGrid(query, data) {
  if (!data || !data.dashboard) return;
  console.log(`[GIS Console] Loading scenario "${query}" into 7 maps grid...`);
  
  MODELS.forEach(model => {
    const d = data.dashboard[model.key];
    if (!d || !d.details) return;
    
    const row = d.details.find(r => r.query === query);
    if (!row) return;
    
    const status = row.error ? "error" : (row.feature_count > 0 ? "success" : "empty");
    const resultFormatted = {
      status: status,
      error: row.error,
      geojson: row.geojson || { type: "FeatureCollection", features: [] },
      processing_time_ms: row.processing_time_ms,
      selected_tool: row.actual_tool || "—",
      explanation: row.explanation || "(Açıklama yok)",
      sql_equivalent: row.sql_equivalent || row.sql || "",
      attribute_table: row.attribute_table || []
    };
    
    renderResult(model.key, resultFormatted);
  });
  
  // Switch view to main maps grid
  const btnViewAll = document.getElementById("btn-view-all");
  if (btnViewAll) {
    btnViewAll.click();
  }
}

function fillDetailTable(data, sortedModels, thead, tbody) {
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
    thead.innerHTML = `
      <tr>
        <th style="min-width:150px">Sorgu</th>
        ${sortedModels.map(m => `
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
        <th>Harita</th>
      </tr>
    `;

    // ═══ SENARYO SATIRLARI ═══
    const firstModel = sortedModels[0];
    const details = dashboard[firstModel.key]?.details || [];

    const scenarioRows = details.map((row, idx) => {
      return `
        <tr>
          <td class="bx-cell-query" title="${escapeHtml(row.query)}">${escapeHtml(row.query)}</td>
          ${sortedModels.map(m => {
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
          <td><button class="bx-cell-map-btn" data-query="${escapeHtml(row.query)}">🗺️ Göster</button></td>
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
        <td style="font-weight:700;font-size:12px;color:var(--text-dim);padding:10px 12px">
          📊 Genel Başarı %
        </td>
        ${sortedModels.map(m => {
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
        <td></td>
      </tr>
    `;

    tbody.innerHTML = scenarioRows + summaryRow;

  } else {
    thead.innerHTML = `
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
        <th>Harita</th>
      </tr>
    `;

    const details = dashboard[view]?.details || [];
    tbody.innerHTML = details.map((row, idx) => {
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
          <td class="bx-cell-query" title="${escapeHtml(row.query)}">${escapeHtml(row.query)}</td>
          <td><span class="bx-cell-tool">${escapeHtml(row.expected_tool)}</span></td>
          <td><span class="bx-cell-tool" style="${toolOk ? "" : "color:#f55036;border-color:rgba(245,80,54,0.3)"}">${escapeHtml(row.actual_tool || "—")}</span></td>
          ${cell(toolOk,   "Araç")}
          ${cell(geoOk,    "Konum")}
          ${cell(paramOk,  "Parametre")}
          ${cell(schemaOk, "Schema")}
          <td>${row.processing_time_ms ?? "—"}</td>
          <td style="color:var(--status-error);font-size:10px;max-width:120px;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(row.error || "")}">${row.error ? "⚠ " + escapeHtml(row.error).substring(0, 30) : "—"}</td>
          <td><button class="bx-cell-map-btn" data-query="${escapeHtml(row.query)}" data-model="${view}">🗺️ Göster</button></td>
        </tr>
      `;
    }).join("");
  }

  // Bind click events to modal map buttons
  tbody.querySelectorAll(".bx-cell-map-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const query = btn.dataset.query;
      if (view === "all") {
        loadScenarioToMainGrid(query, data);
      } else {
        openBenchmarkMapModal(query, view);
      }
    });
  });
}

/* ==========================================================================
   MODAL MAP PREVIEW LOGIC FOR BENCHMARK SCENARIOS
   ========================================================================== */

let modalMapInstance = null;
let modalCachedResults = {}; 

async function openBenchmarkMapModal(queryText, initialModelKey) {
  const modal = document.getElementById("bx-map-modal");
  const queryEl = document.getElementById("bx-modal-query");
  const tabsRow = document.getElementById("bx-modal-tabs");
  
  if (!modal) return;
  modal.classList.remove("hidden");
  queryEl.textContent = queryText;
  
  // Render tabs for models inside the modal
  tabsRow.innerHTML = MODELS.map(m => {
    const activeClass = m.key === initialModelKey ? "active" : "";
    const activeStyle = m.key === initialModelKey ? `background-color: ${m.color};` : "";
    return `<button class="modal-tab-btn ${activeClass}" style="${activeStyle}" data-model="${m.key}">
      <span class="model-dot" style="background: ${m.color}"></span> ${m.name}
    </button>`;
  }).join("");
  
  // Setup MapLibre in modal
  setTimeout(() => {
    if (!modalMapInstance) {
      modalMapInstance = new maplibregl.Map({
        container: 'bx-modal-map',
        style: {
          version: 8,
          sources: {
            "osm-tiles": {
              type: "raster",
              tiles: ["https://a.tile.openstreetmap.org/{z}/{x}/{y}.png"],
              tileSize: 256,
              attribution: "© OpenStreetMap contributors"
            }
          },
          layers: [
            { id: "osm-layer", type: "raster", source: "osm-tiles", minzoom: 0, maxzoom: 19 }
          ]
        },
        center: [ISTANBUL_CENTER[1], ISTANBUL_CENTER[0]],
        zoom: ISTANBUL_ZOOM - 0.5
      });
      
      modalMapInstance.on('load', () => {
        modalMapInstance.addSource('modal-source', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
        
        modalMapInstance.addLayer({
          id: 'modal-layer-polygons', type: 'fill', source: 'modal-source',
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'fill-color': '#4f46e5', 'fill-opacity': 0.1 }
        });
        modalMapInstance.addLayer({
          id: 'modal-layer-polygons-glow', type: 'line', source: 'modal-source',
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'line-color': '#4f46e5', 'line-width': 8, 'line-blur': 3, 'line-opacity': 0.6 }
        });
        modalMapInstance.addLayer({
          id: 'modal-layer-polygons-core', type: 'line', source: 'modal-source',
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.9 }
        });

        modalMapInstance.addLayer({
          id: 'modal-layer-lines-glow', type: 'line', source: 'modal-source',
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: { 'line-color': '#4f46e5', 'line-width': 8, 'line-blur': 3, 'line-opacity': 0.6 }
        });
        modalMapInstance.addLayer({
          id: 'modal-layer-lines-core', type: 'line', source: 'modal-source',
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-opacity': 0.95 }
        });

        modalMapInstance.addLayer({
          id: 'modal-layer-points-glow', type: 'circle', source: 'modal-source',
          filter: ['==', ['geometry-type'], 'Point'],
          paint: { 'circle-color': '#4f46e5', 'circle-radius': 12, 'circle-blur': 0.5, 'circle-opacity': 0.4 }
        });
        modalMapInstance.addLayer({
          id: 'modal-layer-points-core', type: 'circle', source: 'modal-source',
          filter: ['==', ['geometry-type'], 'Point'],
          paint: { 'circle-color': '#ffffff', 'circle-radius': 4.5, 'circle-stroke-color': '#4f46e5', 'circle-stroke-width': 2.5 }
        });
        
        loadModelQueryForModal(queryText, initialModelKey);
      });
    } else {
      modalMapInstance.resize();
      loadModelQueryForModal(queryText, initialModelKey);
    }
  }, 200);

  // Tab click handler inside modal
  tabsRow.querySelectorAll(".modal-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      tabsRow.querySelectorAll(".modal-tab-btn").forEach(b => {
        b.classList.remove("active");
        b.style.backgroundColor = "";
      });
      btn.classList.add("active");
      const modelKey = btn.dataset.model;
      const modelColor = MODELS.find(m => m.key === modelKey).color;
      btn.style.backgroundColor = modelColor;
      loadModelQueryForModal(queryText, modelKey);
    });
  });
}

async function loadModelQueryForModal(queryText, modelKey) {
  const statusEl = document.getElementById("bx-modal-status");
  const metaEl = document.getElementById("bx-modal-meta");
  const modelColor = MODELS.find(m => m.key === modelKey).color;
  
  // Set map layer colors dynamically
  if (modalMapInstance) {
    const src = modalMapInstance.getSource('modal-source');
    if (src) src.setData({ type: "FeatureCollection", features: [] });

    try {
      ['modal-layer-polygons', 'modal-layer-polygons-glow', 'modal-layer-lines-glow', 'modal-layer-points-glow'].forEach(lyrId => {
        const prop = lyrId.includes('fill') ? 'fill-color' : 'line-color';
        if (lyrId.includes('points')) {
          modalMapInstance.setPaintProperty(lyrId, 'circle-color', modelColor);
        } else {
          modalMapInstance.setPaintProperty(lyrId, prop, modelColor);
        }
      });
      modalMapInstance.setPaintProperty('modal-layer-points-core', 'circle-stroke-color', modelColor);
    } catch(e) {}
  }

  const cacheKey = `${modelKey}_${queryText}`;
  
  if (modalCachedResults[cacheKey]) {
    updateModalMap(modalCachedResults[cacheKey]);
    return;
  }

  // Önce localStorage'da var olan benchmark sonuçlarını kontrol et
  const cachedBenchmarkStr = localStorage.getItem("bx_last_result");
  if (cachedBenchmarkStr) {
    try {
      const parsed = JSON.parse(cachedBenchmarkStr);
      if (parsed && parsed.dashboard && parsed.dashboard[modelKey]) {
        const details = parsed.dashboard[modelKey].details || [];
        // Türkçe karakter ve boşluk toleransı için normalize ederek karşılaştırma yapalım
        const normalizeStr = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const normTarget = normalizeStr(queryText);
        const matchedDetail = details.find(d => normalizeStr(d.query) === normTarget);
        if (matchedDetail && matchedDetail.geojson && matchedDetail.geojson.type === "FeatureCollection") {
          // Cache'le
          modalCachedResults[cacheKey] = matchedDetail;
          updateModalMap(matchedDetail);
          return;
        }
      }
    } catch(e) {
      console.error("Benchmark cache okuma hatası:", e);
    }
  }
  
  statusEl.textContent = `🔄 ${modelKey.toUpperCase()} sorguyu çalıştırıyor...`;
  metaEl.textContent = "";
  
  try {
    const response = await fetch(`/api/analyze/${modelKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: queryText })
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    
    modalCachedResults[cacheKey] = data;
    updateModalMap(data);
  } catch (err) {
    statusEl.textContent = `❌ Hata: ${err.message}`;
  }
}

function updateModalMap(result) {
  const statusEl = document.getElementById("bx-modal-status");
  const metaEl = document.getElementById("bx-modal-meta");
  
  if (result.status === "error") {
    statusEl.textContent = `❌ Model Hatası: ${result.error || "Bilinmiyor"}`;
    return;
  }
  
  const geojson = result.geojson || { type: "FeatureCollection", features: [] };
  const src = modalMapInstance.getSource('modal-source');
  if (src) src.setData(geojson);
  
  const bounds = getGeoJSONBounds(geojson);
  if (bounds) {
    modalMapInstance.fitBounds(bounds, { padding: 45, maxZoom: 15 });
  } else {
    modalMapInstance.setCenter([ISTANBUL_CENTER[1], ISTANBUL_CENTER[0]]);
    modalMapInstance.setZoom(10);
  }
  
  const tool = result.selected_tool || "AttributeTable";
  const featCount = geojson.features ? geojson.features.length : 0;
  const timeSec = typeof result.processing_time_ms === "number" ? (result.processing_time_ms / 1000).toFixed(2) + "s" : "";
  
  statusEl.textContent = `✅ Araç: ${tool}  ·  Nesne: ${featCount} adet`;
  if (timeSec) metaEl.textContent = `Süre: ${timeSec}`;
}

// Modal closing setup
document.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("bx-map-modal");
  const modalClose = document.getElementById("bx-modal-close");
  if (modalClose && modal) {
    modalClose.addEventListener("click", () => modal.classList.add("hidden"));
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.add("hidden");
    });
  }
});

/* ==========================================================================
   APP.JS SONU
   ========================================================================== */




