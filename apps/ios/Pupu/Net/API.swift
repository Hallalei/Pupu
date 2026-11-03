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

    /// 把这台手机的推送 token 交给 Pupu。type：alert 是普通通知，start 是实时活动的 push-to-start。
    func registerPush(token: String, type: String, env: String) async throws {
        let _: Done = try await send("api/push-tokens", method: "POST", body: ["token": token, "type": type, "env": env])
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

    func createPairingCode() async throws -> PairingCode {
        try await send("api/pairing-codes", method: "POST", body: [:])
    }

    func revoke(device id: String) async throws {
        let _: Done = try await send("api/devices/\(id)/revoke", method: "POST", body: [:])
    }

    private struct Done: Decodable {}
    private struct Failure: Decodable { let error: String }

    private func send<T: Decodable>(_ path: String, method: String = "GET", body: [String: String]? = nil) async throws -> T {
        var request = URLRequest(url: endpoint.url(path))
        request.httpMethod = method
        request.timeoutInterval = 20
        endpoint.authorize(&request)
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
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
