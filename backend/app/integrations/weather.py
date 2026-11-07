"""Weather via Open-Meteo (free, no API key, no account)."""

from urllib.parse import urlencode

from app.integrations import http
from app.integrations.http import IntegrationError

CODES = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers",
    82: "violent showers", 85: "snow showers", 86: "heavy snow showers", 95: "thunderstorm",
    96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
}


def forecast(location: str, days: int = 3, units: str = "metric") -> str:
    geo = http.get_json("https://geocoding-api.open-meteo.com/v1/search?" + urlencode({"name": location, "count": 1, "language": "en"}))
    places = geo.get("results") or []
    if not places:
        raise IntegrationError(f"Couldn't find a place called {location!r}.")
    p = places[0]
    temp_unit, wind_unit = ("fahrenheit", "mph") if units == "imperial" else ("celsius", "kmh")
    params = {
        "latitude": p["latitude"], "longitude": p["longitude"], "timezone": "auto", "forecast_days": days,
        "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        "temperature_unit": temp_unit, "wind_speed_unit": wind_unit,
    }
    data = http.get_json("https://api.open-meteo.com/v1/forecast?" + urlencode(params))
    t = "°F" if units == "imperial" else "°C"
    w = "mph" if units == "imperial" else "km/h"
    place = ", ".join(x for x in (p.get("name"), p.get("admin1"), p.get("country")) if x)
    cur = data.get("current", {})
    lines = [
        f"Weather for {place} (source: Open-Meteo)",
        f"Now: {cur.get('temperature_2m')}{t}, feels like {cur.get('apparent_temperature')}{t}, "
        f"{CODES.get(cur.get('weather_code'), 'unknown')}, wind {cur.get('wind_speed_10m')} {w}, humidity {cur.get('relative_humidity_2m')}%",
    ]
    d = data.get("daily", {})
    for i, day in enumerate(d.get("time", [])):
        lines.append(
            f"{day}: {CODES.get(d['weather_code'][i], 'unknown')}, {d['temperature_2m_min'][i]}{t} to "
            f"{d['temperature_2m_max'][i]}{t}, rain chance {d['precipitation_probability_max'][i]}%"
        )
    return "\n".join(lines)
