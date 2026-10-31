import Foundation
import Security
import UIKit

/// 连哪个 Pupu、用哪份设备凭据。凭据放钥匙串，地址放 UserDefaults。
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

/// 这台手机连的是哪个 Pupu。凭据是配对时换来的，这台手机独一份，可以单独吊销。
final class Connection {
    static let shared = Connection()
    static let changed = Notification.Name("PupuConnectionChanged")

    private static let serverKey = "pupu.server"
    private static let deviceKey = "pupu.device"
    private static let tokenAccount = "device-token"

    private(set) var endpoint: Endpoint?
    /// 这台手机在 Pupu 上的设备 id。注销时用。
    private(set) var deviceId: String?
    /// 为什么回到了连接页，比如凭据被吊销了。连接页显示一次就清掉。
    var notice: String?

    /// 上次连的地址。凭据没了回到连接页时，地址已经填好。
    var lastServer: URL? {
        UserDefaults.standard.string(forKey: Self.serverKey).flatMap(URL.init(string:))
    }

    /// 模拟器里默认连本机的开发服务器（`npm run dev`，不要口令）；真机默认连线上。
    static var suggestedServer: String {
        #if targetEnvironment(simulator)
        "http://localhost:5173"
        #else
        "https://pupu.cobuilder-team.workers.dev"
        #endif
    }

    private init() {
        if let server = lastServer, let token = Keychain.read(Self.tokenAccount) {
            endpoint = Endpoint(base: server, token: token)
            deviceId = UserDefaults.standard.string(forKey: Self.deviceKey)
        }
    }

    /// 拿配对码（或者访问口令）换这台手机的凭据，存好就算连上了。
    /// 两样都不带，只有连本机的开发服务器、又没设访问口令时能过。
    /// 原来连着别的 Pupu，换过去之前先在那边注销。
    func pair(base: URL, code: String?, accessToken: String?) async throws {
        let paired = try await API.pair(base: base, code: code, accessToken: accessToken, name: UIDevice.current.name)
        await revokeSelf()
        UserDefaults.standard.set(base.absoluteString, forKey: Self.serverKey)
        UserDefaults.standard.set(paired.id, forKey: Self.deviceKey)
        Keychain.write(paired.token, account: Self.tokenAccount)
        endpoint = Endpoint(base: base, token: paired.token)
        deviceId = paired.id
        notice = nil
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }

    /// 在 Pupu 上注销这台手机，再忘掉凭据。连不上就只忘掉，凭据留在设备列表里，可以从别处吊销。
    func signOut() async {
        await revokeSelf()
        forget()
    }

    /// 忘掉凭据，回到连接页。地址留着，重新配对时不用再填。
    func forget(notice: String? = nil) {
        UserDefaults.standard.removeObject(forKey: Self.deviceKey)
        Keychain.write(nil, account: Self.tokenAccount)
        endpoint = nil
        deviceId = nil
        self.notice = notice
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }

    private func revokeSelf() async {
        guard let endpoint, let deviceId else { return }
        try? await API(endpoint: endpoint).revoke(device: deviceId)
    }

    /// 网页设置里二维码的内容：`pupu://pair?server=https://…&code=XXXX-XXXX`。
    static func pairLink(_ url: URL) -> (server: URL, code: String)? {
        guard url.scheme == "pupu", url.host() == "pair",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let server = items.first(where: { $0.name == "server" })?.value.flatMap(normalize),
              let code = items.first(where: { $0.name == "code" })?.value, !code.isBlank
        else { return nil }
        return (server, code)
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
