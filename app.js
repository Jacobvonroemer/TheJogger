"use strict";

const DB_NAME = "jogging-db";
const STORE_NAME = "runs";
const MAX_ACCURACY = 50;
const MIN_SEGMENT_METERS = 3;
const SPORTS = {
  running: { label: "Laufen", short: "Lauf", symbol: "●", maxSpeed: 8 },
  cycling: { label: "Radfahren", short: "Rad", symbol: "▲", maxSpeed: 28 },
  swimming: { label: "Schwimmen", short: "Schwimmen", symbol: "≈", maxSpeed: 3 },
  other: { label: "Sonstiges", short: "Sonstiges", symbol: "+", maxSpeed: 28 }
};

const $ = (selector) => document.querySelector(selector);
const views = [...document.querySelectorAll(".view")];
let runs = [];
let activeRun = null;
let watchId = null;
let timerId = null;
let wakeLock = null;
let detailMap = null;
let selectedRun = null;
let selectedTrackingSport = "running";
let mapResizeObserver = null;

function sportOf(run) {
  return SPORTS[run.sport] ? run.sport : "running";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbRequest(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = action(tx.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

const getRuns = () => dbRequest("readonly", (store) => store.getAll());
const saveRun = (run) => dbRequest("readwrite", (store) => store.put(run));
const removeRun = (id) => dbRequest("readwrite", (store) => store.delete(id));

function showView(id) {
  views.forEach((view) => view.classList.toggle("active", view.id === id));
  scrollTo({ top: 0, behavior: "smooth" });
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 2600);
}

function formatDate(dateString) {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${dateString}T12:00:00`));
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "–";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function formatPace(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "–:––";
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2,"0")}`;
}

function formatActivityMetric(run) {
  const sport = sportOf(run);
  if (!run.durationSeconds || !run.distanceMeters) return null;
  if (sport === "cycling") {
    const kmh = (run.distanceMeters / 1000) / (run.durationSeconds / 3600);
    return `${kmh.toLocaleString("de-DE", { maximumFractionDigits: 1 })} km/h`;
  }
  const pace = run.durationSeconds / (run.distanceMeters / 1000);
  if (sport === "swimming") return `${formatPace(pace / 10)} /100 m`;
  return `${formatPace(pace)} min/km`;
}

function distanceText(run) {
  if (sportOf(run) === "swimming" && run.laps) return `${run.laps} Bahnen · ${(run.distanceMeters).toLocaleString("de-DE")} m`;
  if (!run.distanceMeters) return "ohne Strecke";
  return `${(run.distanceMeters / 1000).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;
}

function renderRuns() {
  runs.sort((a, b) => new Date(b.startedAt || b.date) - new Date(a.startedAt || a.date));
  $("#runCount").textContent = runs.length ? `${runs.length} ${runs.length === 1 ? "Aktivität" : "Aktivitäten"}` : "";
  $("#emptyState").hidden = runs.length > 0;
  $("#runList").replaceChildren(...runs.map((run) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.className = "run-row";
    button.dataset.id = run.id;
    const sport = sportOf(run);
    const summary = [distanceText(run)];
    if (run.durationSeconds) summary.push(formatDuration(run.durationSeconds));
    const metric = formatActivityMetric(run);
    if (metric) summary.push(metric);
    if (run.location) summary.push(run.location);
    if (run.source === "manual") summary.push("manuell");
    button.innerHTML = `<span class="run-date"><span class="sport-dot" aria-hidden="true">${SPORTS[sport].symbol}</span>${SPORTS[sport].label} · ${formatDate(run.date)}</span><span class="run-summary">${summary.join(" · ")}</span><span class="run-arrow" aria-hidden="true">›</span>`;
    li.append(button);
    return li;
  }));
}

function haversine(a, b) {
  const R = 6371000;
  const rad = (n) => n * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

async function requestWakeLock() {
  try { if ("wakeLock" in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request("screen"); } catch (_) { /* optional */ }
}

function updateLiveMetrics() {
  if (!activeRun) return;
  const seconds = Math.max(0, Math.floor((Date.now() - activeRun.startedAtMs) / 1000));
  $("#liveDuration").textContent = formatDuration(seconds);
  $("#liveDistance").textContent = (activeRun.distanceMeters / 1000).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pace = activeRun.distanceMeters >= 50 ? seconds / (activeRun.distanceMeters / 1000) : null;
  if (activeRun.sport === "cycling") {
    const speed = pace ? 3600 / pace : null;
    $("#livePace").textContent = speed ? `${speed.toLocaleString("de-DE", { maximumFractionDigits: 1 })} km/h` : "– km/h";
  } else {
    $("#livePace").textContent = pace ? `${formatPace(pace)} /km` : "–:–– /km";
  }
}

function onPosition(position) {
  if (!activeRun) return;
  const point = { lat: position.coords.latitude, lon: position.coords.longitude, timestamp: position.timestamp, accuracy: Math.round(position.coords.accuracy) };
  $("#accuracyText").textContent = `GPS-Genauigkeit: ${point.accuracy} m`;
  if (point.accuracy > MAX_ACCURACY) { $("#trackingStatus").innerHTML = '<span class="pulse"></span> Ungenaue Position'; return; }
  const previous = activeRun.points.at(-1);
  if (!previous) {
    activeRun.points.push(point);
    $("#trackingStatus").innerHTML = '<span class="pulse"></span> GPS aktiv';
    return;
  }
  const meters = haversine(previous, point);
  const seconds = Math.max(1, (point.timestamp - previous.timestamp) / 1000);
  if (meters < MIN_SEGMENT_METERS || meters / seconds > SPORTS[activeRun.sport].maxSpeed) return;
  activeRun.points.push(point);
  activeRun.distanceMeters += meters;
  updateLiveMetrics();
}

function onPositionError(error) {
  const messages = { 1: "Standortzugriff wurde abgelehnt", 2: "GPS-Signal nicht verfügbar", 3: "GPS-Suche dauert länger" };
  $("#trackingStatus").innerHTML = `<span class="pulse"></span> ${messages[error.code] || "GPS-Fehler"}`;
}

async function startTracking() {
  if (!navigator.geolocation) return toast("GPS wird von diesem Browser nicht unterstützt.");
  activeRun = { id: crypto.randomUUID(), date: new Date().toISOString().slice(0,10), startedAt: new Date().toISOString(), startedAtMs: Date.now(), distanceMeters: 0, points: [], source: "gps", sport: selectedTrackingSport, hiddenDuringRun: false };
  $("#backgroundWarning").hidden = true;
  $("#liveDistance").textContent = "0,00";
  $("#liveDuration").textContent = "00:00";
  $("#livePace").textContent = "–:–– /km";
  $("#trackingTitle").textContent = `${SPORTS[selectedTrackingSport].label} wird aufgezeichnet`;
  $("#liveMetricLabel").textContent = selectedTrackingSport === "cycling" ? "Ø Tempo" : "Ø Pace";
  showView("trackingView");
  await requestWakeLock();
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
  timerId = setInterval(updateLiveMetrics, 1000);
}

async function stopTracking() {
  if (!activeRun) return;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  clearInterval(timerId);
  if (wakeLock) { try { await wakeLock.release(); } catch (_) {} wakeLock = null; }
  const durationSeconds = Math.max(1, Math.floor((Date.now() - activeRun.startedAtMs) / 1000));
  const run = { id: activeRun.id, date: activeRun.date, startedAt: activeRun.startedAt, durationSeconds, distanceMeters: Math.round(activeRun.distanceMeters), averagePaceSecondsPerKm: activeRun.distanceMeters >= 50 ? Math.round(durationSeconds / (activeRun.distanceMeters / 1000)) : null, source: "gps", sport: activeRun.sport, points: activeRun.points };
  activeRun = null; watchId = null;
  await saveRun(run);
  runs.unshift(run); renderRuns(); showDetail(run); toast("Aktivität lokal gespeichert");
}

function showDetail(run) {
  selectedRun = run;
  const sport = sportOf(run);
  $("#detailSport").textContent = SPORTS[sport].label;
  $("#detailTitle").textContent = formatDate(run.date);
  const metricLabel = sport === "cycling" ? "Ø Tempo" : sport === "swimming" ? "Ø /100 m" : "Ø Pace";
  const extras = [run.location, run.note].filter(Boolean).map((text) => `<p>${text.replace(/[<>&]/g, "")}</p>`).join("");
  $("#detailMetrics").innerHTML = `<div><span>Strecke</span><strong>${distanceText(run)}</strong></div><div><span>Dauer</span><strong>${formatDuration(run.durationSeconds)}</strong></div><div><span>${metricLabel}</span><strong>${formatActivityMetric(run) || "–"}</strong></div>${extras ? `<div class="detail-note"><span>Notiz</span>${extras}</div>` : ""}`;
  const hasRoute = run.source === "gps" && run.points?.length > 1;
  $("#mapWrap").hidden = !hasRoute;
  $("#shareButton").hidden = !hasRoute;
  if (detailMap) { detailMap.remove(); detailMap = null; }
  if (mapResizeObserver) { mapResizeObserver.disconnect(); mapResizeObserver = null; }
  showView("detailView");
  if (hasRoute && window.L) {
    const coords = run.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)).map((p) => [p.lat, p.lon]);
    const initializeMap = () => {
      detailMap = L.map("map", { zoomControl:true, attributionControl:false, preferCanvas:true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom:19, crossOrigin:true, updateWhenIdle:true, keepBuffer:1 }).addTo(detailMap);
      const line = L.polyline(coords, { color:"#ffffff", weight:10, opacity:.95 }).addTo(detailMap);
      L.polyline(coords, { color:"#e45438", weight:6, opacity:1 }).addTo(detailMap);
      L.circleMarker(coords[0], { radius:7, color:"#fff", weight:3, fillColor:"#1d6b4d", fillOpacity:1 }).addTo(detailMap).bindTooltip("Start");
      L.circleMarker(coords.at(-1), { radius:7, color:"#fff", weight:3, fillColor:"#17211b", fillOpacity:1 }).addTo(detailMap).bindTooltip("Ziel");
      const fitRoute = () => { detailMap.invalidateSize({ pan:false }); detailMap.fitBounds(line.getBounds(), { padding:[38,38], maxZoom:17, animate:false }); };
      fitRoute();
      setTimeout(fitRoute, 150);
      setTimeout(fitRoute, 700);
      mapResizeObserver = new ResizeObserver(() => detailMap && fitRoute());
      mapResizeObserver.observe($("#map"));
    };
    requestAnimationFrame(() => requestAnimationFrame(initializeMap));
  }
}

function parseDuration(value) {
  if (!value) return null;
  const [minutes, seconds] = value.split(":").map(Number);
  return minutes * 60 + seconds;
}

async function addManualRun(event) {
  event.preventDefault();
  const sport = $("#manualSport").value;
  const laps = sport === "swimming" ? Number($("#manualLaps").value) : null;
  const rawDistance = $("#manualDistance").value.trim();
  const distanceMeters = sport === "swimming" ? laps * 50 : rawDistance ? Math.round(Number(rawDistance.replace(",",".")) * 1000) : 0;
  if (!Number.isFinite(distanceMeters) || (sport !== "other" && distanceMeters <= 0)) return toast("Bitte eine Strecke eintragen");
  const durationSeconds = parseDuration($("#manualDuration").value);
  const run = { id: crypto.randomUUID(), date: $("#manualDate").value, startedAt: `${$("#manualDate").value}T12:00:00`, durationSeconds, distanceMeters, averagePaceSecondsPerKm: durationSeconds ? Math.round(durationSeconds/(distanceMeters/1000)) : null, source:"manual", sport, laps, location:$("#manualLocation").value.trim(), note:$("#manualNote").value.trim(), points:[] };
  await saveRun(run); runs.unshift(run); renderRuns(); event.target.reset(); showView("homeView"); toast("Aktivität eingetragen");
}

function exportData() {
  const blob = new Blob([JSON.stringify({ exportedAt:new Date().toISOString(), runs }, null, 2)], { type:"application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `sportler-backup-${new Date().toISOString().slice(0,10)}.json`; link.click(); URL.revokeObjectURL(link.href);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.runs)) throw new Error("invalid");
    const valid = data.runs.filter((run) => run && run.id && run.date && Number.isFinite(run.distanceMeters));
    if (!valid.length) throw new Error("empty");
    for (const run of valid) await saveRun({ ...run, sport: sportOf(run), points: Array.isArray(run.points) ? run.points : [] });
    runs = await getRuns(); renderRuns(); toast(`${valid.length} Aktivitäten importiert`);
  } catch (_) { toast("Diese Backup-Datei ist nicht gültig"); }
}

async function shareCard() {
  if (!selectedRun?.points?.length) return;
  const canvas = document.createElement("canvas"); canvas.width=1200; canvas.height=1200; const ctx=canvas.getContext("2d");
  ctx.fillStyle="#f4f1e9"; ctx.fillRect(0,0,1200,1200); ctx.fillStyle="#17211b"; ctx.font="800 48px system-ui"; ctx.fillText(`SPORTLER · ${SPORTS[sportOf(selectedRun)].label.toUpperCase()}`,80,100);
  ctx.font="800 110px system-ui"; ctx.fillText(`${(selectedRun.distanceMeters/1000).toLocaleString("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2})} km`,80,240);
  ctx.font="500 38px system-ui"; ctx.fillStyle="#677069"; ctx.fillText(`${formatDate(selectedRun.date)}   ·   ${formatDuration(selectedRun.durationSeconds)}   ·   ${formatActivityMetric(selectedRun) || ""}`,85,315);
  const pts=selectedRun.points; const lats=pts.map(p=>p.lat), lons=pts.map(p=>p.lon); const minLat=Math.min(...lats), maxLat=Math.max(...lats), minLon=Math.min(...lons), maxLon=Math.max(...lons); const w=Math.max(maxLon-minLon,.00001), h=Math.max(maxLat-minLat,.00001); const scale=Math.min(900/w,650/h);
  ctx.strokeStyle="#d9d7ce"; ctx.lineWidth=2; for(let i=0;i<6;i++){ctx.beginPath();ctx.moveTo(80,400+i*125);ctx.lineTo(1120,400+i*125);ctx.stroke();}
  ctx.beginPath(); pts.forEach((p,i)=>{const x=600+(p.lon-(minLon+maxLon)/2)*scale;const y=735-(p.lat-(minLat+maxLat)/2)*scale; i?ctx.lineTo(x,y):ctx.moveTo(x,y);}); ctx.strokeStyle="#fff";ctx.lineWidth=26;ctx.lineCap="round";ctx.lineJoin="round";ctx.stroke();ctx.strokeStyle="#e45438";ctx.lineWidth=15;ctx.stroke();
  ctx.fillStyle="#17211b";ctx.font="500 26px system-ui";ctx.fillText("Aufgezeichnet mit Sportler · Daten bleiben lokal",80,1130);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png")); const file=new File([blob],`sport-${selectedRun.date}.png`,{type:"image/png"});
  if(navigator.canShare?.({files:[file]})){await navigator.share({files:[file],title:"Meine Aktivität"});} else {const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download=file.name;link.click();URL.revokeObjectURL(link.href);}
}

$("#startButton").addEventListener("click", startTracking);
$("#stopButton").addEventListener("click", stopTracking);
document.querySelectorAll("[data-tracking-sport]").forEach((button) => button.addEventListener("click", () => {
  selectedTrackingSport = button.dataset.trackingSport;
  document.querySelectorAll("[data-tracking-sport]").forEach((item) => { const selected=item===button; item.classList.toggle("selected", selected); item.setAttribute("aria-pressed", String(selected)); });
}));
function updateManualFields() {
  const sport = $("#manualSport").value;
  const swimming = sport === "swimming";
  const other = sport === "other";
  $("#distanceField").hidden = swimming;
  $("#lapsField").hidden = !swimming;
  $("#locationField").hidden = !swimming;
  $("#distanceLabel").textContent = other ? "Strecke in km (optional)" : "Strecke in km";
  $("#manualDistance").required = !swimming && !other;
  $("#manualLaps").required = swimming;
}
$("#manualButton").addEventListener("click", () => { $("#manualDate").value = new Date().toISOString().slice(0,10); updateManualFields(); showView("manualView"); });
$("#manualSport").addEventListener("change", updateManualFields);
$("#manualForm").addEventListener("submit", addManualRun);
$("#exportButton").addEventListener("click", exportData);
$("#importInput").addEventListener("change", (event) => { const [file]=event.target.files; if(file) importData(file); event.target.value=""; });
$("#shareButton").addEventListener("click", () => shareCard().catch(() => toast("Bild konnte nicht geteilt werden")));
$("#deleteButton").addEventListener("click", async () => { if (!selectedRun || !confirm("Diese Aktivität wirklich löschen?")) return; await removeRun(selectedRun.id); runs=runs.filter(r=>r.id!==selectedRun.id); renderRuns(); showView("homeView"); toast("Aktivität gelöscht"); });
$("#runList").addEventListener("click", (event) => { const button=event.target.closest("[data-id]"); if(button) showDetail(runs.find(r=>r.id===button.dataset.id)); });
document.querySelectorAll("[data-back]").forEach((button) => button.addEventListener("click", () => showView("homeView")));
document.addEventListener("visibilitychange", async () => { if (!activeRun) return; if(document.hidden){activeRun.hiddenDuringRun=true;$("#backgroundWarning").hidden=false;} else {wakeLock=null;await requestWakeLock();} });
addEventListener("online", updateNetwork); addEventListener("offline", updateNetwork);
function updateNetwork(){ $("#offlineBadge").hidden=navigator.onLine; }

(async function init(){ updateNetwork(); try { runs=(await getRuns()).map((run)=>({ ...run, sport:sportOf(run) })); renderRuns(); } catch (_) { toast("Lokaler Speicher ist nicht verfügbar"); } if("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{}); })();
