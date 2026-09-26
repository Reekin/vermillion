import XCTest

final class PairingUITests: XCTestCase {
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
