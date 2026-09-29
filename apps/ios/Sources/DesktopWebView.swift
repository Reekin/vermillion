import SwiftUI
import WebKit

/// The system edge swipe returns to the desktop list only while the page shows its list level;
/// inside a session the page handles the edge swipe itself.
@MainActor enum PopGate { static var allowsPop = true }

extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        // Keep the edge swipe when a pushed screen hides the navigation bar.
        interactivePopGestureRecognizer?.delegate = self
    }
    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === interactivePopGestureRecognizer else { return true }
        return viewControllers.count > 1 && PopGate.allowsPop
    }
}

/// One live page per paired desktop. Leaving a desktop keeps its page, so returning shows it at once;
/// the HTTP cache persists so a cold start reuses downloaded assets.
@MainActor final class DesktopPages: ObservableObject {
    static let shared = DesktopPages()
    @Published private(set) var errors: [String: String] = [:]
    private var pages: [String: Page] = [:]
    private var visible: String?
    var exit: () -> Void = { DesktopStore.shared.path = [] }

    func webView(for desktop: Desktop) -> WKWebView {
        if let page = pages[desktop.id] { return page.webView }
        let page = Page(desktop: desktop, owner: self)
        pages[desktop.id] = page
        page.load(target: "")
        return page.webView
    }
    /// Shows `target` (a validated `#/…` route) in the desktop's page; an empty target keeps where the page was.
    func show(_ desktop: Desktop, target: String) {
        guard !target.isEmpty else { return }
        guard let page = pages[desktop.id], page.loaded else {
            let page = pages[desktop.id] ?? Page(desktop: desktop, owner: self)
            pages[desktop.id] = page
            page.load(target: target)
            return
        }
        let data = try! JSONSerialization.data(withJSONObject: target, options: [.fragmentsAllowed])
        page.webView.evaluateJavaScript("location.hash = \(String(decoding: data, as: UTF8.self))")
    }
    func reload(_ desktop: Desktop) {
        errors[desktop.id] = nil
        pages[desktop.id]?.load(target: "")
    }
    func appear(_ desktop: Desktop) {
        visible = desktop.id
        PopGate.allowsPop = pages[desktop.id]?.level != "session"
    }
    func remove(_ id: String) {
        pages.removeValue(forKey: id)?.close()
        errors[id] = nil
    }
    fileprivate func failed(_ id: String, _ message: String?) { errors[id] = message }
    fileprivate func levelChanged(_ id: String, _ level: String) {
        if visible == id { PopGate.allowsPop = level != "session" }
    }

    final class Page: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UIScrollViewDelegate {
        let desktop: Desktop
        let webView: WKWebView
        weak var owner: DesktopPages?
        var level = "list"
        var loaded = false
        init(desktop: Desktop, owner: DesktopPages) {
            self.desktop = desktop
            self.owner = owner
            let configuration = WKWebViewConfiguration()
            // Persistent website data keeps the HTTP cache; the credential is injected per page load and never stored.
            configuration.websiteDataStore = .default()
            configuration.userContentController.addUserScript(WKUserScript(
                source: RemotePolicy.injection(origin: desktop.origin, token: desktop.token),
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
            webView = WKWebView(frame: .zero, configuration: configuration)
            super.init()
            configuration.userContentController.add(self, name: "vermillion")
            webView.navigationDelegate = self
            webView.uiDelegate = self
            webView.allowsLinkPreview = false
            webView.isOpaque = false
            webView.backgroundColor = UIColor(red: 21 / 255, green: 21 / 255, blue: 23 / 255, alpha: 1)
            webView.underPageBackgroundColor = webView.backgroundColor
            // The page lays itself out to the visible area; the outer scroll view neither bounces nor zooms.
            webView.scrollView.contentInsetAdjustmentBehavior = .never
            webView.scrollView.isScrollEnabled = false
            webView.scrollView.bounces = false
            webView.scrollView.delegate = self
        }
        func load(target: String) {
            loaded = false
            level = target.hasPrefix("#/session/") ? "session" : "list"
            webView.load(URLRequest(url: URL(string: desktop.origin.absoluteString + "/" + target)!))
        }
        func close() {
            webView.stopLoading()
            webView.configuration.userContentController.removeScriptMessageHandler(forName: "vermillion")
            webView.navigationDelegate = nil; webView.uiDelegate = nil; webView.scrollView.delegate = nil
            webView.removeFromSuperview()
        }
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { nil }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(RemotePolicy.matches(navigationAction.request.url, origin: desktop.origin) ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(RemotePolicy.matches(navigationResponse.response.url, origin: desktop.origin) ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if RemotePolicy.matches(navigationAction.request.url, origin: desktop.origin) { webView.load(navigationAction.request) }
            return nil
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            let origin = desktop.origin
            let security = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame, security.protocol == "https", security.host == origin.host,
                  (security.port == 0 ? 443 : security.port) == (origin.port ?? 443),
                  RemotePolicy.matches(message.frameInfo.request.url, origin: origin),
                  let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            Task { @MainActor in
                if type == "exit" { self.owner?.exit() }
                if type == "level", let level = body["level"] as? String, level == "list" || level == "session" {
                    self.level = level
                    self.owner?.levelChanged(self.desktop.id, level)
                }
            }
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loaded = true
            Task { @MainActor in self.owner?.failed(self.desktop.id, nil) }
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
        /// iOS may end a kept page's web process in the background; reload it at the list level instead of showing a blank page.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            Task { @MainActor in
                self.level = "list"
                self.owner?.levelChanged(self.desktop.id, "list")
                self.load(target: "")
            }
        }
        private func fail(_ error: Error) {
            if (error as NSError).code == NSURLErrorCancelled { return }
            Task { @MainActor in self.owner?.failed(self.desktop.id, error.localizedDescription) }
        }
    }
}

/// A desktop's page, pushed full screen. The page draws its own top bar, so no navigation bar is shown.
struct DesktopWebScreen: View {
    let desktop: Desktop
    @ObservedObject var store: DesktopStore
    @ObservedObject private var pages = DesktopPages.shared
    var body: some View {
        ZStack {
            PooledWebView(desktop: desktop).ignoresSafeArea(.container)
            if let error = pages.errors[desktop.id] {
                VStack(spacing: 16) {
                    Text(error).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("重试") { pages.reload(desktop) }
                    Button("返回桌面列表") { store.path = [] }
                }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(uiColor: .systemBackground))
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .onAppear { pages.appear(desktop) }
    }
}

private struct PooledWebView: UIViewRepresentable {
    let desktop: Desktop
    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        let webView = DesktopPages.shared.webView(for: desktop)
        webView.removeFromSuperview()
        webView.frame = container.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(webView)
        return container
    }
    func updateUIView(_ container: UIView, context: Context) {}
}
