# GIS Agent Console

A web application that converts Turkish natural language commands into GIS analyses and evaluates outputs across multiple AI models simultaneously.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python / FastAPI |
| Frontend | HTML + CSS + JavaScript |
| Map Rendering | MapLibre GL JS |
| Charts | Chart.js 4.4.0 |
| Workflow Automation | n8n |
| Benchmark | GeoBenchX (adapted) |

---

## Models

| Model | Version |
|---|---|
| Claude | Sonnet 4.6 |
| GPT | 5.5 |
| Gemini | 2.5 Flash |
| DeepSeek | V4 Flash |
| Qwen | 3.7 Flash |
| Llama | 3.1 |
| GLM | 5.1 |

---

## Architecture

```
User (Turkish NL input)
        │
        ▼
  FastAPI Backend  (/api/analyze)
        │
        ▼ asyncio.gather()
  ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┐
  │     │     │     │     │     │     │     │
 n8n   n8n   n8n   n8n   n8n   n8n   n8n   (×7 parallel webhook workflows)
  │
  ├── LangChain Agent
  ├── Nominatim Geocoding (OpenStreetMap)
  └── GIS Engine (Code Node)
        │
        ▼ GeoJSON
  FastAPI aggregates responses
        │
        ▼
  MapLibre GL JS (side-by-side map panels)
  GeoBenchX Scoring (tool match + feature count)
```

### n8n Webhook Endpoints

| Model | Webhook Path |
|---|---|
| Claude | `/gis-claude` |
| GPT | `/gis-gpt` |
| Gemini | `/gis-gemini` |
| DeepSeek | `/gis-deepseek` |
| Qwen | `/gis-qwen` |
| Llama (Groq) | `/gis-groq` |
| GLM | `/gis-glm` |

---

## Project Structure

```
/
├── main.py                 # FastAPI backend
└── static/
    ├── index.html
    ├── style.css
    ├── app.js              # Core frontend logic
    └── benchmark_panel.js  # GeoBenchX scoring panel
```

---

## Installation

```bash
pip install fastapi uvicorn httpx
```

Set the n8n base URL:

```bash
export N8N_BASE_URL=https://your-instance.app.n8n.cloud/webhook
```

Run:

```bash
uvicorn main:app --reload --port 8050
```

---

## API

**POST** `/api/analyze`

Request:
```json
{ "message": "Zeytinburnu'ndaki eczanelerin 200m tampon bölgesini göster" }
```

Response:
```json
{
  "claude":    { "status": "success", "selected_tool": "Buffer", "geojson": {...}, "feature_count": 14, ... },
  "gpt":       { "status": "success", ... },
  "gemini":    { "status": "error",   "error": "...", ... }
}
```

---

## Benchmark

Scoring is based on an adapted GeoBenchX methodology. ArcGIS manual analyses serve as ground truth.

```
Score = Tool Match × 0.4 + Feature Count Proximity × 0.6
```

| Component | Max | Description |
|---|---|---|
| Tool Match | 0.8 | Exact match of selected GIS tool |
| Feature Count | 1.2 | Proximity to ArcGIS reference output |
| **Total** | **2.0** | GeoBenchX scale |

### Task Categories

| Category | Expected Tool | Keywords |
|---|---|---|
| Buffer | `Buffer` | tampon, etraf, 200m |
| Proximity | `Near Analysis` | en yakın, mesafe |
| Routing | `Network Analysis` | rota, güzergah |
| Overlay | `Intersect / Clip` | kesişim, içindeki |
| Density | `Kernel Density` | yoğunluk, heatmap |
| Attribute Query | `Select by Attribute` | göster, listele |

---

## GeoJSON Output Schema

```json
{
  "model": "claude",
  "status": "success",
  "selected_tool": "Buffer",
  "explanation": "...",
  "sql_equivalent": "SELECT ST_Buffer(geom, 200) FROM pharmacies WHERE district='Besiktas'",
  "feature_count": 14,
  "processing_time_ms": 2340,
  "usage": { "total_tokens": 1250 },
  "geojson": { "type": "FeatureCollection", "features": [...] },
  "attribute_table": [...]
}
```
