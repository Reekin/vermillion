import Foundation
import Security

struct Desktop: Codable, Identifiable, Equatable {
    var id: String { origin.absoluteString }
    let origin: URL
    let deviceId: String
    var name: String
    let token: String
    var online: Bool? = nil
    var inboxCount: Int = 0
    var pushError: String? = nil
    enum CodingKeys: String, CodingKey { case origin, deviceId, name, token }
}

enum RemoteError: LocalizedError {
    case invalidAddress, invalidPairing, response(Int), keychain(OSStatus), invalidNotification
    var errorDescription: String? {
        switch self {
        case .invalidAddress: return "请输入 HTTPS 公网地址，不含路径、账号或查询参数。"
        case .invalidPairing: return "配对二维码无效。"
        case .response(let status): return "桌面请求失败（HTTP \(status)）。请检查地址、配对码或重新配对。"
        case .keychain(let status): return "无法访问钥匙串（\(status)）。"
        case .invalidNotification: return "通知目标无效或桌面尚未配对。"
        }
    }
}

enum RemotePolicy {
    static func origin(_ value: String) throws -> URL {
        guard var c = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              c.scheme?.lowercased() == "https", let host = c.host, !host.isEmpty,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/", c.port == nil || (1...65535).contains(c.port!) else {
            throw RemoteError.invalidAddress
        }
        c.scheme = "https"; c.host = host.lowercased(); c.path = ""
        if c.port == 443 { c.port = nil }
        guard let url = c.url else { throw RemoteError.invalidAddress }
        return url
    }
    static func matches(_ url: URL?, origin: URL) -> Bool {
        guard let url else { return false }
        return url.scheme == "https" && url.host?.lowercased() == origin.host?.lowercased()
            && (url.port ?? 443) == (origin.port ?? 443) && url.user == nil && url.password == nil
    }
    static func pairing(_ value: URL) throws -> (URL, String, String) {
        guard let c = URLComponents(url: value, resolvingAgainstBaseURL: false),
              c.scheme == "vermillion", c.host == "pair" else { throw RemoteError.invalidPairing }
        let items = c.queryItems ?? []
        func field(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard let address = field("url"), let code = field("code"), code.count == 8 else { throw RemoteError.invalidPairing }
        return (try origin(address), code, field("name") ?? "")
    }
    static func target(_ value: String) -> Bool {
        if value == "#/inbox" { return true }
        let parts = value.split(separator: "/", omittingEmptySubsequences: false)
        return parts.first == "#" && ((parts.count == 3 && parts[1] == "session")
            || (parts.count == 4 && parts[1] == "inbox"))
            && parts.dropFirst(2).allSatisfy { !$0.isEmpty && !$0.contains("#") && !$0.contains("?") }
    }
    static func injection(origin: URL, token: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: ["origin": origin.absoluteString, "token": token], options: [.fragmentsAllowed])
        let json = String(decoding: data, as: UTF8.self)
        return "(() => { const v = \(json); if (window === window.top && location.origin === v.origin) { window.__VERMILLION_REMOTE__ = {token:v.token}; } })();"
    }
}

enum Credentials {
    private static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "app.vermillion.mobile.desktops", kSecAttrAccount as String: "paired-desktops"]
    static func load() throws -> [Desktop] {
        var q = query; q[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let data = result as? Data else { throw RemoteError.keychain(status) }
        return try JSONDecoder().decode([Desktop].self, from: data)
    }
    static func save(_ desktops: [Desktop]) throws {
        let data = try JSONEncoder().encode(desktops)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var q = query; q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let added = SecItemAdd(q as CFDictionary, nil)
            guard added == errSecSuccess else { throw RemoteError.keychain(added) }
        } else if status != errSecSuccess { throw RemoteError.keychain(status) }
    }
}

// Reject redirects before URLSession can forward a pairing code or credential.
final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum Gateway {
    static let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
    static func request(origin: URL, path: String, method: String = "GET", token: String? = nil,
                        body: [String: String]? = nil) async throws -> Data {
        var request = URLRequest(url: origin.appendingPathComponent(path))
        request.httpMethod = method; request.timeoutInterval = 12
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else { throw RemoteError.response(status) }
        return data
    }
}
