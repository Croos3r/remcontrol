# Generated app icons

This package was generated from the uploaded ChatGPT image.

## What was done

- Cropped the icon to the blue rounded-square artwork.
- Removed the external white page/background around the blue icon plate.
- Generated transparent PNGs for desktop/Linux/Windows/macOS use.
- Generated opaque iOS PNGs so the App Store/iOS asset catalog does not contain alpha.

## Included folders

### Android
Copy `android/res` into your Android project under `app/src/main/res`.

Included:
- Legacy launcher PNGs: `mipmap-mdpi` through `mipmap-xxxhdpi`
- Round launcher PNGs
- Adaptive icon XML files in `mipmap-anydpi-v26`
- Play Store icon: `android/play-store-icon-512.png`

### iOS
Drag `ios/AppIcon.appiconset` into your Xcode project's `Assets.xcassets`.

The iOS icons are opaque.

### Windows
Use `windows/app.ico` for a Windows application icon.

Also included are individual PNGs from 16px through 256px.

### macOS
Use `macos/app.icns` where supported.

The `macos/AppIcon.iconset` folder is also included. On macOS, you can rebuild the ICNS with:

```bash
iconutil -c icns AppIcon.iconset
```

### Linux
Use the PNGs under `linux/hicolor/*/apps/app-icon.png`.

For many Linux desktop apps, copy them into the matching hicolor icon theme directories and reference `app-icon` in your `.desktop` file.

### Generic PNGs
- `png/`: transparent PNG versions.
- `png-opaque/`: opaque PNG versions.

## Notes

- Android and desktop assets preserve the transparent rounded corners.
- iOS assets are flattened to a full opaque square to avoid alpha-channel issues in Xcode/App Store submission.
- You can rename `app-icon`, `app.ico`, and `app.icns` to match your app name.
- Included macos/app.icns.
