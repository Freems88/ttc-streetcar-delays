"""Daily Toronto weather for the Trends page, from Environment Canada's open climate data
(the MSC GeoMet "climate-daily" collection, no key needed), station Toronto City.

Kept in WORK_DIR/weather.json as {"YYYY-MM-DD": {"p": precipitation mm (liquid equivalent),
"tmin": °C, "tmax": °C, "kind": "rain" | "snow" | "mixed" | None, "rain_mm", "snow_cm"}}.
Each night the last REFRESH_DAYS days are fetched again: recent days are often filled in or
corrected later.

The station reports only liquid-equivalent precipitation (snow melted down), not rain and
snow separately, so the page doesn't show that number. Instead each day is classed by its
temperatures (see classify) and snow is shown as an ESTIMATED depth: water times a
snow-to-water ratio from the day's mean temperature, after the US National Weather Service's
snowfall-to-meltwater table, capped at 20:1. Rough (the air above the ground matters too),
but in the right ballpark.
"""
import json
import sys
import urllib.request
from datetime import date, timedelta

from common import WORK_DIR

STATION = "6158355"  # Toronto City (Environment Canada climate id)
URL = ("https://api.weather.gc.ca/collections/climate-daily/items?f=json&CLIMATE_IDENTIFIER={station}"
       "&datetime={a}/{b}&limit=500&properties=LOCAL_DATE,TOTAL_PRECIPITATION,MIN_TEMPERATURE,MAX_TEMPERATURE")
REFRESH_DAYS = 14
FIRST_DAY = "2026-10-29"  # first day of streetcar data
FILE = WORK_DIR / "weather.json"


SNOW_RATIOS = ((-3, 10), (-7, 15))  # mean temp above X °C -> ratio; colder than the last: 20
SNOW_RATIO_MAX = 20


def classify(p, tmin, tmax):
    """{"kind", "rain_mm", "snow_cm"} for a day's liquid-equivalent precipitation p (mm)."""
    if not p or tmin is None or tmax is None:
        return {"kind": None, "rain_mm": 0, "snow_cm": 0}
    if tmax <= 1:  # stayed at or below about freezing: snow
        mean = (tmin + tmax) / 2
        ratio = next((r for t, r in SNOW_RATIOS if mean > t), SNOW_RATIO_MAX)
        return {"kind": "snow", "rain_mm": 0, "snow_cm": round(p * ratio / 10, 1)}
    if tmin >= 1:  # stayed above freezing: rain
        return {"kind": "rain", "rain_mm": p, "snow_cm": 0}
    return {"kind": "mixed", "rain_mm": p, "snow_cm": 0}  # crossed freezing: can't split it honestly


def update(today=None):
    today = today or date.today()
    have = json.loads(FILE.read_text()) if FILE.exists() else {}
    start = max(date.fromisoformat(FIRST_DAY), today - timedelta(days=REFRESH_DAYS))
    if not have:
        start = date.fromisoformat(FIRST_DAY)
    req = urllib.request.Request(URL.format(station=STATION, a=start.isoformat(), b=today.isoformat()),
                                 headers={"User-Agent": "ttc-streetcar-delays/1.0 (personal research)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        feats = json.load(r).get("features", [])
    for f in feats:
        p = f["properties"]
        day = p["LOCAL_DATE"][:10]
        have[day] = {"p": p.get("TOTAL_PRECIPITATION"), "tmin": p.get("MIN_TEMPERATURE"),
                     "tmax": p.get("MAX_TEMPERATURE")}
    for w in have.values():  # (re)classify every day, so a change to the method applies to all
        w.update(classify(w["p"], w["tmin"], w["tmax"]))
    FILE.write_text(json.dumps(dict(sorted(have.items())), separators=(",", ":")))
    print(f"weather: {len(feats)} days fetched, {len(have)} kept", file=sys.stderr)


if __name__ == "__main__":
    update()
