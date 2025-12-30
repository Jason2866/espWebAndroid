const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    name: 'ESP32Tool',
    executableName: 'esp32tool',
    asar: true,
    // Ensure consistent executable name across platforms
    win32metadata: {
      FileDescription: 'ESP32Tool',
      ProductName: 'ESP32Tool',
    },
    appBundleId: 'com.esp32tool',
    appCategoryType: 'public.app-category.developer-tools',
    // Files to exclude from the app
    ignore: [
      /^\/src\/(?!wasm)/,  // Exclude src/ but keep src/wasm/
      /^\/script/,
      /^\/\.github/,
      /^\/node_modules\/(?!electron)/,
      /\.git/,
      /\.eslint/,
      /\.prettier/,
      /tsconfig\.json/,
      /rollup\.config\.(js|mjs)$/,
      /\.md$/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'ESP32Tool',
        authors: 'Johann Obermeier',
        description: 'Flash & Read ESP32 devices using WebSerial',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux', 'win32'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          name: 'esp32tool',
          bin: 'esp32tool',
          maintainer: 'Johann Obermeier',
          homepage: 'https://github.com/Jason2866/esp32tool',
          categories: ['Development', 'Utility'],
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: {
          name: 'esp32tool',
          bin: 'esp32tool',
          homepage: 'https://github.com/Jason2866/esp32tool',
          categories: ['Development', 'Utility'],
        },
      },
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        format: 'ULFO',
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
