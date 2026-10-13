"use strict";

const DB_NAME = "jogging-db";
const STORE_NAME = "runs";
const WEIGHT_STORE = "weights";
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
let weights = [];
let activeRun = null;
let watchId = null;
let timerId = null;
let wakeLock = null;
let detailMap = null;
let selectedRun = null;
let selectedTrackingSport = "running";
let mapResizeObserver = null;
let profileTimerId = null;
let routingInFlight = false;

function sportOf(run) {
  return SPORTS[run.sport] ? run.sport : "running";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(WEIGHT_STORE)) db.createObjectStore(WEIGHT_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbRequest(storeName, mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

const getRuns = () => dbRequest(STORE_NAME, "readonly", (store) => store.getAll());
const saveRun = (run) => dbRequest(STORE_NAME, "readwrite", (store) => store.put(run));
const removeRun = (id) => dbRequest(STORE_NAME, "readwrite", (store) => store.delete(id));
const getWeights = () => dbRequest(WEIGHT_STORE, "readonly", (store) => store.getAll());
const saveWeight = (entry) => dbRequest(WEIGHT_STORE, "readwrite", (store) => store.put(entry));
const removeWeight = (id) => dbRequest(WEIGHT_STORE, "readwrite", (store) => store.delete(id));

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

function renderWeights() {
  weights.sort((a,b)=>a.date.localeCompare(b.date));
  $("#weightEmpty").hidden = weights.length > 0;
  $("#weightSummary").textContent = weights.length ? `${weights.at(-1).kg.toLocaleString("de-DE",{minimumFractionDigits:1,maximumFractionDigits:1})} kg aktuell` : "";
  $("#weightList").replaceChildren(...[...weights].reverse().map((entry)=>{
    const li=document.createElement("li");
    li.innerHTML=`<span>${formatDate(entry.date)}</span><strong>${entry.kg.toLocaleString("de-DE",{minimumFractionDigits:1,maximumFractionDigits:1})} kg</strong><button class="weight-delete" data-weight-id="${entry.id}" aria-label="Gewicht vom ${formatDate(entry.date)} löschen">Löschen</button>`;
    return li;
  }));
  drawWeightChart();
}

function drawWeightChart() {
  const canvas=$("#weightChart"); if(!canvas)return;
  const ratio=Math.min(devicePixelRatio||1,2), width=Math.max(280,canvas.clientWidth||320), height=220;
  canvas.width=width*ratio;canvas.height=height*ratio;const ctx=canvas.getContext("2d");ctx.scale(ratio,ratio);ctx.clearRect(0,0,width,height);
  const pad={left:44,right:16,top:22,bottom:32},w=width-pad.left-pad.right,h=height-pad.top-pad.bottom;
  ctx.font="10px system-ui";ctx.fillStyle="#677069";ctx.strokeStyle="#e3e0d7";
  if(!weights.length){ctx.textAlign="center";ctx.fillText("Dein Verlauf erscheint hier",width/2,height/2);return;}
  const values=weights.map((x)=>x.kg),min=Math.floor(Math.min(...values)-1),max=Math.ceil(Math.max(...values)+1),range=Math.max(1,max-min);
  for(let i=0;i<4;i++){const y=pad.top+i*h/3;ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(width-pad.right,y);ctx.stroke();ctx.textAlign="right";ctx.fillText(`${Math.round(max-i*range/3)} kg`,pad.left-6,y+3);}
  const x=(i)=>pad.left+(weights.length===1?.5:i/(weights.length-1))*w,y=(kg)=>pad.top+h-(kg-min)/range*h;
  ctx.beginPath();weights.forEach((entry,i)=>i?ctx.lineTo(x(i),y(entry.kg)):ctx.moveTo(x(i),y(entry.kg)));ctx.strokeStyle="#1d6b4d";ctx.lineWidth=3;ctx.stroke();
  weights.forEach((entry,i)=>{ctx.beginPath();ctx.arc(x(i),y(entry.kg),4,0,Math.PI*2);ctx.fillStyle="#1d6b4d";ctx.fill();});
  ctx.fillStyle="#677069";ctx.textAlign="left";ctx.fillText(formatDate(weights[0].date).slice(0,5),pad.left,height-8);ctx.textAlign="right";ctx.fillText(formatDate(weights.at(-1).date).slice(0,5),width-pad.right,height-8);
}

async function addWeight(event) {
  event.preventDefault();
  const value=Number($("#weightKg").value.replace(",","."));
  if(!Number.isFinite(value)||value<20||value>400)return toast("Bitte ein plausibles Gewicht eingeben");
  const entry={id:$("#weightDate").value,date:$("#weightDate").value,kg:Math.round(value*10)/10};
  await saveWeight(entry);weights=weights.filter((x)=>x.id!==entry.id);weights.push(entry);renderWeights();$("#weightKg").value="";toast("Gewicht lokal gespeichert");
}

function haversine(a, b) {
  const R = 6371000;
  const rad = (n) => n * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

function drawLineChart(canvas, samples) {
  if (!canvas) return;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const width = Math.max(280, canvas.clientWidth || 320);
  const height = 142;
  canvas.width = width * ratio; canvas.height = height * ratio;
  const ctx = canvas.getContext("2d"); ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height);
  const pad = { left:36, right:36, top:16, bottom:26 };
  const chartW = width - pad.left - pad.right, chartH = height - pad.top - pad.bottom;
  ctx.strokeStyle = "#e3e0d7"; ctx.lineWidth = 1; ctx.fillStyle = "#788078"; ctx.font = "10px system-ui";
  for (let i=0;i<4;i++) { const y=pad.top+i*chartH/3; ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(width-pad.right,y);ctx.stroke(); }
  if (!samples?.length) { ctx.textAlign="center"; ctx.fillText("Nach der ersten Minute erscheint der Verlauf", width/2, height/2); return; }
  const maxTime = Math.max(60, samples.at(-1).elapsedSeconds);
  const elevations = samples.map((s)=>s.altitude).filter(Number.isFinite);
  const speeds = samples.map((s)=>s.speedKmh).filter(Number.isFinite);
  const minElev = elevations.length ? Math.floor(Math.min(...elevations)-2) : 0;
  const maxElev = elevations.length ? Math.ceil(Math.max(...elevations)+2) : 1;
  const maxSpeed = Math.max(5, speeds.length ? Math.ceil(Math.max(...speeds)*1.15) : 5);
  const xFor = (s) => pad.left + (s.elapsedSeconds/maxTime)*chartW;
  const line = (key, color, min, max) => { const valid=samples.filter((s)=>Number.isFinite(s[key])); if(!valid.length)return; ctx.beginPath();valid.forEach((s,i)=>{const x=xFor(s),y=pad.top+chartH-(s[key]-min)/Math.max(1,max-min)*chartH;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.strokeStyle=color;ctx.lineWidth=3;ctx.lineJoin="round";ctx.lineCap="round";ctx.stroke(); };
  line("altitude", "#1d6b4d", minElev, maxElev); line("speedKmh", "#e45438", 0, maxSpeed);
  ctx.fillStyle="#677069";ctx.textAlign="left";ctx.fillText(`${minElev} m`,2,height-pad.bottom);ctx.fillText(`${maxElev} m`,2,pad.top+4);
  ctx.textAlign="right";ctx.fillText("0 km/h",width-2,height-pad.bottom);ctx.fillText(`${maxSpeed} km/h`,width-2,pad.top+4);
  ctx.textAlign="left";ctx.fillText("0",pad.left,height-7);ctx.textAlign="right";ctx.fillText(`${Math.ceil(maxTime/60)} min`,width-pad.right,height-7);
}

function sampleProfile() {
  if (!activeRun?.points.length) return;
  const point = activeRun.latestPosition || activeRun.points.at(-1);
  const previous = activeRun.points.at(-1) === point ? activeRun.points.at(-2) : activeRun.points.at(-1);
  const elapsedSeconds = Math.max(0, Math.round((point.timestamp-activeRun.startedAtMs)/1000));
  let speedMps = Number.isFinite(point.speed) && point.speed >= 0 ? point.speed : null;
  if (speedMps === null && previous) speedMps = haversine(previous,point)/Math.max(1,(point.timestamp-previous.timestamp)/1000);
  const sample = { elapsedSeconds, altitude:Number.isFinite(point.altitude)?point.altitude:null, speedKmh:Number.isFinite(speedMps)?speedMps*3.6:null };
  const last = activeRun.profile.at(-1);
  if (!last || elapsedSeconds-last.elapsedSeconds >= 45) activeRun.profile.push(sample);
  drawLineChart($("#liveProfile"), activeRun.profile);
  $("#profileUpdated").textContent = `Minute ${Math.max(1,Math.ceil(elapsedSeconds/60))}`;
}

async function updateShortCircuit() {
  if (!activeRun?.points.length || routingInFlight) return;
  const start = activeRun.points[0], current = activeRun.latestPosition || activeRun.points.at(-1);
  if (start === current) return;
  routingInFlight = true;
  $("#shortCircuitStatus").textContent = "berechnet …";
  const directMeters = haversine(current,start);
  let homeMeters = directMeters, source = "Luftlinie";
  try {
    const profile = activeRun.sport === "cycling" ? "routed-bike" : "routed-foot";
    const url = `https://routing.openstreetmap.de/${profile}/route/v1/driving/${current.lon},${current.lat};${start.lon},${start.lat}?overview=false&steps=false`;
    const controller = new AbortController(); const timeout = setTimeout(()=>controller.abort(),10000);
    const response = await fetch(url,{signal:controller.signal}); clearTimeout(timeout);
    if (!response.ok) throw new Error("routing");
    const data = await response.json();
    if (!Number.isFinite(data.routes?.[0]?.distance)) throw new Error("route");
    homeMeters = data.routes[0].distance; source = activeRun.sport === "cycling" ? "OSM-Radroute" : "OSM-Fußweg";
  } catch (_) { source = "nur Luftlinie"; }
  if (activeRun) {
    activeRun.shortCircuit = { timestamp:Date.now(), homeMeters:Math.round(homeMeters), projectedMeters:Math.round(activeRun.distanceMeters+homeMeters), source };
    $("#routeHomeDistance").textContent = `${(homeMeters/1000).toLocaleString("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2})} km`;
    $("#projectedTotal").textContent = `${((activeRun.distanceMeters+homeMeters)/1000).toLocaleString("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2})} km`;
    $("#shortCircuitStatus").textContent = source;
  }
  routingInFlight = false;
}

function refreshMinuteFeatures() { sampleProfile(); updateShortCircuit(); }

function drawRouteFallback(points) {
  const canvas=$("#routeFallback"), map=$("#map");
  const coords=(points||[]).filter((p)=>Number.isFinite(p.lat)&&Number.isFinite(p.lon));
  if(!canvas||coords.length<2)return;
  const ratio=Math.min(devicePixelRatio||1,2),width=Math.max(280,map.clientWidth||320),height=Math.max(260,map.clientHeight||330);
  canvas.width=width*ratio;canvas.height=height*ratio;const ctx=canvas.getContext("2d");ctx.scale(ratio,ratio);ctx.clearRect(0,0,width,height);
  const midLat=coords.reduce((sum,p)=>sum+p.lat,0)/coords.length,lonFactor=Math.cos(midLat*Math.PI/180);
  const xs=coords.map((p)=>p.lon*lonFactor),ys=coords.map((p)=>p.lat),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const pad=38,scale=Math.min((width-pad*2)/Math.max(maxX-minX,.000001),(height-pad*2)/Math.max(maxY-minY,.000001));
  const pointAt=(p)=>({x:width/2+(p.lon*lonFactor-(minX+maxX)/2)*scale,y:height/2-(p.lat-(minY+maxY)/2)*scale});
  const stroke=(color,lineWidth)=>{ctx.beginPath();coords.forEach((p,i)=>{const q=pointAt(p);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);});ctx.strokeStyle=color;ctx.lineWidth=lineWidth;ctx.lineCap="round";ctx.lineJoin="round";ctx.stroke();};
  stroke("rgba(255,255,255,.98)",12);stroke("#e45438",6);
  [ [coords[0],"#1d6b4d"], [coords.at(-1),"#17211b"] ].forEach(([p,color])=>{const q=pointAt(p);ctx.beginPath();ctx.arc(q.x,q.y,7,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.lineWidth=3;ctx.strokeStyle="#fff";ctx.stroke();});
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
  const point = { lat: position.coords.latitude, lon: position.coords.longitude, timestamp: position.timestamp, accuracy: Math.round(position.coords.accuracy), altitude:position.coords.altitude, altitudeAccuracy:position.coords.altitudeAccuracy, speed:position.coords.speed };
  $("#accuracyText").textContent = `GPS-Genauigkeit: ${point.accuracy} m`;
  if (point.accuracy > MAX_ACCURACY) { $("#trackingStatus").innerHTML = '<span class="pulse"></span> Ungenaue Position'; return; }
  activeRun.latestPosition = point;
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
  if (activeRun.points.length === 2) refreshMinuteFeatures();
}

function onPositionError(error) {
  const messages = { 1: "Standortzugriff wurde abgelehnt", 2: "GPS-Signal nicht verfügbar", 3: "GPS-Suche dauert länger" };
  $("#trackingStatus").innerHTML = `<span class="pulse"></span> ${messages[error.code] || "GPS-Fehler"}`;
}

async function startTracking() {
  if (!navigator.geolocation) return toast("GPS wird von diesem Browser nicht unterstützt.");
  activeRun = { id: crypto.randomUUID(), date: new Date().toISOString().slice(0,10), startedAt: new Date().toISOString(), startedAtMs: Date.now(), distanceMeters: 0, points: [], latestPosition:null, profile:[], shortCircuit:null, source: "gps", sport: selectedTrackingSport, hiddenDuringRun: false };
  $("#backgroundWarning").hidden = true;
  $("#liveDistance").textContent = "0,00";
  $("#liveDuration").textContent = "00:00";
  $("#livePace").textContent = "–:–– /km";
  $("#profileUpdated").textContent = "wartet auf GPS";
  $("#shortCircuitStatus").textContent = "wartet auf GPS";
  $("#routeHomeDistance").textContent = "–"; $("#projectedTotal").textContent = "–";
  drawLineChart($("#liveProfile"), []);
  $("#trackingTitle").textContent = `${SPORTS[selectedTrackingSport].label} wird aufgezeichnet`;
  $("#liveMetricLabel").textContent = selectedTrackingSport === "cycling" ? "Ø Tempo" : "Ø Pace";
  showView("trackingView");
  await requestWakeLock();
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
  timerId = setInterval(updateLiveMetrics, 1000);
  profileTimerId = setInterval(refreshMinuteFeatures, 60000);
}

async function stopTracking() {
  if (!activeRun) return;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  clearInterval(timerId);
  clearInterval(profileTimerId);
  if (wakeLock) { try { await wakeLock.release(); } catch (_) {} wakeLock = null; }
  const durationSeconds = Math.max(1, Math.floor((Date.now() - activeRun.startedAtMs) / 1000));
  sampleProfile();
  const run = { id: activeRun.id, date: activeRun.date, startedAt: activeRun.startedAt, durationSeconds, distanceMeters: Math.round(activeRun.distanceMeters), averagePaceSecondsPerKm: activeRun.distanceMeters >= 50 ? Math.round(durationSeconds / (activeRun.distanceMeters / 1000)) : null, source: "gps", sport: activeRun.sport, points: activeRun.points, profile:activeRun.profile, shortCircuit:activeRun.shortCircuit };
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
  const hasProfile = Array.isArray(run.profile) && run.profile.length > 0;
  $("#detailProfileWrap").hidden = !hasProfile;
  if (hasProfile) requestAnimationFrame(()=>drawLineChart($("#detailProfile"),run.profile));
  const hasRoute = run.source === "gps" && run.points?.length > 1;
  $("#mapNote").textContent="Kartendaten © OpenStreetMap-Mitwirkende · Route bleibt auch ohne Kartenkacheln sichtbar";
  $("#mapWrap").hidden = !hasRoute;
  $("#shareButton").hidden = !hasRoute;
  if (detailMap) { detailMap.remove(); detailMap = null; }
  if (mapResizeObserver) { mapResizeObserver.disconnect(); mapResizeObserver = null; }
  showView("detailView");
  if (hasRoute) requestAnimationFrame(()=>drawRouteFallback(run.points));
  if (hasRoute && window.L) {
    const coords = run.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)).map((p) => [p.lat, p.lon]);
    const initializeMap = () => {
      detailMap = L.map("map", { zoomControl:false, attributionControl:false, preferCanvas:true, dragging:false, touchZoom:false, scrollWheelZoom:false, doubleClickZoom:false, keyboard:false, boxZoom:false });
      const tiles=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom:19, crossOrigin:true, updateWhenIdle:false, keepBuffer:2 }).addTo(detailMap);
      const line = L.polyline(coords, { color:"#ffffff", weight:10, opacity:.95 }).addTo(detailMap);
      L.polyline(coords, { color:"#e45438", weight:6, opacity:1 }).addTo(detailMap);
      L.circleMarker(coords[0], { radius:7, color:"#fff", weight:3, fillColor:"#1d6b4d", fillOpacity:1 }).addTo(detailMap).bindTooltip("Start");
      L.circleMarker(coords.at(-1), { radius:7, color:"#fff", weight:3, fillColor:"#17211b", fillOpacity:1 }).addTo(detailMap).bindTooltip("Ziel");
      const fitRoute = () => { detailMap.invalidateSize({ pan:false }); detailMap.fitBounds(line.getBounds(), { padding:[38,38], maxZoom:17, animate:false }); drawRouteFallback(run.points); };
      tiles.on("tileerror",()=>{$("#mapNote").textContent="Kartenkacheln unvollständig · aufgezeichnete Route bleibt sichtbar";});
      fitRoute();
      setTimeout(fitRoute, 150);
      setTimeout(fitRoute, 700);
      mapResizeObserver = new ResizeObserver(() => detailMap && fitRoute());
      mapResizeObserver.observe($("#map"));
    };
    requestAnimationFrame(() => requestAnimationFrame(initializeMap));
  } else if(hasRoute) {
    $("#mapNote").textContent="Kartenhintergrund nicht verfügbar · aufgezeichnete Route ist schematisch dargestellt";
  }
}

