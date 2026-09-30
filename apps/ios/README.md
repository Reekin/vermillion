# Vermillion iOS

SwiftUI desktop list and pairing, with desktop-provided pages hosted in WKWebView. Requires Xcode 16 or newer, XcodeGen, and iOS 17+. Generated `.xcodeproj` files and build products are not committed.

## Build and simulator

From the repository root:

On macOS, double-click `apps/ios/build.command` to generate and build the simulator app. It uses the installed XcodeGen and Xcode command line tools. The App icon uses the repository's Vermillion desktop artwork, flattened onto an opaque background for iOS distribution.

```sh
xcodegen generate --spec apps/ios/project.yml
xcodebuild -project apps/ios/Vermillion.xcodeproj -scheme Vermillion \
  -sdk iphonesimulator -configuration Debug -derivedDataPath /tmp/vermillion-ios build CODE_SIGNING_ALLOWED=NO
```

Use a dedicated simulator for acceptance. `xcrun simctl list devices available` lists destinations. Tests run with:

```sh
xcodebuild -project apps/ios/Vermillion.xcodeproj -scheme Vermillion \
  -destination 'platform=iOS Simulator,id=<dedicated simulator UUID>' \
  -derivedDataPath /tmp/vermillion-ios test CODE_SIGN_IDENTITY=-
xcrun simctl install <UUID> /tmp/vermillion-ios/Build/Products/Debug-iphonesimulator/Vermillion.app
xcrun simctl launch <UUID> app.vermillion.mobile
```

The simulator must trust the TLS certificate. For an isolated local Caddy gateway, add its root with `xcrun simctl keychain <UUID> add-root-cert <root.crt>`. Do not disable TLS verification. Pair with the HTTPS origin and one-time eight-character code, or open the QR content:

```sh
xcrun simctl openurl <UUID> 'vermillion://pair?url=https%3A%2F%2F127.0.0.1%3A8443&code=12345678&name=Mac'
```

This fills the pairing form; tap 配对 to confirm. Camera scanning requires a device camera; manual input and QR URL opening work on a simulator. Credentials are stored only in a this-device-only Keychain item. List summaries refresh when foregrounded, every 15 seconds while active, and on pull-to-refresh. Removal attempts to unregister push and deletes the local credential even when the desktop is offline or has revoked it. A failed unregister leaves a notice asking you to remove the device on that desktop.

## Gateway and native bridge

