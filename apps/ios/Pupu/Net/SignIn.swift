import AuthenticationServices
import CryptoKit
import UIKit

/// 用 Google 登录连上 Pupu，换掉配对码。
///
/// Google 不让在内嵌网页里登录，所以用 ASWebAuthenticationSession：系统的登录页，和 Safari 共用 Google 的登录状态。
/// 1. 这台手机先生成一个 verifier，只把它的 SHA-256（challenge）放进登录地址；
/// 2. 在 Google 登录完，Pupu 跳回 `pupu://auth?code=…`。这个 scheme 由登录会话直接接住，别的 App 拿不到；
/// 3. 拿 code 和 verifier 去换凭据。以前配过手机的话，要已经连上的手机点「允许」，这里每两秒问一次，等到为止。
///
/// 写法对照了 supabase-swift 的 ASWebAuthenticationSessionPresenter（取消算 CancellationError、
/// 会话结束前留着 presentationContextProvider），代码是自己写的。
final class SignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    /// 新手机在等已有手机点允许。`expiresAt` 是毫秒时间戳。
    nonisolated enum Progress: Sendable {
        case waiting(expiresAt: Double)
    }

    private let anchor: UIWindow?
    private var session: ASWebAuthenticationSession?

    init(anchor: UIWindow?) {
        self.anchor = anchor
    }

    /// 32 字节随机数，base64url，43 个字符。
    nonisolated static func newVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return base64url(Data(bytes))
    }

    nonisolated static func challenge(for verifier: String) -> String {
        base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    nonisolated private static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// 走完整个登录，返回这台手机的凭据。`progress` 在要等已有手机点允许时调。取消时抛 CancellationError。
    func run(base: URL, progress: @escaping (Progress) -> Void) async throws -> Paired {
        let verifier = Self.newVerifier()
        let code = try await authorize(base: base, challenge: Self.challenge(for: verifier))
        let name = UIDevice.current.name
        while true {
            try Task.checkCancellation()
            switch try await API.redeemSignIn(base: base, code: code, verifier: verifier, name: name) {
            case .paired(let paired):
                return paired
            case .waiting(let expiresAt):
                progress(.waiting(expiresAt: expiresAt))
                try await Task.sleep(for: .seconds(2))
            }
        }
    }

    func cancel() {
        session?.cancel()
        session = nil
    }

    /// 打开系统登录页，等 Pupu 跳回 `pupu://auth`，返回一次性的 code。
    private func authorize(base: URL, challenge: String) async throws -> String {
        guard var components = URLComponents(url: base.appending(path: "api/auth/google/start"), resolvingAgainstBaseURL: false)
        else { throw APIError(message: "地址不对。") }
        components.queryItems = [
            URLQueryItem(name: "client", value: "phone"),
            URLQueryItem(name: "challenge", value: challenge)
        ]
        guard let url = components.url else { throw APIError(message: "地址不对。") }

        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callback: .customScheme("pupu")) { url, error in
                if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: CancellationError())
                } else if let error {
                    continuation.resume(throwing: APIError(message: "登录页打不开：\(error.localizedDescription)"))
                } else if let url {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: APIError(message: "登录没有结果，再试一次。"))
                }
            }
            session.presentationContextProvider = self
            // 和 Safari 共用登录状态：Safari 里登着 Google 的话不用再输密码。
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                continuation.resume(throwing: APIError(message: "登录页打不开，再试一次。"))
            }
        }
        session = nil

        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if let error = items.first(where: { $0.name == "error" })?.value {
            throw APIError(message: error)
        }
        guard callback.host() == "auth", let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
            throw APIError(message: "登录没有结果，再试一次。")
        }
        return code
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor ?? ASPresentationAnchor()
    }
}
