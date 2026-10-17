"""Verify/refresh coordinates in data/places.json using Google Places API (New) Text Search.

Usage: GOOGLE_MAPS_API_KEY=... python3 scripts/geocode_places.py
Each place is searched by its English name + region, biased to its current (approximate)
coordinates. Results that land far from the approximation are flagged for manual review.
"""
import json
import math
import os
import sys
import urllib.request

PLACES_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "places.json")
API_URL = "https://places.googleapis.com/v1/places:searchText"
FIELDS = ",".join([
    "places.id", "places.displayName", "places.location", "places.formattedAddress",
    "places.googleMapsUri", "places.rating", "places.userRatingCount",
    "places.businessStatus", "places.regularOpeningHours.weekdayDescriptions",
])
REGION_HINT = {
    "phuket-north": "Phuket", "phuket": "Phuket", "khaolak": "Khao Lak Phang Nga",
    "phangnga": "Phang Nga", "khaosok": "Khao Sok Surat Thani", "krabi": "Krabi",
}
FLAG_KM = 3.0


def km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def search(key, query, lat, lon):
    body = {
        "textQuery": query,
        "maxResultCount": 1,
        "locationBias": {"circle": {"center": {"latitude": lat, "longitude": lon}, "radius": 30000.0}},
    }
    req = urllib.request.Request(API_URL, data=json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS,
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        places = json.load(resp).get("places", [])
    return places[0] if places else None


def main():
    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        sys.exit("GOOGLE_MAPS_API_KEY is not set")
    data = json.load(open(PLACES_FILE, encoding="utf-8"))
    flagged = []
    for p in data["places"]:
        query = f'{p["name"]}, {REGION_HINT.get(p["region"], "")}, Thailand'
        hit = search(key, query, p["lat"], p["lon"])
        if not hit:
            p["geo"] = {"status": "not_found"}
            flagged.append((p["id"], "not found"))
            continue
        lat, lon = hit["location"]["latitude"], hit["location"]["longitude"]
        moved = km(p["lat"], p["lon"], lat, lon)
        geo = {
            "status": "ok" if moved <= FLAG_KM else "check",
            "google_name": hit.get("displayName", {}).get("text"),
            "address": hit.get("formattedAddress"),
            "place_id": hit.get("id"),
            "maps_url": hit.get("googleMapsUri"),
            "moved_km": round(moved, 2),
            "prev": [p["lat"], p["lon"]],
        }
        for src, dst in (("rating", "rating"), ("userRatingCount", "reviews"), ("businessStatus", "business_status")):
            if src in hit:
                geo[dst] = hit[src]
        hours = hit.get("regularOpeningHours", {}).get("weekdayDescriptions")
        if hours:
            geo["hours"] = hours
        p["geo"] = geo
        if geo["status"] == "ok":
            p["lat"], p["lon"] = round(lat, 6), round(lon, 6)
            p.pop("approx", None)
        else:
            flagged.append((p["id"], f'{moved:.1f} km away: {geo["google_name"]} / {geo["address"]}'))
        if geo.get("business_status", "OPERATIONAL") != "OPERATIONAL":
            flagged.append((p["id"], f'business status {geo["business_status"]}'))
    data["meta"]["coords_note"] = "קואורדינטות אומתו מול Google Places. מקומות עם geo.status=check דורשים בדיקה ידנית."
    json.dump(data, open(PLACES_FILE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(data['places'])} places, {len(flagged)} flagged")
    for pid, why in flagged:
        print(f"  {pid}: {why}")


if __name__ == "__main__":
    main()
