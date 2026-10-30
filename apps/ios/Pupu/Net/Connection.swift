import Foundation
import Security

/// 连哪个 Pupu、用什么口令。口令放钥匙串，地址放 UserDefaults。
nonisolated struct Endpoint: Equatable, Sendable {
    let base: URL
    let token: String?

    func url(_ path: String) -> URL {
        base.appending(path: path)
    }

    /// 会话的 WebSocket：`/agents/pupu/me?session=…`，和网页版的 useAgent 一样。
    func socketURL(session: String) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/agents/pupu/me"
        components.queryItems = [
            URLQueryItem(name: "_pk", value: UUID().uuidString),
            URLQueryItem(name: "session", value: session)
        ]
        return components.url!
    }

    func authorize(_ request: inout URLRequest) {
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }
}

final class Connection {
    static let shared = Connection()
    static let changed = Notification.Name("PupuConnectionChanged")

    private static let serverKey = "pupu.server"
    private static let tokenAccount = "access-token"

    private(set) var endpoint: Endpoint?

    /// 模拟器里默认连本机的开发服务器（`npm run dev`，不要口令）；真机默认连线上。
    static var suggestedServer: String {
        #if targetEnvironment(simulator)
        "http://localhost:5173"
        #else
        "https://pupu.cobuilder-team.workers.dev"
        #endif
    }

    private init() {
        if let saved = UserDefaults.standard.string(forKey: Self.serverKey), let url = URL(string: saved) {
            endpoint = Endpoint(base: url, token: Keychain.read(Self.tokenAccount))
        }
    }

    func save(_ endpoint: Endpoint) {
        UserDefaults.standard.set(endpoint.base.absoluteString, forKey: Self.serverKey)
        Keychain.write(endpoint.token, account: Self.tokenAccount)
        self.endpoint = endpoint
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }

    func forget() {
        UserDefaults.standard.removeObject(forKey: Self.serverKey)
        Keychain.write(nil, account: Self.tokenAccount)
        endpoint = nil
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }

    /// 把用户填的地址整理成只有协议和主机的形式。
    static func normalize(_ text: String) -> URL? {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return nil }
        if !value.contains("://") { value = "https://\(value)" }
        guard var components = URLComponents(string: value),
              let scheme = components.scheme, scheme == "https" || scheme == "http",
              components.host?.isEmpty == false
        else { return nil }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url
    }
}

nonisolated enum Keychain {
    private static let service = "com.leizi.pupu"

    static func read(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ value: String?, account: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(base as CFDictionary)
        guard let value, !value.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}
