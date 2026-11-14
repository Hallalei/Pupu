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

    /// 远程桌面的信令：`/api/desktop/:id`。
    func desktopURL(computer id: String) -> URL {
        var components = URLComponents(url: base.appending(path: "api/desktop/\(id)"), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        return components.url!
    }

    func authorize(_ request: inout URLRequest) {
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }
}

/// 这台手机在哪个 Pupu 上、是哪台设备。重新配对就是新的身份，哪怕地址没变：
/// 一个地址上可以有好几个 Pupu（每人一个），凭据决定连的是哪一个。
nonisolated struct Identity: Equatable, Sendable {
    let endpoint: Endpoint
    /// 这台手机在 Pupu 上的设备 id，注销时用。
    let device: String?

    /// 本机按身份记的东西（看过的聊天、上次的项目）用它做键。凭据是机密，不放进键里。
    var key: String { "\(endpoint.base.absoluteString)#\(device ?? "")" }
}

/// 这台手机现在的身份。凭据放钥匙串，地址和设备 id 放 UserDefaults。
/// 身份一变（连上、换了一个、凭据没了）就发 `changed`，主界面整个重建。
final class Connection {
    static let shared = Connection()
    static let changed = Notification.Name("PupuConnectionChanged")

    private static let serverKey = "pupu.server"
    private static let deviceKey = "pupu.device"
    private static let tokenAccount = "device-token"

    private(set) var identity: Identity?
    /// 为什么回到了连接页，比如凭据被吊销了。连接页显示一次就清掉。
    var notice: String?

    var endpoint: Endpoint? { identity?.endpoint }

    /// 上次连的地址。凭据没了回到连接页时，地址已经填好。
    var lastServer: URL? {
        UserDefaults.standard.string(forKey: Self.serverKey).flatMap(URL.init(string:))
    }

    /// 模拟器里默认连本机的开发服务器（`npm run dev`，不要口令）；真机默认连线上。
    static var suggestedServer: String {
        #if targetEnvironment(simulator)
        "http://localhost:5173"
        #else
        "https://app.getpupu.com"
        #endif
    }

    private init() {
        if let server = lastServer, let token = Keychain.read(Self.tokenAccount) {
            identity = Identity(
                endpoint: Endpoint(base: server, token: token),
                device: UserDefaults.standard.string(forKey: Self.deviceKey)
            )
        }
    }

    /// 拿配对码（或者访问口令）换这台手机的凭据。
    /// 两样都不带，只有连本机的开发服务器、又没设访问口令时能过。
    func pair(base: URL, code: String?, accessToken: String?) async throws {
        adopt(base: base, paired: try await API.pair(base: base, code: code, accessToken: accessToken, name: UIDevice.current.name))
    }

    /// 存好换来的凭据，就算连上了。配对码和 Google 登录都走这里。
    /// 原来连着别的，先换成新的再去那边注销：那边回的 401 对不上现在的身份，不会被当成「被吊销了」。
    func adopt(base: URL, paired: Paired) {
        let previous = identity
        // 重新配对可能换了账号：切换时存下的别的 Pupu 的凭据不留。
        stashedOrgs().compactMap(takeOut).forEach(revoke)
        UserDefaults.standard.set(base.absoluteString, forKey: Self.serverKey)
        UserDefaults.standard.set(paired.id, forKey: Self.deviceKey)
        Keychain.write(paired.token, account: Self.tokenAccount)
        settle(Identity(endpoint: Endpoint(base: base, token: paired.token), device: paired.id), notice: nil)
        revoke(previous)
    }

    /// 从这个 Pupu 注销这台手机，回到连接页。先在本机忘掉，再去 Pupu 上吊销；
    /// 连不上就只忘掉，凭据留在设备列表里，可以从别处吊销。切换时存下的别的 Pupu 的凭据一起注销。
    func signOut() {
        let previous = identity
        let others = stashedOrgs().compactMap(takeOut)
        forget(notice: nil)
        revoke(previous)
        others.forEach(revoke)
    }

    /// Pupu 不认这份凭据了（401）。只算现在这个身份的：换走之前那份的回应晚到了，不当回事。
    /// 还存着别的 Pupu 的凭据（比如被移出了这一个），换到那边，不回连接页。
    func rejected(_ rejected: Identity) {
        guard rejected == identity else { return }
        // 不用 lazy.compactMap(...).first：lazy 集合取 first 会把 takeOut 跑两遍，第二遍已经取空了。
        for org in stashedOrgs() {
            guard let next = takeOut(org) else { continue }
            activate(next, notice: "你已经不在刚才那个 Pupu 里了。")
            return
        }
        forget(notice: "这台手机的授权失效了，重新配对一次就好。")
    }

    // MARK: 一个账号在好几个 Pupu 里

