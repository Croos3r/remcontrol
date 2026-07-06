const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod } = require('@expo/config-plugins');

const SPLASH_BG = '#005DE8';

function withSplash(config) {
  return withDangerousMod(config, [
    'android',
    (mod) => {
      const projectRoot = mod.modRequest.platformProjectRoot;
      const resDir = path.join(projectRoot, 'app', 'src', 'main', 'res');
      const drawableDir = path.join(resDir, 'drawable');
      const valuesDir = path.join(resDir, 'values');

      fs.mkdirSync(drawableDir, { recursive: true });

      // Bitmap drawable: center the logo on the blue background (no stretch).
      fs.writeFileSync(
        path.join(drawableDir, 'splashscreen.xml'),
        `<?xml version="1.0" encoding="utf-8"?>\n` +
          `<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n` +
          `  <item android:drawable="@color/splashscreen_background"/>\n` +
          `  <item>\n` +
          `    <bitmap android:gravity="center" android:src="@drawable/splashscreen_logo"/>\n` +
          `  </item>\n` +
          `</layer-list>\n`,
      );

      // Blue splash background color.
      const colorsPath = path.join(valuesDir, 'colors.xml');
      let colors = fs.readFileSync(colorsPath, 'utf8');
      colors = colors.replace(
        /<color name="splashscreen_background">[^<]*<\/color>/,
        `<color name="splashscreen_background">${SPLASH_BG}</color>`,
      );
      fs.writeFileSync(colorsPath, colors);

      // Point the splash theme window background at the new drawable.
      const stylesPath = path.join(valuesDir, 'styles.xml');
      let styles = fs.readFileSync(stylesPath, 'utf8');
      styles = styles.replace(
        /<item name="android:windowBackground">@drawable\/splashscreen_logo<\/item>/,
        '<item name="android:windowBackground">@drawable/splashscreen</item>',
      );
      fs.writeFileSync(stylesPath, styles);

      return mod;
    },
  ]);
}

module.exports = withSplash;