function parseDuration(value) {
  const input = value.trim();
  if (!input) return null;
  if (/^\d+$/.test(input)) return Number(input) * 60;
  const parts = input.split(/[.:,;_\-]+/);
  if (parts.length !== 2 || !parts.every((part) => /^\d+$/.test(part))) return Number.NaN;
  const [minutes, seconds] = parts.map(Number);
  if (seconds > 59) return Number.NaN;
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
  if (Number.isNaN(durationSeconds)) return toast("Dauer bitte als 20 oder z. B. 20.30 eingeben");
  const run = { id: crypto.randomUUID(), date: $("#manualDate").value, startedAt: `${$("#manualDate").value}T12:00:00`, durationSeconds, distanceMeters, averagePaceSecondsPerKm: durationSeconds && distanceMeters ? Math.round(durationSeconds/(distanceMeters/1000)) : null, source:"manual", sport, laps, location:$("#manualLocation").value.trim(), note:$("#manualNote").value.trim(), points:[] };
  await saveRun(run); runs.unshift(run); renderRuns(); event.target.reset(); showView("homeView"); toast("Aktivität eingetragen");
}

function exportData() {
  const blob = new Blob([JSON.stringify({ exportedAt:new Date().toISOString(), runs, weights }, null, 2)], { type:"application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `sportler-backup-${new Date().toISOString().slice(0,10)}.json`; link.click(); URL.revokeObjectURL(link.href);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    const valid = Array.isArray(data.runs) ? data.runs.filter((run) => run && run.id && run.date && Number.isFinite(run.distanceMeters)) : [];
    const validWeights=Array.isArray(data.weights)?data.weights.filter((entry)=>entry?.id&&entry.date&&Number.isFinite(entry.kg)):[];
    if (!valid.length && !validWeights.length) throw new Error("empty");
    for (const run of valid) await saveRun({ ...run, sport: sportOf(run), points: Array.isArray(run.points) ? run.points : [] });
    for(const entry of validWeights)await saveWeight(entry);
    runs = await getRuns(); weights=await getWeights(); renderRuns();renderWeights(); toast(`${valid.length} Aktivitäten importiert`);
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
$("#weightButton").addEventListener("click", () => { $("#weightDate").value=new Date().toISOString().slice(0,10); renderWeights(); showView("weightView"); requestAnimationFrame(drawWeightChart); });
$("#manualSport").addEventListener("change", updateManualFields);
$("#manualForm").addEventListener("submit", addManualRun);
$("#weightForm").addEventListener("submit", addWeight);
$("#weightList").addEventListener("click",async(event)=>{const button=event.target.closest("[data-weight-id]");if(!button)return;await removeWeight(button.dataset.weightId);weights=weights.filter((entry)=>entry.id!==button.dataset.weightId);renderWeights();toast("Gewichtseintrag gelöscht");});
$("#exportButton").addEventListener("click", exportData);
$("#importInput").addEventListener("change", (event) => { const [file]=event.target.files; if(file) importData(file); event.target.value=""; });
$("#shareButton").addEventListener("click", () => shareCard().catch(() => toast("Bild konnte nicht geteilt werden")));
$("#deleteButton").addEventListener("click", async () => { if (!selectedRun || !confirm("Diese Aktivität wirklich löschen?")) return; await removeRun(selectedRun.id); runs=runs.filter(r=>r.id!==selectedRun.id); renderRuns(); showView("homeView"); toast("Aktivität gelöscht"); });
$("#runList").addEventListener("click", (event) => { const button=event.target.closest("[data-id]"); if(button) showDetail(runs.find(r=>r.id===button.dataset.id)); });
document.querySelectorAll("[data-back]").forEach((button) => button.addEventListener("click", () => showView("homeView")));
document.addEventListener("visibilitychange", async () => { if (!activeRun) return; if(document.hidden){activeRun.hiddenDuringRun=true;$("#backgroundWarning").hidden=false;} else {wakeLock=null;await requestWakeLock();} });
addEventListener("online", updateNetwork); addEventListener("offline", updateNetwork);
function updateNetwork(){ $("#offlineBadge").hidden=navigator.onLine; }
addEventListener("resize",()=>{if(activeRun)drawLineChart($("#liveProfile"),activeRun.profile);if($("#weightView").classList.contains("active"))drawWeightChart();});

(async function init(){ updateNetwork(); try { const data=await Promise.all([getRuns(),getWeights()]);runs=data[0].map((run)=>({ ...run, sport:sportOf(run) }));weights=data[1];renderRuns();renderWeights(); } catch (_) { toast("Lokaler Speicher ist nicht verfügbar"); } if("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{}); })();
