import Foundation

nonisolated struct APIError: LocalizedError {
    let message: String
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

    func revoke(computer id: String) async throws {
        let _: Done = try await send("api/computers/\(id)/revoke", method: "POST", body: [:])
    }

    func setPolicy(_ policy: Computer.Policy, computer id: String) async throws {
        let _: Done = try await send("api/computers/\(id)/policy", method: "POST", body: ["policy": policy.rawValue])
    }

    func decide(approval id: String, allow: Bool) async throws {
        let _: Done = try await send("api/approvals/\(id)", method: "POST", body: ["decision": allow ? "allow" : "deny"])
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
            if let failure = try? JSONDecoder().decode(Failure.self, from: data) {
                throw APIError(message: failure.error)
            }
            if status == 401 { throw APIError(message: "访问口令不对，或者还没填。") }
            throw APIError(message: "请求失败：\(status)")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
