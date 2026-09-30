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
        XCTAssertTrue(RemotePolicy.target("#/inbox"))
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
        XCTAssertTrue(store.path.isEmpty)
        store.notification(["desktopUrl": "https://test.example", "target": "#/inbox/workspace/key"])
        XCTAssertEqual(store.path, ["https://test.example"])
        XCTAssertEqual(store.lastOpened?.target, "#/inbox/workspace/key")
        store.notification(["desktopUrl": "https://test.example", "target": "#/inbox"])
        XCTAssertEqual(store.lastOpened?.target, "#/inbox")
        XCTAssertEqual(store.path, ["https://test.example"])
    }
    @MainActor func testOfflineDesktopCanBeRemoved() async throws {
        let previous = try Credentials.load()
        defer { try? Credentials.save(previous) }
        let desktop = Desktop(origin: URL(string: "https://127.0.0.1:1")!, deviceId: "id", name: "Offline", token: "test")
        let store = DesktopStore()
        store.desktops = [desktop]
        try Credentials.save([desktop])
        await store.remove(desktop)
        XCTAssertTrue(store.desktops.isEmpty)
        XCTAssertTrue(try Credentials.load().isEmpty)
        XCTAssertEqual(store.error, "已从本机移除。无法取消推送登记，请在该桌面的已配对设备中移除此设备。")
    }
    @MainActor func testRemovalCannotBeOvertakenByPushRegistration() async throws {
        let previous = try Credentials.load()
        defer { try? Credentials.save(previous) }
        let a = Desktop(origin: URL(string: "https://a.example")!, deviceId: "A", name: "A", token: "a")
        let b = Desktop(origin: URL(string: "https://b.example")!, deviceId: "B", name: "B", token: "b")
        let started = expectation(description: "A registration suspended")
        var resume: CheckedContinuation<Void, Never>?
        var events: [String] = []
        let store = DesktopStore { desktop, method, _ in
            events.append("\(method) \(desktop.deviceId)")
            if events.count == 1 {
                await withCheckedContinuation { continuation in resume = continuation; started.fulfill() }
            }
        }
        store.desktops = [a, b]
        let registration = Task { await store.setPushToken(Data([1, 2])) }
        await fulfillment(of: [started], timeout: 3)
        let removal = Task { await store.remove(b) }
        await Task.yield()
        let retry = Task { await store.registerPush() }
        resume?.resume()
        await registration.value; await removal.value; await retry.value
        XCTAssertEqual(events, ["POST A", "POST B", "DELETE B", "POST A"])
        XCTAssertEqual(store.desktops.map(\.deviceId), ["A"])
        XCTAssertEqual(try Credentials.load().map(\.deviceId), ["A"])
    }
}
