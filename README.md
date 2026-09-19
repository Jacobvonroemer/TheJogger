# Sportler

Eine kleine installierbare Sporthistorie für Laufen, Radfahren, Schwimmen und sonstige Aktivitäten. GPS-Strecken können für Laufen und Radfahren aufgezeichnet werden. Schwimmen und andere Sportarten lassen sich manuell nachtragen. Alle Daten bleiben lokal in IndexedDB.

## Funktionen

- GPS-Aufzeichnung für Laufen und Radfahren mit sportartspezifischem Plausibilitätsfilter
- Sporthistorie mit Distanz, Dauer, Pace bzw. Geschwindigkeit
- Schwimmeinträge über 50-Meter-Bahnen, Dauer und Schwimmbad
- Freie sonstige Aktivitäten, auch ohne Strecke
- Routendarstellung mit OpenStreetMap sowie Start- und Zielmarker
- Bildkarte zum Teilen, JSON-Export und JSON-Import
- Offline-App-Shell, Wake Lock und installierbare PWA

Bereits gespeicherte Einträge aus der ersten Jogging-Version bleiben erhalten und werden als Laufen angezeigt.

## Lokal testen

Die App muss über HTTP(S) laufen; `index.html` nicht direkt als Datei öffnen.

```bash
python -m http.server 8080
```

Danach `http://localhost:8080` öffnen. GPS funktioniert auf Mobilgeräten außerhalb von `localhost` nur über HTTPS.

## Auf GitHub Pages veröffentlichen

1. Alle Dateien in ein GitHub-Repository pushen.
2. Unter **Settings → Pages** bei **Build and deployment** „Deploy from a branch“ wählen.
3. Branch `main` und Ordner `/(root)` auswählen und speichern.
4. GitHub zeigt anschließend die HTTPS-Adresse an, z. B. `https://username.github.io/sportler/`.

Alle Pfade sind relativ und funktionieren auch in einem Repository-Unterordner.

## Installation

- **iPhone/iPad (Safari):** Teilen → „Zum Home-Bildschirm“ → „Hinzufügen“.
- **Android (Chrome):** Browser-Menü → „App installieren“ oder „Zum Startbildschirm hinzufügen“.

## Datenschutz und Grenzen

- Keine Konten, Analytics oder Serverübertragung. Aktivitäten und GPS-Punkte bleiben im Browser dieses Geräts.
- Das Löschen der Browser-/Website-Daten entfernt auch die Historie. Regelmäßige JSON-Backups sind deshalb sinnvoll.
- Browser-PWAs können GPS-Tracking bei gesperrtem Bildschirm oder dauerhaft im Hintergrund nicht garantieren.
- Die Kartenansicht benötigt Internet. Der übrige App-Shell funktioniert nach dem ersten Laden offline.
- Die App erkennt Radfahren nicht automatisch anhand der Geschwindigkeit. Diese Erkennung wäre bei langsamen Radfahrten, schnellen Läufen und GPS-Ausreißern unzuverlässig; die Sportart wird vor dem Start gewählt.
