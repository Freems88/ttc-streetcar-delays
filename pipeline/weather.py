"""Daily Toronto weather for the Trends page, from Environment Canada's open climate data
(the MSC GeoMet "climate-daily" collection, no key needed), station Toronto City.

Kept in WORK_DIR/weather.json as {"YYYY-MM-DD": {"p": precipitation mm, "tmin": °C, "tmax": °C}}.
Each night the last REFRESH_DAYS days are fetched again: recent days are often filled in or
corrected later. The station doesn't split rain from snow; the page calls precipitation on a
day that stayed at or below freezing "likely snow".
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
    FILE.write_text(json.dumps(dict(sorted(have.items())), separators=(",", ":")))
    print(f"weather: {len(feats)} days fetched, {len(have)} kept", file=sys.stderr)


if __name__ == "__main__":
    update()
