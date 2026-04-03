"""
Terrace Database Builder for terras-in-de-zon
==============================================
This script:
1. Queries OpenStreetMap for all restaurants/cafes/bars/pubs with outdoor seating in the Netherlands
2. Attempts to estimate the facing direction of each terrace using nearby building geometry
3. Outputs a CSV ready to import into Airtable

REQUIREMENTS:
    pip install requests

USAGE:
    python build_terrace_db.py

OUTPUT:
    terraces_nl.csv  (ready for Airtable import)
"""

import requests
import json
import csv
import math
import time
import sys

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# ── Step 1: Fetch all outdoor-seating venues in NL ─────────────────────────────

def fetch_venues():
    """Query Overpass API for all NL venues with outdoor seating."""
    query = """
    [out:json][timeout:300];
    area["ISO3166-1"="NL"][admin_level=2]->.nl;
    (
      node["amenity"~"restaurant|cafe|bar|pub"]["outdoor_seating"="yes"](area.nl);
      way["amenity"~"restaurant|cafe|bar|pub"]["outdoor_seating"="yes"](area.nl);
      node["amenity"~"restaurant|cafe|bar|pub"]["outdoor_seating:signed"="yes"](area.nl);
      way["amenity"~"restaurant|cafe|bar|pub"]["outdoor_seating:signed"="yes"](area.nl);
    );
    out center tags;
    """
    print("Step 1: Querying OpenStreetMap for NL venues with outdoor seating...")
    print("        This may take 1-3 minutes...")
    
    resp = requests.get(OVERPASS_URL, params={"data": query}, timeout=360)
    resp.raise_for_status()
    data = resp.json()
    
    elements = data.get("elements", [])
    print(f"        Got {len(elements)} raw results from OSM")
    
    venues = []
    seen = set()
    
    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name", "").strip()
        if not name:
            continue
        
        # Get coordinates
        if el["type"] == "node":
            lat = el.get("lat", 0)
            lng = el.get("lon", 0)
        else:
            center = el.get("center", {})
            lat = center.get("lat", 0)
            lng = center.get("lon", 0)
        
        if lat == 0 or lng == 0:
            continue
        
        # Deduplicate by name + approximate location
        key = (name, round(lat, 4), round(lng, 4))
        if key in seen:
            continue
        seen.add(key)
        
        amenity = tags.get("amenity", "")
        cuisine = tags.get("cuisine", "")
        desc_parts = []
        if amenity:
            desc_parts.append(amenity)
        if cuisine:
            desc_parts.append(cuisine.replace(";", ", "))
        
        venues.append({
            "name": name,
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "amenity": amenity,
            "cuisine": cuisine,
            "description": ", ".join(desc_parts),
            "osm_id": el["id"],
            "osm_type": el["type"],
        })
    
    print(f"        Extracted {len(venues)} unique named venues")
    return venues


# ── Step 2: Estimate facing direction from nearby buildings ─────────────────────

def fetch_nearby_buildings(lat, lng, radius=50):
    """Fetch building outlines near a coordinate."""
    query = f"""
    [out:json][timeout:30];
    way["building"](around:{radius},{lat},{lng});
    out geom;
    """
    try:
        resp = requests.get(OVERPASS_URL, params={"data": query}, timeout=35)
        resp.raise_for_status()
        return resp.json().get("elements", [])
    except Exception:
        return []


def estimate_facing(venue_lat, venue_lng, buildings):
    """
    Estimate which direction a terrace faces based on the nearest building wall.
    
    Logic: Find the closest building wall segment to the venue point.
    The terrace likely faces AWAY from that wall (outward from the building).
    """
    if not buildings:
        return 180.0  # Default: south
    
    venue_lat_r = math.radians(venue_lat)
    venue_lng_r = math.radians(venue_lng)
    
    best_dist = float("inf")
    best_bearing = 180.0
    
    for bldg in buildings:
        geom = bldg.get("geometry", [])
        if len(geom) < 2:
            continue
        
        for i in range(len(geom) - 1):
            p1 = geom[i]
            p2 = geom[i + 1]
            
            # Find closest point on this wall segment to venue
            ax, ay = p1["lon"], p1["lat"]
            bx, by = p2["lon"], p2["lat"]
            vx, vy = venue_lng, venue_lat
            
            # Project venue point onto line segment
            dx, dy = bx - ax, by - ay
            if dx == 0 and dy == 0:
                continue
            t = max(0, min(1, ((vx - ax) * dx + (vy - ay) * dy) / (dx * dx + dy * dy)))
            cx, cy = ax + t * dx, ay + t * dy
            
            # Distance (approximate, in meters)
            dlat = (vy - cy) * 111320
            dlng = (vx - cx) * 111320 * math.cos(math.radians(cy))
            dist = math.sqrt(dlat * dlat + dlng * dlng)
            
            if dist < best_dist:
                best_dist = dist
                # Direction FROM wall TO venue = direction the terrace faces
                bearing_rad = math.atan2(dlng, dlat)
                best_bearing = (math.degrees(bearing_rad) + 360) % 360
    
    return round(best_bearing, 1)


