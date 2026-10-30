import Foundation

/// 项目、电脑和待批的请示。和网页版一样：收到「变了」的通知或者每 5 秒拉一次 /api/state。
final class Store {
    static let shared = Store()

    private(set) var projects: [Project] = []
    private(set) var computers: [Computer] = []
    private(set) var approvals: [Approval] = []
    private(set) var error: String?
    private(set) var loaded = false

    private var observers: [UUID: () -> Void] = [:]
    private var timer: Timer?
    private var refreshing = false
    private var again = false

    private init() {
        NotificationCenter.default.addObserver(forName: Connection.changed, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                Store.shared.reset()
                Store.shared.refresh()
            }
        }
        NotificationCenter.default.addObserver(forName: .pupuBecameActive, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { Store.shared.refresh() }
        }
    }

    var api: API? { Connection.shared.endpoint.map(API.init) }

    func project(id: String) -> Project? {
        projects.first { $0.id == id }
    }

    func computer(id: String) -> Computer? {
        computers.first { $0.id == id }
    }

    /// 注册一个回调，状态变了就调；返回的令牌释放时自动注销。
    func observe(_ callback: @escaping () -> Void) -> StoreToken {
        let id = UUID()
        observers[id] = callback
        return StoreToken { [weak self] in self?.observers[id] = nil }
    }

    func startPolling() {
        guard timer == nil else { return }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            MainActor.assumeIsolated { Store.shared.refresh() }
        }
    }

    func refresh() {
        guard let api else { return }
        if refreshing {
            again = true
            return
        }
        refreshing = true
        Task {
            defer {
                refreshing = false
                if again {
                    again = false
                    refresh()
                }
            }
            do {
                let state = try await api.state()
                projects = state.projects
                computers = state.computers
                approvals = state.approvals ?? []
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
            loaded = true
            notify()
        }
    }

    private func reset() {
        projects = []
        computers = []
        approvals = []
        error = nil
        loaded = false
        notify()
    }

    private func notify() {
        for callback in observers.values { callback() }
    }
}

final class StoreToken {
    private let cancel: () -> Void

    init(_ cancel: @escaping () -> Void) {
        self.cancel = cancel
    }

    isolated deinit { cancel() }
}
