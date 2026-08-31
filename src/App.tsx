import { useState, useEffect, useCallback, useRef } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { CITIES, type City } from "./cities";

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const WORLD = L.latLngBounds(L.latLng(-85, -180), L.latLng(85, 180));

// WMO weather code → label + emoji
const WMO: Record<number, [string, string]> = {
  0: ["Clear sky", "☀️"], 1: ["Mainly clear", "🌤️"], 2: ["Partly cloudy", "⛅"],
  3: ["Overcast", "☁️"], 45: ["Fog", "🌫️"], 48: ["Icy fog", "🌫️"],
  51: ["Light drizzle", "🌦️"], 53: ["Drizzle", "🌦️"], 55: ["Heavy drizzle", "🌧️"],
  61: ["Light rain", "🌧️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"],
  71: ["Light snow", "🌨️"], 73: ["Snow", "❄️"], 75: ["Heavy snow", "❄️"],
  80: ["Showers", "🌦️"], 81: ["Rain showers", "🌧️"], 82: ["Heavy showers", "🌧️"],
  95: ["Thunderstorm", "⛈️"], 96: ["Thunderstorm", "⛈️"], 99: ["Thunderstorm", "⛈️"],
};
function wmo(code: number) { return WMO[code] ?? ["Unknown", "🌡️"]; }

type WeatherInfo = {
  name: string; lat: number; lon: number;
  temp: number; feels_like: number; humidity: number; wind: number;
  code: number;
};

// Open-Meteo: free, no API key
async function fetchWeather(lat: number, lon: number): Promise<WeatherInfo | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,apparent_temperature,relativehumidity_2m,windspeed_10m,weathercode` +
      `&wind_speed_unit=ms&timezone=auto`;
    const r = await fetch(url);
    const d = await r.json();
    if (!d.current) return null;
    const c = d.current;
    return {
      name: "", lat, lon,
      temp:       c.temperature_2m,
      feels_like: c.apparent_temperature,
      humidity:   c.relativehumidity_2m,
      wind:       c.windspeed_10m,
      code:       c.weathercode,
    };
  } catch { return null; }
}

// Nominatim: free OSM geocoder, no API key
async function geocode(q: string): Promise<{ name: string; lat: number; lon: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1`;
    const r = await fetch(url, { headers: { "Accept-Language": "en" } });
    const d = await r.json();
    if (!Array.isArray(d) || d.length === 0) return null;
    const hit = d[0];
    const name = hit.address?.city || hit.address?.town || hit.address?.village || hit.display_name.split(",")[0];
    return { name, lat: parseFloat(hit.lat), lon: parseFloat(hit.lon) };
  } catch { return null; }
}

function toDisplay(temp: number, unit: "C" | "F") {
  return unit === "F" ? Math.round((temp * 9) / 5 + 32) : Math.round(temp);
}

/** Which cities to show based on zoom + bounds */
function visibleCities(map: L.Map): City[] {
  const b    = map.getBounds();
  const zoom = map.getZoom();
  const minPop = zoom >= 7 ? 1 : zoom >= 5 ? 2 : 3;
  const sep    = zoom >= 8 ? 0 : zoom >= 6 ? 2 : zoom >= 4 ? 5 : 12;

  const inBounds = CITIES.filter(c => c.pop >= minPop && b.contains([c.lat, c.lon]));
  if (sep === 0) return inBounds;

  const kept: City[] = [];
  for (const city of inBounds) {
    if (!kept.some(k => Math.abs(k.lat - city.lat) < sep && Math.abs(k.lon - city.lon) < sep))
      kept.push(city);
  }
  return kept;
}

// Per-session cache so panning never re-fetches
const cache = new Map<string, WeatherInfo>();
async function cachedWeather(city: City): Promise<WeatherInfo | null> {
  const key = `${city.lat},${city.lon}`;
  if (cache.has(key)) return cache.get(key)!;
  const w = await fetchWeather(city.lat, city.lon);
  if (w) { w.name = city.name; cache.set(key, w); }
  return w;
}

