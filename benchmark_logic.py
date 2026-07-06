import asyncio
import httpx
import time
import math
from datetime import datetime

TEST_CASES = [
    {"query": "Zeytinburnu'ndaki eczanelerin etrafina 200m buffer at", "expected_tool": "Buffer", "lat": 40.9950, "lon": 28.9020, "feature_type": "pharmacy", "distance": 200},
    {"query": "Kadikoy'deki kafeleri goster", "expected_tool": "AttributeTable", "lat": 40.9833, "lon": 29.0333, "feature_type": "cafe"},
    {"query": "Uskudar'da adinda Merkez gecen eczaneleri bul", "expected_tool": "AttributeQuery", "lat": 41.0226, "lon": 29.0244, "feature_type": "pharmacy", "check_sql": True},
    {"query": "Sisli'deki eczanelere en yakin hastaneyi bul", "expected_tool": "NearestSearch", "lat": 41.0608, "lon": 28.9866, "feature_type": "pharmacy"},
    {"query": "Fatih'teki okullarin yogunluk analizini yap", "expected_tool": "PointDensity", "lat": 41.0190, "lon": 28.9495, "feature_type": "school"},
    {"query": "Beyoglu'nu haritada goster", "expected_tool": "Geocode", "lat": 41.0370, "lon": 28.9850},
    {"query": "Bahcelievler'deki eczanelerin 400m bufferi ile okullarin 300m bufferinin kesisimini bul", "expected_tool": "Intersection", "lat": 41.0036, "lon": 28.8631, "feature_type": "pharmacy", "distance": 400},
    {"query": "Besiktas'taki hastanelere en yakin eczanelere ugrayan rota ver", "expected_tool": "Routing", "lat": 41.0422, "lon": 29.0061, "feature_type": "hospital"},
]

MODELS = ["claude", "gpt", "groq", "gemini", "deepseek", "qwen", "glm"]
GEO_THRESHOLD_KM = 2.0



def is_tool_match(actual, expected):
    if not actual or not expected:
        return False
    a = str(actual).lower().strip()
    e = str(expected).lower().strip()
    if a == e:
        return True
    if e == "route" and a == "routing":
        return True
    if e == "coordinatetransformation" and (a == "coordinateconversion" or a == "coordinate_transformation" or a == "coordinateconvert" or a == "coordinatetransform"):
        return True
    if e == "attributequery" and a == "attribute_query":
        return True
    if e == "nearestsearch" and (a == "nearest_search" or a == "nearestneighbor" or a == "nearest_neighbor"):
        return True
    if e == "pointdensity" and (a == "point_density" or a == "density"):
        return True
    return False


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


async def call_webhook(client, m_key, base_url, tc):
    url = f"{base_url.strip()}/gis-{m_key}"
    t0 = time.time()
    error = None
    resp_data = None
    
    max_retries = 0
    for attempt in range(max_retries + 1):
        try:
            response = await client.post(url, json={"message": tc["query"]}, timeout=60.0)
            response.raise_for_status()
            resp_data = response.json()
            
            # n8n basarili dondu ama Overpass hatasi varsa tekrar dene
            if resp_data and resp_data.get("status") == "error":
                explanation = resp_data.get("explanation", "")
                if "Overpass" in explanation or "ulasilamadi" in explanation or "limit" in explanation.lower():
                    if attempt < max_retries:
                        wait_time = 3.0 + attempt * 2.0
                        print(f"[RETRY BENCHMARK] {m_key} got Overpass error. Retrying in {wait_time}s...")
                        await asyncio.sleep(wait_time)
                        continue
            break
        except Exception as e:
            error = str(e)
            if attempt < max_retries:
                wait_time = 3.0 + attempt * 2.0
                print(f"[RETRY BENCHMARK] {m_key} failed with: {error}. Retrying in {wait_time}s...")
                await asyncio.sleep(wait_time)
                continue
            resp_data = None
        
    wall_ms = int((time.time() - t0) * 1000)
    
    row = {
        "query": tc["query"],
        "expected_tool": tc["expected_tool"],
        "error": error
    }
    
    if resp_data:
        p = resp_data.get("parameters", {})
        actual_tool = resp_data.get("selected_tool")
        row["actual_tool"] = actual_tool
        row["tool_match"] = 1 if is_tool_match(actual_tool, tc["expected_tool"]) else 0
        
        if tc.get("check_sql"):
            sql_val = resp_data.get("sql_equivalent") or resp_data.get("sql")
            has_sql = 1 if (sql_val and len(str(sql_val).strip()) > 5) else 0
            
            # Verify feature names contain "merkez"
            features = resp_data.get("geojson", {}).get("features", [])
            valid_filter = True
            if features:
                for f in features:
                    name = f.get("properties", {}).get("name", "").lower()
                    if "merkez" not in name:
                        valid_filter = False
                        break
            else:
                valid_filter = False
                
            row["sql_match"] = 1 if (has_sql and valid_filter) else 0
            if not row["sql_match"]:
                row["tool_match"] = 0
        
        if "feature_type" in tc:
            row["feature_type_match"] = 1 if p.get("feature_type") == tc["feature_type"] else 0
        if "distance" in tc:
            # Handle string distance from LLM
            dist_val = p.get("distance_meters", p.get("distance"))
            try:
                actual_dist = float(dist_val)
                row["distance_match"] = 1 if actual_dist == float(tc["distance"]) else 0
            except:
                row["distance_match"] = 0
                
        lat = p.get("latitude")
        lon = p.get("longitude")
        if lat is not None and lon is not None:
            try:
                dist_km = haversine_km(float(lat), float(lon), tc["lat"], tc["lon"])
                row["geocode_distance_km"] = round(dist_km, 2)
                row["geocode_correct"] = 1 if dist_km <= GEO_THRESHOLD_KM else 0
            except:
                row["geocode_correct"] = 0
        else:
            row["geocode_correct"] = 0
            
        row["schema_valid"] = 1 if resp_data.get("geojson", {}).get("type") == "FeatureCollection" else 0
        row["processing_time_ms"] = resp_data.get("processing_time_ms", wall_ms)
        row["feature_count"] = resp_data.get("feature_count", 0)
        row["geojson"] = resp_data.get("geojson", {"type": "FeatureCollection", "features": []})
        row["explanation"] = resp_data.get("explanation", "")
        row["attribute_table"] = resp_data.get("attribute_table", [])
    else:
        row["tool_match"] = 0
        row["geocode_correct"] = 0
        row["schema_valid"] = 0
        row["processing_time_ms"] = wall_ms
        row["feature_count"] = 0
        row["geojson"] = {"type": "FeatureCollection", "features": []}
        row["explanation"] = "API hatası veya boş yanıt."
        row["attribute_table"] = []
        
    return m_key, row


