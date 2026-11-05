import Foundation

/// 项目、电脑、待批的请示、配对过的设备和项目报回聊天的结果。和网页版一样：收到「变了」的通知或者每 5 秒拉一次 /api/state。
/// 拿到 401 说明这台手机被吊销了，忘掉凭据回连接页。
final class Store {
    static let shared = Store()

    private(set) var projects: [Project] = []
    private(set) var chats: Chats = .mainOnly
    private(set) var computers: [Computer] = []
    private(set) var approvals: [Approval] = []
    private(set) var devices: [Device] = []
    /// 一起用这个 Pupu 的人，创建者在前。没开 Google 登录、还没有创建者时是空的。
    private(set) var members: [Member] = []
    /// 连上的账号和能连的服务。老版本的云端没有这一项，是空的。
    private(set) var connectors: Connectors = .empty
    /// 每台电脑在做什么，顺序和 computers 一样。
    private(set) var activity: [ComputerActivity] = []
    /// 项目报回聊天的结果，按时间先后。
    private(set) var reports: [ReportCard] = []
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

    /// 该出现在这条聊天里的报告卡。
    func reports(in session: String) -> [ReportCard] {
        reports.filter { ($0.chat ?? Chats.mainOnly.main.session) == session }
    }

    /// 刚建好的项目：不等下一次拉状态就能打开。
    func added(_ project: Project) {
        guard self.project(id: project.id) == nil else { return }
        projects.insert(project, at: 0)
        notify()
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
                chats = state.chats ?? .mainOnly
                computers = state.computers
                approvals = state.approvals ?? []
                devices = state.devices ?? []
                members = state.members ?? []
                connectors = state.connectors ?? .empty
                activity = state.activity ?? []
                reports = state.reports ?? []
                error = nil
                Push.shared.clearDelivered(pending: approvals.map(\.id))
            } catch let failure as APIError where failure.unauthorized {
                // 只忘掉发请求时用的那份凭据；这期间重新配对过的话，新的不动。
                if Connection.shared.endpoint == api.endpoint {
                    Connection.shared.forget(notice: "这台手机的凭据失效了，可能是在别的设备上被吊销了。重新配对一次。")
                }
                return
            } catch {
                self.error = error.localizedDescription
            }
            loaded = true
            notify()
        }
    }

    /// 会话连接上收到的 activity 帧：整份换掉，不用重新拉。
    func apply(activity next: [ComputerActivity]) {
        guard next != activity else { return }
        activity = next
        notify()
    }

    private func reset() {
        projects = []
        chats = .mainOnly
        computers = []
        approvals = []
        devices = []
        members = []
        connectors = .empty
        activity = []
        reports = []
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