function cityIcon(code: number, temp: number, unit: "C" | "F") {
  const [, emoji] = wmo(code);
  const label = `${toDisplay(temp, unit)}°${unit}`;
  return L.divIcon({
    className: "weather-marker",
    html: `<div style="display:flex;flex-direction:column;align-items:center;">
      <div style="background:rgba(8,12,22,0.55);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.14);border-radius:12px;padding:4px 10px 4px 7px;display:flex;align-items:center;gap:5px;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.12);">
        <span style="font-size:16px;line-height:1;">${emoji}</span>
        <span style="font-size:13px;font-weight:600;color:#fff;letter-spacing:-0.2px;">${label}</span>
      </div>
      <div style="width:1.5px;height:5px;background:#60A5FA;opacity:.55;"></div>
      <div style="width:4px;height:4px;background:#60A5FA;border-radius:50%;"></div>
    </div>`,
    iconSize: [90, 52],
    iconAnchor: [45, 52],
    popupAnchor: [0, -56],
  });
}

function dropPinIcon() {
  return L.divIcon({
    className: "weather-marker",
    html: `<div style="display:flex;flex-direction:column;align-items:center;">
      <div style="width:14px;height:14px;background:#f97316;border:2.5px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.7);"></div>
      <div style="width:2px;height:10px;background:#f97316;"></div>
    </div>`,
    iconSize: [14, 26],
    iconAnchor: [7, 26],
    popupAnchor: [0, -28],
  });
}

/** Reads the real safe-area-inset-top in px at runtime by injecting a probe element. */
function useSafeAreaTop(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;pointer-events:none;top:env(safe-area-inset-top,0px);left:0;width:1px;height:1px;";
    document.documentElement.appendChild(el);
    const val = parseFloat(getComputedStyle(el).top) || 0;
    document.documentElement.removeChild(el);
    setInset(val);
  }, []);
  return inset;
}

function MapController({
  unit,
  hasPin,
  onMarkers,
  onPin,
  onClearPin,
  onLoading,
}: {
  unit: "C" | "F";
  hasPin: boolean;
  onMarkers: (m: WeatherInfo[]) => void;
  onPin: (p: WeatherInfo) => void;
  onClearPin: () => void;
  onLoading: (v: boolean) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (map: L.Map) => {
    const cities = visibleCities(map);
    if (!cities.length) return;
    onLoading(true);
    const results = await Promise.all(cities.map(cachedWeather));
    onMarkers(results.filter(Boolean) as WeatherInfo[]);
    onLoading(false);
  }, [onMarkers, onLoading]);

  const debounced = useCallback((map: L.Map) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => refresh(map), 650);
  }, [refresh]);

  const map = useMapEvents({
    moveend: () => debounced(map),
    zoomend: () => debounced(map),
    async click(e) {
      if (hasPin) { onClearPin(); return; }
      const { lat, lng } = e.latlng;
      const w = await fetchWeather(lat, lng);
      if (w) { w.name = "Pinned location"; onPin(w); }
    },
  });

  useEffect(() => { refresh(map); }, []);
  return null;
}

const IconMap = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="3,6 9,3 15,6 21,3 21,18 15,21 9,18 3,21"/>
    <line x1="9" y1="3" x2="9" y2="18"/>
    <line x1="15" y1="6" x2="15" y2="21"/>
  </svg>
);

const IconCities = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="10" width="8" height="12"/>
    <rect x="11" y="6" width="10" height="16"/>
    <line x1="3" y1="22" x2="21" y2="22"/>
    <line x1="7" y1="14" x2="7" y2="14" strokeWidth="2"/>
    <line x1="15" y1="10" x2="15" y2="10" strokeWidth="2"/>
    <line x1="15" y1="14" x2="15" y2="14" strokeWidth="2"/>
    <line x1="19" y1="10" x2="19" y2="10" strokeWidth="2"/>
    <line x1="19" y1="14" x2="19" y2="14" strokeWidth="2"/>
  </svg>
);

const TABS = [
  { id: "map"  as const, label: "Map",    Icon: IconMap    },
  { id: "list" as const, label: "Cities", Icon: IconCities },
];

