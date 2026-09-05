# Jogging

Eine minimale, installierbare Jogging-Tracking-PWA. Sie zeichnet Läufe per GPS auf, berechnet Distanz und Pace, zeigt Routen auf OpenStreetMap und speichert alles ausschließlich lokal in IndexedDB.

## Lokal testen

Die App muss über HTTP(S) laufen; `index.html` nicht direkt als Datei öffnen.

```bash
python -m http.server 8080
```

Dann `http://localhost:8080` öffnen. GPS funktioniert auf Mobilgeräten außerhalb von `localhost` nur über HTTPS.

## Auf GitHub Pages veröffentlichen

1. Alle Dateien in ein GitHub-Repository pushen.
2. Unter **Settings → Pages** bei **Build and deployment** „Deploy from a branch“ wählen.
3. Branch `main` und Ordner `/(root)` auswählen und speichern.
4. GitHub zeigt anschließend die HTTPS-Adresse an, z. B. `https://username.github.io/jogging/`.

Alle Pfade sind relativ und funktionieren daher auch in einem Repository-Unterordner.

## Installation

- **iPhone/iPad (Safari):** Teilen → „Zum Home-Bildschirm“ → „Hinzufügen“.
- **Android (Chrome):** Browser-Menü → „App installieren“ oder „Zum Startbildschirm hinzufügen“.

Beim ersten Start eines GPS-Laufs muss der Standortzugriff erlaubt werden.

## Datenschutz und Grenzen

- Keine Konten, Analytics oder Serverübertragung. Läufe und GPS-Punkte bleiben im Browser dieses Geräts.
- Ein Löschen der Browser-/Website-Daten entfernt auch die Läufe. Der JSON-Export dient als Backup; ein Import ist für eine spätere Version vorgesehen.
- Browser-PWAs können GPS-Tracking bei gesperrtem Bildschirm oder dauerhaft im Hintergrund nicht garantieren. Für zuverlässige Aufzeichnung die App geöffnet und den Bildschirm aktiv lassen.
- Die Kartenansicht benötigt Internet, weil Kartenkacheln sparsam von OpenStreetMap geladen werden. Der übrige App-Shell funktioniert nach dem ersten Laden offline.
- GPS-Distanzen sind Näherungen. Ungenaue Punkte, Sprünge über 8 m/s und Bewegungen unter 3 m werden gefiltert.