def estimate_facings_batch(venues, sample_rate=1.0):
    """
    Estimate facing for all venues. 
    To be nice to the Overpass API, we add small delays.
    sample_rate < 1.0 will only estimate a fraction (for testing).
    """
    print(f"\nStep 2: Estimating facing directions for {len(venues)} venues...")
    print("        This queries building data per venue — expect ~3 min per 100 venues.")
    print("        (Venues without nearby buildings default to facing=180 / south)")
    
    total = len(venues)
    estimated = 0
    defaulted = 0
    
    for i, v in enumerate(venues):
        if i % 50 == 0 and i > 0:
            print(f"        Progress: {i}/{total} ({estimated} estimated, {defaulted} defaulted)")
        
        # Rate limit: max ~2 requests/second
        time.sleep(0.5)
        
        buildings = fetch_nearby_buildings(v["lat"], v["lng"], radius=40)
        
        if buildings:
            v["facing"] = estimate_facing(v["lat"], v["lng"], buildings)
            estimated += 1
        else:
            v["facing"] = 180.0
            defaulted += 1
    
    print(f"        Done! {estimated} estimated from buildings, {defaulted} defaulted to south")
    return venues


# ── Step 3: Write CSV for Airtable ─────────────────────────────────────────────

def write_csv(venues, filename="terraces_nl.csv"):
    """Write Airtable-compatible CSV."""
    fieldnames = [
        "name", "lat", "lng", "facing",
        "shade_direction", "shade_min_altitude",
        "description", "active"
    ]
    
    with open(filename, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        
        for v in venues:
            writer.writerow({
                "name": v["name"],
                "lat": v["lat"],
                "lng": v["lng"],
                "facing": v["facing"],
                "shade_direction": 0.0,
                "shade_min_altitude": 0.0,
                "description": v.get("description", ""),
                "active": "true",
            })
    
    print(f"\nStep 3: Wrote {len(venues)} terraces to {filename}")
    print(f"        Ready to import into Airtable!")


# ── Main ────────────────────────────────────────────────────────────────────────

def main():
    # Step 1: Get venues
    venues = fetch_venues()
    
    if not venues:
        print("ERROR: No venues found. Check your internet connection.")
        sys.exit(1)
    
    # Save raw data as backup
    with open("venues_raw.json", "w", encoding="utf-8") as f:
        json.dump(venues, f, ensure_ascii=False, indent=2)
    print(f"        Saved raw data to venues_raw.json")
    
    # Step 2: Estimate facing (this takes a while)
    print(f"\n        WARNING: Estimating facing for {len(venues)} venues will take")
    print(f"        approximately {len(venues) * 0.6 / 60:.0f} minutes.")
    print(f"        Press Ctrl+C to skip and use default facing (180/south)")
    
    try:
        venues = estimate_facings_batch(venues)
    except KeyboardInterrupt:
        print("\n        Skipped! Using default facing (180) for all venues.")
        for v in venues:
            v["facing"] = 180.0
    
    # Step 3: Write CSV
    write_csv(venues)
    
    # Summary
    from collections import Counter
    types = Counter(v["amenity"] for v in venues)
    print("\n── Summary ──────────────────────────────────────────")
    for t, c in types.most_common():
        print(f"  {t}: {c}")
    print(f"  TOTAL: {len(venues)}")
    print("────────────────────────────────────────────────────")
    print("\nNext steps:")
    print("  1. Open terraces_nl.csv")
    print("  2. Go to Airtable → your terraces table")
    print("  3. Click the '+' at the bottom, or use Import CSV")
    print("  4. Map columns to match your existing fields")
    print("  5. The 'facing' values are estimates — refine over time")


if __name__ == "__main__":
    main()