async def run_benchmark_suite(base_url: str, request=None, model_filter: str = None):
    # Eğer model_filter belirtilmişse sadece o modeli test et
    models_to_test = [model_filter] if model_filter else MODELS
    per_model_results = {m: [] for m in models_to_test}
    
    # n8n Cloud'un çökmesini/offline olmasını önlemek için aynı anda sadece 1 modelin test edilmesine izin veriyoruz
    sem = asyncio.Semaphore(1)
    
    async def run_model_test_suite(client, m_key):
        async with sem:
            # Nominatim/OSM rate limit çakışmalarını önlemek için küçük bir bekleme
            await asyncio.sleep(1.0)
            
            results = []
            for tc_idx, tc in enumerate(TEST_CASES):
                if request and await request.is_disconnected():
                    print(f"[CANCEL] Client disconnected. Aborting benchmark run for {m_key}.")
                    raise asyncio.CancelledError()
    
                # Gemini için RPM rate limit (15 RPM) aşılmaması için daha uzun bekleme
                # n8n Cloud yükünü hafifletmek için bekleme sürelerini artırdık
                if m_key == "gemini":
                    await asyncio.sleep(6.5)
                else:
                    await asyncio.sleep(3.5)
                    
                _, row = await call_webhook(client, m_key, base_url, tc)
                results.append((tc_idx, row))
            return m_key, results
    
    async with httpx.AsyncClient() as client:
        tasks = [run_model_test_suite(client, m_key) for m_key in models_to_test]
        model_runs = await asyncio.gather(*tasks)
        
        for m_key, run_results in model_runs:
            per_model_results[m_key] = [None] * len(TEST_CASES)
            for tc_idx, row in run_results:
                per_model_results[m_key][tc_idx] = row
            
    dashboard = {}
    for m in models_to_test:
        rows = per_model_results[m]
        def avg(l): return sum(l) / len(l) if len(l) > 0 else 0
        
        param_scores = []
        for r in rows:
            parts = []
            if "feature_type_match" in r: parts.append(r["feature_type_match"])
            if "distance_match" in r: parts.append(r["distance_match"])
            if parts: param_scores.append(avg(parts))
            
        dashboard[m] = {
            "tool_accuracy": round(avg([r.get("tool_match", 0) for r in rows]) * 100),
            "spatial_accuracy": round(avg([r.get("geocode_correct", 0) for r in rows]) * 100),
            "param_accuracy": round(avg(param_scores) * 100) if param_scores else 0,
            "schema_validity": round(avg([r.get("schema_valid", 0) for r in rows]) * 100),
            "avg_latency_ms": round(avg([r.get("processing_time_ms", 0) for r in rows])),
            "error_count": len([r for r in rows if r.get("error")]),
            "details": rows
        }
        
    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "test_case_count": len(TEST_CASES),
        "methodology": {
            "tool_accuracy": "Beklenen GIS aracinin (selected_tool) tam eslesme orani",
            "spatial_accuracy": f"Nominatim'den donen koordinatin gercek konuma {GEO_THRESHOLD_KM} km icinde olma orani",
            "param_accuracy": "feature_type ve distance_meters parametrelerinin dogru cikarilma orani",
            "schema_validity": "Cikan GeoJSON'un gecerli FeatureCollection olma orani"
        },
        "dashboard": dashboard
    }