const LiquidBar = ({
  activeTab,
  onTabChange,
}: {
  activeTab: "map" | "list";
  onTabChange: (t: "map" | "list") => void;
}) => {
  const activeIdx = TABS.findIndex(t => t.id === activeTab);

  return (
    <div style={{
      position: "absolute", bottom: `calc(18px + env(safe-area-inset-bottom, 0px))`,
      left: "50%", transform: "translateX(-50%)",
      zIndex: 1000, display: "flex", alignItems: "center",
      background: "rgba(255,255,255,0.07)",
      backdropFilter: "blur(40px) saturate(1.8)",
      WebkitBackdropFilter: "blur(40px) saturate(1.8)",
      border: "1px solid rgba(255,255,255,0.14)",
      borderRadius: 100,
      padding: 5,
      boxShadow: "0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.15)",
      gap: 2,
    }}>
      {/* Sliding droplet — width and position calculated to stay inside padding */}
      <div style={{
        position: "absolute",
        top: 5, bottom: 5,
        left: activeIdx === 0 ? 5 : "calc(50%)",
        width: "calc(50% - 5px)",
        background: "rgba(255,255,255,0.13)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderRadius: 100,
        border: "1px solid rgba(255,255,255,0.22)",
        boxShadow: "0 2px 12px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.25)",
        transition: "left 0.42s cubic-bezier(0.34,1.48,0.64,1)",
        pointerEvents: "none",
      }} />

      {TABS.map(({ id, label, Icon }) => {
        const active = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            style={{
              position: "relative", zIndex: 1,
              background: "none", border: "none", cursor: "pointer",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
              padding: "8px 28px",
              color: active ? "#fff" : "rgba(255,255,255,0.4)",
              transition: "color 0.25s ease",
              borderRadius: 100,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif",
            }}
          >
            <Icon />
            <span style={{
              fontSize: 10, fontWeight: active ? 600 : 400,
              letterSpacing: "0.03em",
              transition: "font-weight 0.2s",
            }}>{label}</span>
          </button>
        );
      })}
    </div>
  );
};

const StatusMsg = ({ children }: { children: React.ReactNode }) => (
  <div style={{ color: "#7B8AB0", fontSize: 13, textAlign: "center", marginTop: 40 }}>{children}</div>
);

const WeatherPopup = ({ w, unit, showCoords, onRemove }: {
  w: WeatherInfo; unit: "C" | "F"; showCoords?: boolean; onRemove?: () => void;
}) => {
  const [label, emoji] = wmo(w.code);
  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif", minWidth: 155 }}>
      {showCoords && <div style={{ fontSize: 10, color: "#aaa", marginBottom: 3 }}>{w.lat.toFixed(3)}, {w.lon.toFixed(3)}</div>}
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 1 }}>{w.name}</div>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>{emoji} {label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 5 }}>{toDisplay(w.temp, unit)}°{unit}</div>
      <div style={{ fontSize: 12, color: "#777", display: "flex", gap: 8, flexWrap: "wrap" }}>
        <span>🌡 Feels {toDisplay(w.feels_like, unit)}°{unit}</span>
        <span>💧 {w.humidity}%</span>
        <span>💨 {w.wind} m/s</span>
      </div>
      {showCoords && (
        <div style={{ marginTop: 8, fontSize: 10, color: "#aaa" }}>Tap map to remove</div>
      )}
    </div>
  );
};

