import XCTest

/// Pairs with a running host and loads its web UI. Skipped unless `just smoke <url>`
/// points it at a host that has the device endpoints.
@MainActor
final class HostSmokeTests: XCTestCase {
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    func testPairsAndShowsTheWebUI() throws {
        let host = ProcessInfo.processInfo.environment["HOBWORK_SMOKE_HOST"] ?? ""
        try XCTSkipIf(host.isEmpty, "Set HOBWORK_SMOKE_HOST to run against a host")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let notNow = springboard.buttons["Not Now"]
        if notNow.exists { notNow.tap() }

        let field = app.textFields["hobwork.example.com"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(host)
        app.buttons["Connect"].tap()

        // "Hobwork wants to use … to sign in"
        let proceed = springboard.buttons["Continue"]
        XCTAssertTrue(proceed.waitForExistence(timeout: 10), app.debugDescription)
        proceed.tap()

        let approve = approveButton()
        XCTAssertTrue(approve.waitForExistence(timeout: 15), "the pairing page did not load")
        approve.tap()

        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 10) { allow.tap() }

        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15))
        attach(app.screenshot(), name: "web UI")
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 10))
    }

    /// The authentication session's page runs in another process depending on the OS version.
    private func approveButton() -> XCUIElement {
        let candidates = [
            XCUIApplication(bundleIdentifier: "com.apple.SafariViewService"),
            springboard,
            XCUIApplication(),
        ]
        let deadline = Date.now.addingTimeInterval(15)
        while Date.now < deadline {
            for candidate in candidates {
                let link = candidate.buttons["Connect device"]
                if link.exists { return link }
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return candidates[0].buttons["Connect device"]
    }

    private func attach(_ screenshot: XCUIScreenshot, name: String) {
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
