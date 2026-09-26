import XCTest
import JavaScriptCore
@testable import Vermillion

final class RemoteTests: XCTestCase {
    func testDocumentStartTokenIsScopedAndEscaped() throws {
        let origin = try RemotePolicy.origin("https://desktop.example")
        let token = "quote\" slash\\ newline\n"
        for (location, mainFrame, expected) in [("https://desktop.example", true, true), ("https://evil.example", true, false), ("https://desktop.example", false, false)] {
            let context = JSContext()!
            context.evaluateScript("var window = {}; window.top = \(mainFrame ? "window" : "{}"); var location = {origin: '\(location)'};")
            context.evaluateScript(RemotePolicy.injection(origin: origin, token: token))
            XCTAssertNil(context.exception)
            let value = context.evaluateScript("window.__VERMILLION_REMOTE__ && window.__VERMILLION_REMOTE__.token")!
            if expected { XCTAssertEqual(value.toString(), token) } else { XCTAssertTrue(value.isUndefined) }
        }
    }
    func testOriginsAndNavigation() throws {
        let origin = try RemotePolicy.origin("https://DESKTOP.example:443/")
        XCTAssertEqual(origin.absoluteString, "https://desktop.example")
        for value in ["http://desktop.example", "https://user:secret@desktop.example", "https://desktop.example/a", "https://desktop.example?token=bad"] {
            XCTAssertThrowsError(try RemotePolicy.origin(value))
        }
        XCTAssertTrue(RemotePolicy.matches(URL(string: "https://desktop.example/#/session/a"), origin: origin))
        XCTAssertFalse(RemotePolicy.matches(URL(string: "https://desktop.example.evil/#/session/a"), origin: origin))
        XCTAssertFalse(RemotePolicy.matches(URL(string: "https://desktop.example:444"), origin: origin))
        XCTAssertFalse(RemotePolicy.matches(URL(string: "http://desktop.example"), origin: origin))
        XCTAssertFalse(RemotePolicy.matches(URL(string: "https://user@desktop.example"), origin: origin))
    }
    func testPairingAndNotificationTargets() throws {
        let pair = try RemotePolicy.pairing(URL(string: "vermillion://pair?url=https%3A%2F%2Fdesktop.example%3A8443&code=12345678&name=Mac")!)
        XCTAssertEqual(pair.0.absoluteString, "https://desktop.example:8443")
        XCTAssertEqual(pair.1, "12345678")
        XCTAssertEqual(pair.2, "Mac")
        XCTAssertTrue(RemotePolicy.target("#/session/a%2Fb"))
        XCTAssertTrue(RemotePolicy.target("#/inbox/workspace/key"))
        for target in ["https://evil.example", "#/session/", "#/inbox/a", "#/settings", "#/session/a?token=x"] { XCTAssertFalse(RemotePolicy.target(target)) }
    }
    func testCredentialsRoundTrip() throws {
        let previous = try Credentials.load()
        defer { try? Credentials.save(previous) }
        let desktop = Desktop(origin: URL(string: "https://test.example")!, deviceId: "device", name: "Mac", token: "secret")
        try Credentials.save([desktop])
        XCTAssertEqual(try Credentials.load(), [desktop])
    }
    @MainActor func testNotificationRoutesOnlyPairedOrigins() {
        let store = DesktopStore()
        store.desktops = [Desktop(origin: URL(string: "https://test.example")!, deviceId: "id", name: "Mac", token: "secret")]
        store.notification(["desktopUrl": "https://evil.example", "target": "#/session/abc"])
        XCTAssertNil(store.destination)
        store.notification(["desktopUrl": "https://test.example", "target": "#/inbox/workspace/key"])
        XCTAssertEqual(store.destination?.target, "#/inbox/workspace/key")
        XCTAssertEqual(store.destination?.desktop.name, "Mac")
    }
}
