import Foundation

nonisolated struct APIError: LocalizedError {
    let message: String
    /// 401：凭据不对，或者这台手机被吊销了。
    var unauthorized = false
    var errorDescription: String? { message }
}

/// Pupu 的 REST 接口，和网页版的 src/client/api.ts 对应。
nonisolated struct API: Sendable {
    let endpoint: Endpoint

    func state() async throws -> PupuState {
        try await send("api/state")
    }

    func createProject(name: String, goal: String) async throws -> Project {
        try await send("api/projects", method: "POST", body: ["name": name, "goal": goal])
    }

    /// 打开了这个项目：它报回聊天的结果都算看过。
    func markSeen(project id: String) async throws {
        let _: Done = try await send("api/projects/\(id)/seen", method: "POST", body: [:])
    }

    func revoke(computer id: String) async throws {
        let _: Done = try await send("api/computers/\(id)/revoke", method: "POST", body: [:])
    }

    /// 收回这台电脑的屏幕控制，和电脑菜单栏上的收回一样。
    func takeback(computer id: String) async throws {
        let _: Done = try await send("api/computers/\(id)/takeback", method: "POST", body: [:])
    }

    func setPolicy(_ policy: Computer.Policy, computer id: String) async throws {
        let _: Done = try await send("api/computers/\(id)/policy", method: "POST", body: ["policy": policy.rawValue])
    }

    func decide(approval id: String, allow: Bool) async throws {
        let _: Done = try await send("api/approvals/\(id)", method: "POST", body: ["decision": allow ? "allow" : "deny"])
    }

    /// 把这台手机的推送 token 交给 Pupu。type：alert 是普通通知，start 是实时活动的 push-to-start，
    /// activity 是正开着的那个实时活动自己的。
    func registerPush(token: String, type: String, env: String) async throws {
        let _: Done = try await send("api/push-tokens", method: "POST", body: ["token": token, "type": type, "env": env])
    }

    /// 实时活动结束或被划掉了，它的 token 用不着了。
    func unregisterPush(token: String) async throws {
        let _: Done = try await send("api/push-tokens/\(token)", method: "DELETE")
    }

    /// 让 Pupu 给这台手机发一条测试通知，带回 APNs 的回答。
    func testPush() async throws -> PushTest {
        try await send("api/push-tokens/test", method: "POST", body: [:])
    }

    /// 新手机拿配对码（或访问口令）换自己的凭据。这时还没有凭据，所以不挂在某个 endpoint 上。
    static func pair(base: URL, code: String?, accessToken: String?, name: String) async throws -> Paired {
        var body = ["kind": "phone", "name": name]
        if let code { body["code"] = code }
        if let accessToken { body["accessToken"] = accessToken }
        return try await API(endpoint: Endpoint(base: base, token: nil)).send("api/pair", method: "POST", body: body)
    }

    /// 换凭据的结果：拿到了，或者还在等已有手机点允许。
    nonisolated enum Redeemed: Sendable {
        case paired(Paired)
        case waiting(expiresAt: Double)
    }

    private struct RedeemBody: Decodable {
        let status: String
        let device: Paired?
        let expiresAt: Double?
    }

    /// 用 Google 登录回来的一次性 code，加上这台手机留着的 verifier，换凭据。见 src/auth/routes.ts 的 /api/auth/redeem。
    static func redeemSignIn(base: URL, code: String, verifier: String, name: String) async throws -> Redeemed {
        let body: RedeemBody = try await API(endpoint: Endpoint(base: base, token: nil)).send(
            "api/auth/redeem",
            method: "POST",
            body: ["code": code, "verifier": verifier, "name": name]
        )
        if body.status == "waiting", let expiresAt = body.expiresAt { return .waiting(expiresAt: expiresAt) }
        guard let device = body.device else { throw APIError(message: "Pupu 给的凭据不完整。") }
        return .paired(device)
    }

    func createPairingCode() async throws -> PairingCode {
        try await send("api/pairing-codes", method: "POST", body: [:])
    }

    func revoke(device id: String) async throws {
        let _: Done = try await send("api/devices/\(id)/revoke", method: "POST", body: [:])
    }

    /// 邀请成员。只有创建者在手机上能邀请（云端 members.ts 的 mayInvite）。
    func invite(email: String) async throws {
        let _: Done = try await send("api/members", method: "POST", body: ["email": email])
    }

    /// 邀请码：开新 Pupu 用的，只有第一个 Pupu 的创建者能管，别人拿到 403。
    func invites() async throws -> InviteList {
        try await send("api/invites")
    }

    func createInvite() async throws -> String {
        let created: Created = try await send("api/invites", method: "POST", body: [:])
        return created.code
    }

    func revoke(invite code: String) async throws {
        let encoded = code.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? code
        let _: Done = try await send("api/invites/\(encoded)/revoke", method: "POST", body: [:])
    }

    /// 移除成员：他名下的设备和电脑一起吊销。只有创建者能做。
    func remove(member id: String) async throws {
        let _: Done = try await send("api/members/\(id)/remove", method: "POST", body: [:])
    }

    /// 连一个账号：返回授权页地址，在系统登录页里打开，见 SignIn.connect。只能在手机上做。
    func connect(service: String) async throws -> URL {
        let started: Started = try await send("api/connectors/\(service)/connect", method: "POST", body: [:])
        guard let url = URL(string: started.url) else { throw APIError(message: "授权页地址不对。") }
        return url
    }

    /// 断开一个账号，open-connector 那边一起撤销授权。
    func remove(connector id: String) async throws {
        let _: Done = try await send("api/connectors/\(id)/remove", method: "POST", body: [:])
    }

    private struct Started: Decodable { let url: String }
    private struct Created: Decodable { let code: String }
    private struct Done: Decodable {}
    private struct Failure: Decodable { let error: String }

    /// 换自己的头像：一个预设的 id，或者 nil 换回名字的第一个字。只能换自己的（云端 avatars.ts）。
    func setAvatar(preset: String?) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["preset": preset.map { $0 as Any } ?? NSNull()])
        let _: Done = try await send("api/me/avatar", method: "POST", raw: body, type: "application/json")
    }

    /// 上传自己的头像：已经裁成方形、缩到 256 的 JPEG。云端只验不转码。
    func uploadAvatar(_ data: Data, type: String) async throws {
        let _: Done = try await send("api/me/avatar", method: "PUT", raw: data, type: type)
    }

    private func send<T: Decodable>(_ path: String, method: String = "GET", body: [String: String]? = nil) async throws -> T {
        try await send(path, method: method, raw: body.map { try JSONSerialization.data(withJSONObject: $0) }, type: "application/json")
    }

    private func send<T: Decodable>(_ path: String, method: String, raw body: Data?, type: String) async throws -> T {
        var request = URLRequest(url: endpoint.url(path))
        request.httpMethod = method
        request.timeoutInterval = 20
        endpoint.authorize(&request)
        if let body {
            request.httpBody = body
            request.setValue(type, forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw APIError(message: "连不上 Pupu：\(error.localizedDescription)")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let failure = try? JSONDecoder().decode(Failure.self, from: data)
            if status == 401 {
                throw APIError(message: failure?.error ?? "这台手机的凭据失效了，或者被吊销了。", unauthorized: true)
            }
            if let failure { throw APIError(message: failure.error) }
            throw APIError(message: "请求失败：\(status)")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