    /// 凭据前面带着它所在 Pupu 的 id，第一个 Pupu 的没有前缀（云端 directory.ts 的 `pupuOfCredential`）。
    nonisolated static func org(of token: String) -> String {
        guard let dot = token.firstIndex(of: "."), dot != token.startIndex else { return "me" }
        return String(token[..<dot])
    }

    /// 现在连着的是哪个 Pupu。
    var currentOrg: String? { identity?.endpoint.token.map(Self.org) }

    private static let orgDevicesKey = "pupu.orgDevices"

    private static func orgAccount(_ org: String) -> String { "org-token:\(org)" }

    /// 切走时存下的别的 Pupu：id 到设备 id。凭据在钥匙串里，一个 Pupu 一条。
    private var orgDevices: [String: String] {
        get { UserDefaults.standard.dictionary(forKey: Self.orgDevicesKey) as? [String: String] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: Self.orgDevicesKey) }
    }

    private func stashedOrgs() -> [String] { orgDevices.keys.sorted() }

    /// 把现在的身份收起来，切回来时不用再换一次凭据。
    private func stash(_ identity: Identity?) {
        guard let identity, let token = identity.endpoint.token, let device = identity.device else { return }
        let org = Self.org(of: token)
        Keychain.write(token, account: Self.orgAccount(org))
        orgDevices[org] = device
    }

    /// 取出存着的一个 Pupu 的身份，取出就从存的里面删掉。
    private func takeOut(_ org: String) -> Identity? {
        let device = orgDevices[org]
        orgDevices[org] = nil
        let token = Keychain.read(Self.orgAccount(org))
        Keychain.write(nil, account: Self.orgAccount(org))
        guard let base = lastServer, let token, let device else { return nil }
        return Identity(endpoint: Endpoint(base: base, token: token), device: device)
    }

    private func activate(_ next: Identity, notice: String?) {
        UserDefaults.standard.set(next.device, forKey: Self.deviceKey)
        Keychain.write(next.endpoint.token, account: Self.tokenAccount)
        settle(next, notice: notice)
    }

    /// 某个 Pupu 的接口：现在连着的，或者切走时存着凭据的。推送上点「允许」时按推送带的 Pupu 挑。
    func api(org: String?) -> API? {
        guard let identity else { return nil }
        guard let org, org != currentOrg else { return API(endpoint: identity.endpoint) }
        guard let token = Keychain.read(Self.orgAccount(org)) else { return nil }
        return API(endpoint: Endpoint(base: identity.endpoint.base, token: token))
    }

    /// 切到 `org`。存过它的凭据就直接换上；没有就让现在这个 Pupu 开一个码，用这台手机的 verifier 去换。
    /// 那边已经有手机时要已有的手机点允许，`progress` 在等的时候调，和 Google 登录一样。
    func switchTo(org: String, progress: @escaping (SignIn.Progress) -> Void) async throws {
        guard let current = identity, org != currentOrg else { return }
        if let saved = takeOut(org) {
            stash(current)
            activate(saved, notice: nil)
            return
        }
        let verifier = SignIn.newVerifier()
        let code = try await API(endpoint: current.endpoint).switchOrg(org, challenge: SignIn.challenge(for: verifier))
        try await enter(code: code, verifier: verifier, progress: progress)
    }

    /// 用邀请码开自己的 Pupu，开好就切过去。
    func openOwn(code invite: String, progress: @escaping (SignIn.Progress) -> Void) async throws {
        guard let current = identity else { return }
        let verifier = SignIn.newVerifier()
        let code = try await API(endpoint: current.endpoint).openOwnOrg(code: invite, challenge: SignIn.challenge(for: verifier))
        try await enter(code: code, verifier: verifier, progress: progress)
    }

    private func enter(code: String, verifier: String, progress: @escaping (SignIn.Progress) -> Void) async throws {
        guard let base = identity?.endpoint.base else { return }
        while true {
            try Task.checkCancellation()
            switch try await API.redeemSignIn(base: base, code: code, verifier: verifier, name: UIDevice.current.name) {
            case .paired(let paired):
                stash(identity)
                activate(Identity(endpoint: Endpoint(base: base, token: paired.token), device: paired.id), notice: nil)
                return
            case .waiting(let expiresAt):
                progress(.waiting(expiresAt: expiresAt))
                try await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// 忘掉凭据，回到连接页。地址留着，重新配对时不用再填。
    private func forget(notice: String?) {
        UserDefaults.standard.removeObject(forKey: Self.deviceKey)
        Keychain.write(nil, account: Self.tokenAccount)
        settle(nil, notice: notice)
    }

    private func settle(_ next: Identity?, notice: String?) {
        identity = next
        self.notice = notice
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }

    private func revoke(_ identity: Identity?) {
        guard let identity, let device = identity.device else { return }
        Task { try? await API(endpoint: identity.endpoint).revoke(device: device) }
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