const CityCard = ({ w, unit }: { w: WeatherInfo; unit: "C" | "F" }) => {
  const [label, emoji] = wmo(w.code);
  return (
    <div style={{
      background: "rgba(15,22,42,0.45)",
      backdropFilter: "blur(20px) saturate(1.5)",
      WebkitBackdropFilter: "blur(20px) saturate(1.5)",
      border: "1px solid rgba(255,255,255,0.09)",
      borderRadius: 18, padding: "14px 18px",
      display: "flex", alignItems: "center", justifyContent: "space-between",
    }}>
      <div>
        <div style={{ fontFamily: "inherit", fontSize: 16, fontWeight: 600, marginBottom: 2, color: "#EEF1FA", letterSpacing: "-0.3px" }}>{w.name}</div>
        <div style={{ fontSize: 12, color: "#7B8AB0" }}>{emoji} {label}</div>
        <div style={{ display: "flex", gap: 10, marginTop: 5, fontSize: 12, color: "#7B8AB0" }}>
          <span>💧 {w.humidity}%</span>
          <span>💨 {w.wind} m/s</span>
        </div>
      </div>
      <div style={{ fontFamily: "inherit", fontSize: 28, fontWeight: 800, color: "#60A5FA", letterSpacing: "-1px" }}>
        {toDisplay(w.temp, unit)}°{unit}
      </div>
    </div>
  );
};

const PinMarker = ({ pin, unit, onRemove }: { pin: WeatherInfo; unit: "C" | "F"; onRemove: () => void }) => {
  const markerRef = useRef<L.Marker | null>(null);
  useEffect(() => {
    markerRef.current?.openPopup();
  }, [pin.lat, pin.lon]);
  return (
    <Marker position={[pin.lat, pin.lon]} icon={dropPinIcon()} ref={markerRef}>
      <Popup closeButton={false}>
        <WeatherPopup w={pin} unit={unit} showCoords onRemove={onRemove} />
      </Popup>
    </Marker>
  );
};