- `POST /api/pair`, JSON `{code,name}` → `{token,device:{deviceId},desktopName}`.
- `GET /api/summary`, `Authorization: Bearer <token>` → `{desktopName,inboxCount}`.
- `POST /api/push`, bearer authorization, JSON `{token,environment}`. Token is lowercase APNs hex; environment is `sandbox` for Debug, `production` for Release.
- `DELETE /api/push`, bearer authorization, unregisters before local removal.
- HTTP redirects are refused for all API requests. Only HTTPS origins without userinfo, query, or path are accepted for pairing.
- At document start, the main frame at the paired HTTPS origin receives `window.__VERMILLION_REMOTE__ = {token}`. No token is placed in a URL. Navigation and response policies reject other origins, including redirects; new windows stay within the paired origin. Each desktop keeps one page for the life of the App process, so returning to it shows it at once; the default persistent website data store keeps the HTTP cache. The credential is only injected per load, never written to web storage by the App. Re-pairing a desktop replaces its page; a terminated web content process reloads the page at the list level.
- The desktop page is pushed without a native navigation bar; the page draws its own top bar. The matching HTTPS main frame posts to `window.webkit.messageHandlers.vermillion`:
  - `{type:'exit'}` returns to the desktop list (the page's 「‹ 桌面」 row).
  - `{type:'level', level:'list'|'session'}` reports the page level. The system edge swipe returns to the desktop list only at the list level; inside a session the page's own edge swipe returns to its list.
- When a page cannot load, a native screen shows the error with 重试 and 返回桌面列表. Page zoom and link previews are disabled.
- APNs custom fields are `desktopUrl` (paired HTTPS origin) and `target` (`#/session/<encoded-id>`, `#/inbox/<encoded-workspace>/<encoded-key>`, or `#/inbox` for a test notification). Unknown desktops and invalid paths are rejected. A notification pushes its desktop (reusing its kept page) and sets the page's route to the target.

Enable notifications using 开启通知. Registration is sent to every paired desktop, including desktops paired after APNs registration; foreground and pull-to-refresh retry registration failures. The list shows failed registrations.

To exercise the notification transport on a simulator, create a payload outside the repository:

```json
{
  "aps": {"alert": {"title": "Mac · Vermillion", "body": "会话已完成"}, "sound": "default"},
  "desktopUrl": "https://127.0.0.1:8443",
  "target": "#/session/session-id"
}
```

Then `xcrun simctl push <UUID> app.vermillion.mobile /absolute/path/push.json`. Tap the delivered notification and verify the actual session or Inbox page. Simulator injection does not prove APNs delivery.

The UI suite includes opt-in isolated integration tests. Prefix xcodebuild with `env TEST_RUNNER_IOS_GATEWAYS='[{"url":"https://…","code":"12345678","name":"Mac"},{"url":"https://…","code":"87654321","name":"PC"}]'` and select `-only-testing:VermillionUITests/PairingUITests/testIsolatedGateways`. It performs manual pairing, QR-content pairing, web exit, desktop switching and process-restart credential reuse. Use fresh one-time codes for each run. Set `-parallel-testing-enabled NO` so `simctl` addresses the same dedicated device as the test runner.

For `testTappedSimulatorNotification`, set `TEST_RUNNER_IOS_PUSH_TITLE`, `TEST_RUNNER_IOS_PUSH_DESKTOP` and `TEST_RUNNER_IOS_PUSH_MARKER` to the expected notification title, native desktop name and actual visible web content. The test enables notifications, presses Home, logs `VERMILLION_PUSH_READY`, waits for the externally injected notification, taps it in Springboard and checks the target content. For `testOfflineDesktop`, stop the isolated desktop through `app.stop` and set `TEST_RUNNER_IOS_OFFLINE_DESKTOP` to its name. Integration tests skip explicitly when these prerequisites are absent. Screenshots are retained in the `.xcresult` bundle.

## Signing and device installation

1. In Xcode Settings → Accounts, sign in to the Apple Developer account. Use a paid team for Push Notifications and TestFlight.
2. Register the explicit bundle identifier `app.vermillion.mobile` (or your chosen unique identifier) in Apple Developer Certificates, Identifiers & Profiles, and enable Push Notifications.
3. Set `DEVELOPMENT_TEAM` in your local Xcode settings or pass `DEVELOPMENT_TEAM=<team-id>` to xcodebuild. Set `PRODUCT_BUNDLE_IDENTIFIER` consistently if using another identifier. Do not commit signing credentials.
4. Open the generated project, select your team under Signing & Capabilities, and connect an iPhone. Enable Developer Mode on the phone. Choose it as the run destination and run the Vermillion scheme. Automatic signing creates the development profile; confirm that the Push Notifications capability is present.
5. The generated entitlement expands `APNS_ENVIRONMENT`: Debug uses `development` and the sandbox APNs endpoint; Release uses `production`. Recreate the provisioning profile after enabling push if necessary. Simulator builds use `CODE_SIGNING_ALLOWED=NO`; device/archive builds must be signed.

## APNs key and desktop settings

Create a key under Apple Developer → Certificates, Identifiers & Profiles → Keys with Apple Push Notifications service enabled. Download the `.p8` once and retain it securely. Record its Key ID and the team's Team ID. All desktops can use the same key for the same App; the file stays on the desktop, never in the iOS bundle.

In desktop Settings → 远程访问 → 推送, choose the `.p8` file and enter Key ID, Team ID, and the exact signed App Bundle ID. Enable notifications in the iOS App and pair the desktop; verify the paired device reports push available. Use 发送测试推送 or `remote.push.test` (inspect CLI `--help` for parameters). An APNs success response proves APNs accepted the message; confirm delivery by tapping the notification on a real iPhone. Invalid credentials, topic or environment must be corrected using the specific returned APNs error.

## TestFlight

Create the matching App Store Connect App record. Configure a distribution signing team and App Store profile, supply App Store metadata, and increment `CURRENT_PROJECT_VERSION` for each upload. The universal 1024-pixel App icon is included. Archive with Release:

```sh
xcodebuild -project apps/ios/Vermillion.xcodeproj -scheme Vermillion \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath /tmp/Vermillion.xcarchive DEVELOPMENT_TEAM=<team-id> archive
```

Use Xcode Organizer → Distribute App → App Store Connect → Upload. After processing, add internal testers; external testing requires beta review. TestFlight builds register `production` device tokens. Verify the desktop uses the uploaded bundle ID and production APNs environment. A `.p8`, authorized Apple account, distribution profile and actual device are required for real delivery and upload; simulator tests cannot substitute for them.
