import SwiftUI
import WebKit

struct DesktopWebScreen: View {
    let destination: Destination
    let exit: () -> Void
    @State private var error: String?
    @State private var reload = UUID()
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let error {
                    Text(error).foregroundStyle(.secondary)
                    Button("重试") { self.error = nil; reload = UUID() }
                }
                DesktopWebView(destination: destination, exit: exit, failure: { error = $0 }).id(reload)
            }.navigationTitle(destination.desktop.name).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarLeading) { Button("桌面列表", action: exit) } }
        }
    }
}

struct DesktopWebView: UIViewRepresentable {
    let destination: Destination
    let exit: () -> Void
    let failure: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(WKUserScript(
            source: RemotePolicy.injection(origin: destination.desktop.origin, token: destination.desktop.token),
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController.add(context.coordinator, name: "vermillion")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        let url = URL(string: destination.desktop.origin.absoluteString + "/" + destination.target)!
        webView.load(URLRequest(url: url))
        return webView
    }
    func updateUIView(_ webView: WKWebView, context: Context) {}
    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "vermillion")
        webView.navigationDelegate = nil; webView.uiDelegate = nil
    }
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let parent: DesktopWebView
        init(_ parent: DesktopWebView) { self.parent = parent }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(RemotePolicy.matches(navigationAction.request.url, origin: parent.destination.desktop.origin) ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(RemotePolicy.matches(navigationResponse.response.url, origin: parent.destination.desktop.origin) ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if RemotePolicy.matches(navigationAction.request.url, origin: parent.destination.desktop.origin) {
                webView.load(navigationAction.request)
            }
            return nil
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            let origin = parent.destination.desktop.origin
            let security = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame, security.protocol == "https", security.host == origin.host,
                  (security.port == 0 ? 443 : security.port) == (origin.port ?? 443),
                  RemotePolicy.matches(message.frameInfo.request.url, origin: origin),
                  let body = message.body as? [String: Any], body["type"] as? String == "exit" else { return }
            parent.exit()
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { parent.failure(error.localizedDescription) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { parent.failure(error.localizedDescription) }
    }
}