const App = () => {
  const [markers, setMarkers]   = useState<WeatherInfo[]>([]);
  const [pin, setPin]           = useState<WeatherInfo | null>(null);
  const [unit, setUnit]         = useState<"C" | "F">("C");
  const [activeTab, setActiveTab] = useState<"map" | "list">("map");
  const [loading, setLoading]   = useState(false);

  const [listData, setListData]   = useState<WeatherInfo[]>([]);
  const [listLoading, setListLoading] = useState(true);

  const [search, setSearch]         = useState("");
  const [searchResult, setSearchResult] = useState<WeatherInfo | "none" | null>(null);
  const [searching, setSearching]   = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed list with megacities on load
  useEffect(() => {
    const seeds = CITIES.filter(c => c.pop === 3).slice(0, 16);
    Promise.all(seeds.map(cachedWeather)).then(results => {
      setListData(results.filter(Boolean) as WeatherInfo[]);
      setListLoading(false);
    });
  }, []);

  // Sync list with map markers when no search active
  useEffect(() => {
    if (markers.length && !search.trim()) setListData(markers);
  }, [markers]);

  function handleSearch(q: string) {
    setSearch(q);
    setSearchResult(null);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) return;
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      const loc = await geocode(q);
      if (!loc) { setSearchResult("none"); setSearching(false); return; }
      const w = await fetchWeather(loc.lat, loc.lon);
      if (w) { w.name = loc.name; setSearchResult(w); }
      else setSearchResult("none");
      setSearching(false);
    }, 500);
  }

  const showSearch  = search.trim().length > 0;
  const displayList = showSearch
    ? (searchResult && searchResult !== "none" ? [searchResult] : [])
    : listData;

  const safeTop = useSafeAreaTop();
  // Guarantee at least 10px clearance above the pill
  const pillTop = safeTop + 10;

  return (
    <div style={{
      width: "100%", height: "100%", background: "#07090F",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', 'Helvetica Neue', sans-serif",
      overflow: "hidden", position: "relative",
    }}>

      {/* MAP — fills entire screen, always mounted */}
      <div style={{
        position: "fixed", inset: 0,
        display: activeTab === "map" ? "block" : "none",
      }}>
        <MapContainer
          center={[20, 10]} zoom={3} zoomControl={false}
          style={{ width: "100%", height: "100%" }}
          minZoom={2} maxZoom={14}
          maxBounds={WORLD} maxBoundsViscosity={1.0}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            bounds={WORLD}
          />
          <MapController unit={unit} hasPin={!!pin} onMarkers={setMarkers} onPin={setPin} onClearPin={() => setPin(null)} onLoading={setLoading} />

          {markers.map(w => (
            <Marker key={`${w.lat}-${w.lon}`} position={[w.lat, w.lon]}
              icon={cityIcon(w.code, w.temp, unit)}>
              <Popup closeButton={false}>
                <WeatherPopup w={w} unit={unit} />
              </Popup>
            </Marker>
          ))}

          {pin && <PinMarker pin={pin} unit={unit} onRemove={() => setPin(null)} />}
        </MapContainer>

        {/* Unit toggle — circular, mid-left */}
        <button onClick={() => setUnit(u => u === "C" ? "F" : "C")} style={{
          position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)",
          zIndex: 1000, width: 44, height: 44, borderRadius: "50%",
          background: "rgba(8,12,22,0.92)", border: "1.5px solid rgba(96,165,250,0.45)",
          color: "#60A5FA", fontSize: 13, fontWeight: 700, cursor: "pointer",
          fontFamily: "'Inter',sans-serif", backdropFilter: "blur(10px)",
          boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          °{unit === "C" ? "F" : "C"}
        </button>

        {/* Top fade — subtle only */}
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0,
          height: pillTop + 60,
          background: "linear-gradient(to bottom, rgba(7,9,15,0.55) 0%, transparent 100%)",
          pointerEvents: "none", zIndex: 999,
        }} />

        {/* Hint pill */}
        <div style={{
          position: "absolute", top: pillTop,
          left: "50%", transform: "translateX(-50%)",
          zIndex: 1000,
          background: "rgba(8,12,22,0.35)",
          backdropFilter: "blur(16px) saturate(1.4)",
          WebkitBackdropFilter: "blur(16px) saturate(1.4)",
          border: "1px solid rgba(255,255,255,0.12)", borderRadius: 100,
          padding: "5px 16px", fontSize: 11, color: "rgba(255,255,255,0.6)",
          whiteSpace: "nowrap", pointerEvents: "none",
        }}>
          {loading ? "Loading…" : pin ? "Tap anywhere to remove pin" : "Tap anywhere to drop a pin"}
        </div>
      </div>

      {/* CITIES / SEARCH */}
      {activeTab === "list" && (
        <div style={{
          position: "fixed", inset: 0,
          display: "flex", flexDirection: "column",
          background: "rgba(7,9,15,0.75)",
          backdropFilter: "blur(30px)",
          WebkitBackdropFilter: "blur(30px)",
          paddingTop: safeTop,
        }}>
          <div style={{ padding: "12px 16px 8px" }}>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 15, pointerEvents: "none" }}>🔍</span>
              <input
                type="text" placeholder="Search a city…" value={search}
                onChange={e => handleSearch(e.target.value)}
                style={{
                  width: "100%",
                  background: "rgba(15,22,42,0.45)",
                  backdropFilter: "blur(20px) saturate(1.5)",
                  WebkitBackdropFilter: "blur(20px) saturate(1.5)",
                  border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14,
                  padding: "11px 36px 11px 36px", color: "#EEF1FA",
                  fontSize: 14, fontFamily: "'Inter',sans-serif", outline: "none", boxSizing: "border-box",
                }}
              />
              {searching && <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "#7B8AB0" }}>…</span>}
              {search && !searching && (
                <button onClick={() => { setSearch(""); setSearchResult(null); }}
                  style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#7B8AB0", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 2 }}>✕</button>
              )}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "0 16px", paddingBottom: "calc(100px + env(safe-area-inset-bottom, 0px))", display: "flex", flexDirection: "column", gap: 10 }}>
            {showSearch && searching && <StatusMsg>Searching…</StatusMsg>}
            {showSearch && !searching && searchResult === "none" && <StatusMsg>No results for "{search}"</StatusMsg>}
            {!showSearch && listLoading && <StatusMsg>Loading weather…</StatusMsg>}
            {displayList.map((w, i) => <CityCard key={`${w.lat}-${w.lon}-${i}`} w={w} unit={unit} />)}
          </div>
        </div>
      )}

      {/* LIQUID GLASS CAPSULE BAR */}
      <LiquidBar activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  );
};

export default App;

