const { withAndroidManifest } = require('@expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

// Allow cleartext ws:// traffic only to LAN / loopback addresses so the
// released APK can reach the server on the local network. Android 9+
// blocks cleartext by default; a scoped network security config keeps
// public-traffic cleartext blocked. Applied via a config plugin so it
// survives `expo prebuild` (the android/ tree is generated, not committed).
function withLanCleartext(config) {
  return withAndroidManifest(config, (mod) => {
    const src = path.join(__dirname, 'assets', 'network_security_config.xml');
    const resXmlDir = path.join(
      mod.modRequest.platformProjectRoot,
      'app',
      'src',
      'main',
      'res',
      'xml',
    );
    fs.mkdirSync(resXmlDir, { recursive: true });
    fs.copyFileSync(src, path.join(resXmlDir, 'network_security_config.xml'));

    const application = mod.modResults.manifest.application?.[0];
    if (application) {
      application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    }
    return mod;
  });
}

module.exports = withLanCleartext;
