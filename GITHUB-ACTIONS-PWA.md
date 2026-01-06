# GitHub Actions PWA Deployment

## 🚀 Was wurde geändert?

Die GitHub Actions Workflow-Datei `.github/workflows/build_upload.yml` wurde für PWA-konformes Deployment aktualisiert.

## 📋 Änderungen im Detail:

### 1. Automatische Icon-Generierung
```yaml
- name: Generate PWA Icons
  run: |
    # Installiert ImageMagick falls nötig
    # Führt generate-icons.sh aus
    # Erstellt alle benötigten Icon-Größen
```

**Was passiert:**
- ImageMagick wird installiert (falls nicht vorhanden)
- `generate-icons.sh` wird ausgeführt
- Alle 8 Icon-Größen werden generiert (72px bis 512px)
- Favicon und Apple Touch Icon werden erstellt
- Placeholder-Screenshots werden generiert

### 2. PWA-Validierung
```yaml
- name: Validate PWA Files
  run: |
    # Prüft ob manifest.json existiert
    # Prüft ob sw.js existiert
    # Prüft ob icons/ Ordner existiert
```

**Was passiert:**
- Validiert dass alle PWA-Kerndateien vorhanden sind
- Build schlägt fehl wenn PWA-Dateien fehlen
- Listet alle generierten Icons auf

### 3. Deployment-Verzeichnis
```yaml
- name: Create deployment directory
  run: |
    mkdir -p _site
    # Kopiert nur benötigte Dateien
```

**Was wird deployed:**
- ✅ `css/` - Stylesheets
- ✅ `js/` - JavaScript inkl. Module
- ✅ `icons/` - PWA Icons
- ✅ `screenshots/` - App Screenshots (optional)
- ✅ `index.html` - Haupt-App
- ✅ `manifest.json` - PWA Manifest
- ✅ `sw.js` - Service Worker
- ✅ `install-android.html` - Installations-Anleitung
- ✅ `favicon.ico` - Browser-Icon
- ✅ `apple-touch-icon.png` - iOS Icon
- ✅ `.nojekyll` - GitHub Pages Konfiguration

**Was wird NICHT deployed:**
- ❌ `node_modules/` - Nicht nötig für Production
- ❌ `src/` - TypeScript Source (nur kompilierte JS)
- ❌ `dist/` - Build-Artefakte (nur finale JS)
- ❌ `.git/` - Git-Metadaten
- ❌ `electron/` - Nur für Desktop-App nötig

### 4. Erweiterte Commit-Nachricht
```yaml
- name: Commit Distribution Files
  with:
    commit_message: "Github Action: Updated dist files and PWA assets"
    file_pattern: "js/modules/*.js icons/*.png screenshots/*.png favicon.ico apple-touch-icon.png"
```

**Was passiert:**
- Committed generierte Icons zurück ins Repo
- Committed kompilierte JS-Module
- Committed Screenshots und Favicons
- Ermöglicht Versionskontrolle der generierten Assets

## 🔄 Workflow-Ablauf:

```
1. Checkout Code
   ↓
2. Setup Node.js 22
   ↓
3. Install Dependencies
   ↓
4. Compile TypeScript → JavaScript
   ↓
5. Copy JS Modules
   ↓
6. Generate PWA Icons ⭐ NEU
   ↓
7. Validate PWA Files ⭐ NEU
   ↓
8. Commit Generated Assets
   ↓
9. Publish to NPM
   ↓
10. Create Deployment Directory ⭐ GEÄNDERT
    ↓
11. Upload to GitHub Pages
    ↓
12. Deploy to GitHub Pages
```

## ✅ Vorteile:

1. **Automatisch**: Icons werden bei jedem Build generiert
2. **Validiert**: Build schlägt fehl wenn PWA-Dateien fehlen
3. **Sauber**: Nur Production-Dateien werden deployed
4. **Schnell**: Kleinere Deployment-Größe
5. **Sicher**: Keine sensiblen Dateien im Deployment

## 🧪 Testen:

### Lokal testen (vor Push):
```bash
# Simuliere den Build-Prozess
npm install
npm run build
./generate-icons.sh

# Prüfe ob alle Dateien vorhanden sind
ls -la icons/
ls -la js/modules/

# Teste lokal
npm run test-pwa
```

### Nach Push:
1. Gehe zu GitHub → Actions Tab
2. Warte bis "Build and upload" Workflow fertig ist
3. Prüfe ob alle Steps grün sind
4. Öffne deployed URL: `https://username.github.io/esp32tool`
5. Prüfe in Chrome DevTools:
   - Application → Manifest
   - Application → Service Workers
   - Lighthouse → PWA Audit

## 🐛 Troubleshooting:

### Build schlägt bei "Generate PWA Icons" fehl:
```bash
# Prüfe ob generate-icons.sh ausführbar ist
chmod +x generate-icons.sh

# Prüfe ob Script lokal funktioniert
./generate-icons.sh
```

### Build schlägt bei "Validate PWA Files" fehl:
```bash
# Prüfe ob alle PWA-Dateien vorhanden sind
ls manifest.json sw.js
ls -la icons/

# Falls nicht, erstelle sie:
./generate-icons.sh
```

### Icons werden nicht angezeigt nach Deployment:
1. Prüfe ob icons/ Ordner im Deployment ist
2. Öffne `https://username.github.io/esp32tool/icons/icon-192.png`
3. Prüfe Browser-Konsole auf 404-Fehler
4. Cache leeren und neu laden

### Service Worker lädt nicht:
1. Prüfe ob sw.js im Root-Verzeichnis ist
2. Öffne `https://username.github.io/esp32tool/sw.js`
3. Prüfe Browser-Konsole auf Fehler
4. Hard Reload: Strg+Shift+R

## 📝 Manuelle Anpassungen:

### Eigenes Logo verwenden:
1. Erstelle `logo.png` (mindestens 512x512px)
2. Aktualisiere `generate-icons.sh`:
```bash
# Ersetze die Icon-Generierung mit:
for size in 72 96 128 144 152 192 384 512; do
  convert logo.png -resize ${size}x${size} icons/icon-${size}.png
done
```

### Deployment-Pfad ändern:
Falls dein Repo nicht im Root deployed wird:

1. In `manifest.json`:
```json
"start_url": "/repo-name/",
"scope": "/repo-name/"
```

2. In `sw.js`:
```javascript
const CORE_ASSETS = [
  '/repo-name/',
  '/repo-name/index.html',
  // ...
];
```

### Zusätzliche Dateien deployen:
In `.github/workflows/build_upload.yml`:
```yaml
- name: Create deployment directory
  run: |
    # ... existing code ...
    cp deine-datei.txt _site/
```

## 🔐 Sicherheit:

### Was wird NICHT committed/deployed:
- `.env` Dateien (automatisch ignoriert)
- `node_modules/` (zu groß)
- Private Keys (nie committen!)
- Entwickler-Tools (nur Production-Code)

### Best Practices:
- Nutze GitHub Secrets für API-Keys
- Validiere alle Inputs
- Halte Dependencies aktuell
- Prüfe regelmäßig auf Security-Updates

## 📚 Weitere Infos:

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [GitHub Pages Documentation](https://docs.github.com/en/pages)
- [PWA Best Practices](https://web.dev/progressive-web-apps/)
- [Service Worker Lifecycle](https://developer.chrome.com/docs/workbox/service-worker-lifecycle/)

## ✨ Zusammenfassung:

Die GitHub Actions Workflow-Datei wurde erfolgreich für PWA-Deployment optimiert:

✅ Automatische Icon-Generierung
✅ PWA-Validierung vor Deployment
✅ Sauberes Deployment-Verzeichnis
✅ Versionskontrolle für generierte Assets
✅ Optimierte Build-Pipeline

Deine ESP32Tool PWA wird jetzt automatisch bei jedem Push auf `main` gebaut und deployed! 🚀
