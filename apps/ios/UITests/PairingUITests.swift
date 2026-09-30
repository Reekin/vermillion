import XCTest

final class PairingUITests: XCTestCase {
    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    private func edgeSwipe(_ app: XCUIApplication) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)))
    }

    // Supply isolated gateways through TEST_RUNNER_IOS_GATEWAYS when invoking xcodebuild; TEST_RUNNER_IOS_SESSION names a
    // session title on the first desktop for the in-session edge swipe.
    func testIsolatedGateways() throws {
        struct Gateway: Decodable { let url: String; let code: String; let name: String }
        guard let json = ProcessInfo.processInfo.environment["IOS_GATEWAYS"] else {
            throw XCTSkip("Requires two running isolated gateways in TEST_RUNNER_IOS_GATEWAYS")
        }
        let gateways = try JSONDecoder().decode([Gateway].self, from: Data(json.utf8))
        XCTAssertEqual(gateways.count, 2)
        let app = XCUIApplication(); app.launch()
        for (index, gateway) in gateways.enumerated() {
            if index == 0 {
                app.buttons["添加桌面"].tap()
                let address = app.textFields["pair-address"]; address.tap(); address.typeText(gateway.url)
                let code = app.textFields["pair-code"]; code.tap(); code.typeText(gateway.code)
            } else {
                var components = URLComponents(string: "vermillion://pair")!
                components.queryItems = [.init(name: "url", value: gateway.url), .init(name: "code", value: gateway.code), .init(name: "name", value: gateway.name)]
                app.open(components.url!)
                XCTAssertEqual(app.textFields["pair-address"].value as? String, gateway.url)
            }
            app.buttons["pair-submit"].tap()
            XCTAssertTrue(app.navigationBars["桌面列表"].waitForExistence(timeout: 30))
            XCTAssertTrue(app.buttons.containing(.staticText, identifier: gateway.name).firstMatch.waitForExistence(timeout: 20))
        }
        capture("Two paired desktops", app: app)
        for gateway in gateways {
            app.buttons.containing(.staticText, identifier: gateway.name).firstMatch.tap()
            XCTAssertTrue(app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS 'Inbox'")).firstMatch.waitForExistence(timeout: 30))
            XCTAssertFalse(app.webViews.textFields["配对码"].exists)
            capture("Authenticated web page " + gateway.name, app: app)
            // The page has no native bar; its own back row returns to the list, and a later visit reuses the kept page.
            app.webViews.buttons.matching(NSPredicate(format: "label IN %@", ["桌面", "Desktops"])).firstMatch.tap()
            XCTAssertTrue(app.navigationBars["桌面列表"].waitForExistence(timeout: 5))
        }
        // Pinch does not zoom; edge swipes go back a level at a time.
        app.buttons.containing(.staticText, identifier: gateways[0].name).firstMatch.tap()
        let inbox = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS 'Inbox'")).firstMatch
        XCTAssertTrue(inbox.waitForExistence(timeout: 10))
        let before = inbox.frame
        app.webViews.firstMatch.pinch(withScale: 2.5, velocity: 2)
        XCTAssertEqual(inbox.frame, before)
        if let title = ProcessInfo.processInfo.environment["IOS_SESSION"] {
            let row = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10))
            row.tap()
            XCTAssertTrue(app.webViews.textViews.firstMatch.waitForExistence(timeout: 10))
            capture("Session before edge swipe", app: app)
            edgeSwipe(app)
            XCTAssertTrue(inbox.waitForExistence(timeout: 5))
            XCTAssertFalse(app.navigationBars["桌面列表"].exists)
        }
        edgeSwipe(app)
        XCTAssertTrue(app.navigationBars["桌面列表"].waitForExistence(timeout: 5))
        // A cold app process still uses Keychain credentials.
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons.containing(.staticText, identifier: gateways[0].name).firstMatch.waitForExistence(timeout: 20))
        app.buttons.containing(.staticText, identifier: gateways[0].name).firstMatch.tap()
        XCTAssertTrue(app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS 'Inbox'")).firstMatch.waitForExistence(timeout: 30))
        capture("Keychain after process restart", app: app)
    }

    /// Real-device pass over a LAN-reachable test gateway: TEST_RUNNER_IOS_DEVICE_GATEWAY = {"url","code","name"},
    /// TEST_RUNNER_IOS_SESSION = a session title. Types into the composer but never sends.
    func testDeviceKeyboardAndGestures() throws {
        struct Gateway: Decodable { let url: String; let code: String; let name: String }
        let env = ProcessInfo.processInfo.environment
        guard let json = env["IOS_DEVICE_GATEWAY"], let title = env["IOS_SESSION"] else {
            throw XCTSkip("Requires TEST_RUNNER_IOS_DEVICE_GATEWAY and TEST_RUNNER_IOS_SESSION")
        }
        let gateway = try JSONDecoder().decode(Gateway.self, from: Data(json.utf8))
        addUIInterruptionMonitor(withDescription: "Local network") { alert in
            for label in ["允许", "Allow"] where alert.buttons[label].exists { alert.buttons[label].tap(); return true }
            return false
        }
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.navigationBars["桌面列表"].waitForExistence(timeout: 10))
        var components = URLComponents(string: "vermillion://pair")!
        components.queryItems = [.init(name: "url", value: gateway.url), .init(name: "code", value: gateway.code), .init(name: "name", value: gateway.name)]
        app.open(components.url!)
        XCTAssertTrue(app.buttons["pair-submit"].waitForExistence(timeout: 10))
        app.buttons["pair-submit"].tap()
        // Lets the interruption monitor answer the local network prompt.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.02)).tap()
        let row = app.buttons.containing(.staticText, identifier: gateway.name).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        let inbox = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS 'Inbox'")).firstMatch
        XCTAssertTrue(inbox.waitForExistence(timeout: 30))
        capture("Device list page", app: app)

        // Pinch leaves the page unzoomed.
        let before = inbox.frame
        app.webViews.firstMatch.pinch(withScale: 2.5, velocity: 2)
        XCTAssertEqual(inbox.frame, before)

        // The composer sits on the keyboard's top edge and grows while the top bar stays visible.
        let session = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(session.waitForExistence(timeout: 10))
        session.tap()
        let field = app.webViews.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        let back = app.webViews.buttons.firstMatch
        XCTAssertLessThan(back.frame.minY, 120)
        let idleField = field.frame
        field.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 0.8)
        let gap = keyboard.frame.minY - field.frame.maxY
        XCTAssertTrue(gap >= 0 && gap < 24, "composer to keyboard gap \(gap)")
        XCTAssertTrue(back.frame.minY >= 0 && back.frame.minY < 120 && back.isHittable, "top bar pushed off by the keyboard")
        capture("Keyboard shown", app: app)
        let text = String(repeating: "keyboard edge check ", count: 12)
        field.typeText(text)
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertGreaterThan(field.frame.height, idleField.height)
        let grownGap = keyboard.frame.minY - field.frame.maxY
        XCTAssertTrue(grownGap >= 0 && grownGap < 24, "grown composer to keyboard gap \(grownGap)")
        XCTAssertTrue(back.isHittable)
        capture("Keyboard with grown composer", app: app)
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: text.count))

        // Edge swipes go back a level at a time: session to list, then list to the desktop list.
        app.webViews.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        edgeSwipe(app)
        XCTAssertTrue(inbox.waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["桌面列表"].exists)
        edgeSwipe(app)
        XCTAssertTrue(app.navigationBars["桌面列表"].waitForExistence(timeout: 5))

        // Entering again shows the kept page at once.
        row.tap()
        let start = Date()
        XCTAssertTrue(inbox.waitForExistence(timeout: 1))
        print("VERMILLION_REENTRY_SECONDS \(Date().timeIntervalSince(start))")
        capture("Device re-entry", app: app)
        app.webViews.buttons.matching(NSPredicate(format: "label IN %@", ["桌面", "Desktops"])).firstMatch.tap()
        XCTAssertTrue(app.navigationBars["桌面列表"].waitForExistence(timeout: 5))
        // Leave no test pairing behind in the app.
        row.swipeLeft()
        app.buttons["移除"].tap()
        app.buttons["移除桌面"].tap()
        XCTAssertFalse(row.waitForExistence(timeout: 3))
    }

    func testTappedSimulatorNotification() throws {
        let env = ProcessInfo.processInfo.environment
        guard let title = env["IOS_PUSH_TITLE"], let desktop = env["IOS_PUSH_DESKTOP"], let marker = env["IOS_PUSH_MARKER"] else {
            throw XCTSkip("Requires IOS_PUSH_TITLE, IOS_PUSH_DESKTOP and IOS_PUSH_MARKER with external simctl push")
        }
        let app = XCUIApplication(); app.launch()
        app.buttons["开启通知"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }
        let chineseAllow = springboard.buttons["允许"]
        if chineseAllow.exists { chineseAllow.tap() }
        XCUIDevice.shared.press(.home)
        print("VERMILLION_PUSH_READY")
        let notification = springboard.staticTexts[title].firstMatch
        XCTAssertTrue(notification.waitForExistence(timeout: 120))
        notification.tap()
        XCTAssertFalse(app.navigationBars["桌面列表"].waitForExistence(timeout: 5))
        XCTAssertTrue(desktop.isEmpty || app.webViews.firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(app.webViews.staticTexts[marker].firstMatch.waitForExistence(timeout: 30))
        capture("Tapped notification target", app: app)
    }

    func testOfflineDesktop() throws {
        guard let name = ProcessInfo.processInfo.environment["IOS_OFFLINE_DESKTOP"] else {
            throw XCTSkip("Requires IOS_OFFLINE_DESKTOP and its gateway stopped externally")
        }
        let app = XCUIApplication(); app.launch()
        let row = app.buttons.containing(.staticText, identifier: name).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(row.staticTexts["离线"].waitForExistence(timeout: 35))
        capture("Offline desktop", app: app)
    }

    func testManualPairingValidation() {
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.navigationBars["桌面列表"].waitForExistence(timeout: 10))
        app.buttons["添加桌面"].tap()
        let address = app.textFields["pair-address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["pair-submit"].isEnabled)
        address.tap(); address.typeText("http://unsafe.example")
        let code = app.textFields["pair-code"]; code.tap(); code.typeText("12345678")
        app.buttons["pair-submit"].tap()
        XCTAssertTrue(app.staticTexts["请输入 HTTPS 公网地址，不含路径、账号或查询参数。"].waitForExistence(timeout: 5))
        app.buttons["取消"].tap()
        XCTAssertTrue(app.navigationBars["桌面列表"].exists)
    }
}
