import XCTest

final class PairingUITests: XCTestCase {
    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    // Supply isolated gateways through TEST_RUNNER_IOS_GATEWAYS when invoking xcodebuild.
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
        // A cold app process still uses Keychain credentials.
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons.containing(.staticText, identifier: gateways[0].name).firstMatch.waitForExistence(timeout: 20))
        app.buttons.containing(.staticText, identifier: gateways[0].name).firstMatch.tap()
        XCTAssertTrue(app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS 'Inbox'")).firstMatch.waitForExistence(timeout: 30))
        capture("Keychain after process restart", app: app)
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
