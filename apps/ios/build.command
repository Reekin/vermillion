#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
xcodegen generate --spec project.yml
xcodebuild -project Vermillion.xcodeproj -scheme Vermillion \
  -destination 'generic/platform=iOS Simulator' -configuration Debug \
  -derivedDataPath "${TMPDIR:-/tmp}/vermillion-ios-build" build CODE_SIGN_IDENTITY=-
printf '\nSimulator app: %s/vermillion-ios-build/Build/Products/Debug-iphonesimulator/Vermillion.app\n' "${TMPDIR:-/tmp}"
