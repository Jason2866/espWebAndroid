# Installation and Setup

### Build Process

```bash
# 1. Install dependencies
npm install

# 2. Build project
npm run build
```

### Development

For local development:

```bash
# Start development server
npm run develop
```

Or simply open `index.html` in a modern browser (Chrome/Edge with Web Serial API support).

### Deployment

The built files are located in:
- `js/modules/esptool.js` - Main ESPTool module

### Electron App

For the Electron desktop app:

```bash
# Start Electron app
npm start

# Package Electron app
npm run package

# Create installer
npm run make
```
