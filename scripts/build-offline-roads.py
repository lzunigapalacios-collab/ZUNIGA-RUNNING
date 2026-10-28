#!/usr/bin/env python3
"""Convert an Overpass JSON response (ways with geometry) into compact GeoJSON."""
import json
from pathlib import Path

source = Path("data/overpass-roads.json")
target = Path("data/chahuites-roads.geojson")
payload = json.loads(source.read_text(encoding="utf-8"))
features = []
for element in payload.get("elements", []):
    if element.get("type") != "way":
        continue
    geometry = element.get("geometry") or []
    coords = [[point["lon"], point["lat"]] for point in geometry if "lon" in point and "lat" in point]
    if len(coords) < 2:
        continue
    tags = element.get("tags") or {}
    props = {
        key: tags[key]
        for key in ("highway", "name", "ref", "surface", "oneway", "lanes", "service", "bridge", "tunnel")
        if key in tags
    }
    props["osm_id"] = element.get("id")
    features.append({
        "type": "Feature",
        "id": element.get("id"),
        "properties": props,
        "geometry": {"type": "LineString", "coordinates": coords},
    })
collection = {
    "type": "FeatureCollection",
    "name": "Calles y caminos de Chahuites, Oaxaca",
    "attribution": "© OpenStreetMap contributors, ODbL 1.0",
    "features": features,
}
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"Generadas {len(features)} vías en {target} ({target.stat().st_size} bytes)")
if not features:
    raise SystemExit("No se recibieron vías de OpenStreetMap; se cancela para no publicar un mapa vacío.")
