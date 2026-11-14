import Foundation

/// 项目、电脑、待批的请示、配对过的设备和项目报回聊天的结果。和网页版一样：收到「变了」的通知或者每 5 秒拉一次 /api/state。
/// 拿到 401 说明这台手机被吊销了，忘掉凭据回连接页。
///
/// 拉到的那一份标着是哪个身份的。读的时候只给现在这个身份的：换了身份，旧的立刻看不见，
/// 还在路上的旧回应到了也丢掉。`Store.shared.projects` 这样的读法按 `Snapshot` 的字段转过去。
@dynamicMemberLookup
final class Store {
    static let shared = Store()

    struct Snapshot {
        var projects: [Project] = []
        /// 全员空间，旧版云端是 nil。
        var everyone: Project?
        var chats: Chats = .mainOnly
        var computers: [Computer] = []
        var approvals: [Approval] = []
        var devices: [Device] = []
        /// 一起用这个 Pupu 的人，创建者在前。没开 Google 登录、还没有创建者时是空的。
        var members: [Member] = []
        /// 连上的账号和能连的服务。老版本的云端没有这一项，是空的。
        var connectors: Connectors = .empty
        /// 每台电脑在做什么，顺序和 computers 一样。
        var activity: [ComputerActivity] = []
        /// 项目报回聊天的结果，按时间先后。
        var reports: [ReportCard] = []
        /// 能选的预设头像。
        var avatarPresets: [AvatarPreset] = []
        /// Pupu 换过的头像地址，nil 用自带的。
        var pupuAvatar: String?
        var error: String?
        var loaded = false
    }

    /// 拉 /api/state：一次只拉一份。拉的时候又有人要，记下来，拉完再拉一次。
    /// 换了身份时旧的那一份不用等，新身份马上开拉，旧的回来就丢。
    private enum Fetch {
        case idle
        case running(Identity, again: Bool)
    }

    private var held: (owner: Identity, snapshot: Snapshot)?
    private var fetch: Fetch = .idle
    private var observers: [UUID: () -> Void] = [:]
    private var timer: Timer?

    private init() {
        NotificationCenter.default.addObserver(forName: Connection.changed, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                Store.shared.notify()
                Store.shared.refresh()
            }
        }
        NotificationCenter.default.addObserver(forName: .pupuBecameActive, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { Store.shared.refresh() }
        }
    }

    subscript<Value>(dynamicMember path: KeyPath<Snapshot, Value>) -> Value {
        current[keyPath: path]
    }

    /// 现在这个身份的那一份；换了身份、新的还没拉到时是空的。
    private var current: Snapshot {
        guard let held, held.owner == Connection.shared.identity else { return Snapshot() }
        return held.snapshot
    }

    var api: API? { Connection.shared.endpoint.map(API.init) }

    func project(id: String) -> Project? {
        if let everyone = current.everyone, everyone.id == id { return everyone }
        return current.projects.first { $0.id == id }
    }

    /// 空间列表：全员在第一个。
    var spaces: [Project] {
        (current.everyone.map { [$0] } ?? []) + current.projects
    }

    func computer(id: String) -> Computer? {
        current.computers.first { $0.id == id }
    }

    /// 该出现在这条聊天里的报告卡。
    func reportCards(in session: String) -> [ReportCard] {
        current.reports.filter { ($0.chat ?? Chats.mainOnly.main.session) == session }
    }

    /// 刚建好的项目：不等下一次拉状态就能打开。
    func added(_ project: Project) {
        guard let identity = Connection.shared.identity, self.project(id: project.id) == nil else { return }
        update(for: identity) { $0.projects.insert(project, at: 0) }
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
        guard let identity = Connection.shared.identity else { return }
        if case .running(identity, _) = fetch {
            fetch = .running(identity, again: true)
            return
        }
        fetch = .running(identity, again: false)
        Task {
            let result: Result<PupuState, any Error>
            do {
                result = .success(try await API(endpoint: identity.endpoint).state())
            } catch {
                result = .failure(error)
            }
            fetched(result, for: identity)
        }
    }

    private func fetched(_ result: Result<PupuState, any Error>, for identity: Identity) {
        guard case .running(identity, let again) = fetch else { return }
        fetch = .idle
        defer { if again { refresh() } }
        guard identity == Connection.shared.identity else { return }
        switch result {
        case .success(let state):
            update(for: identity) { snapshot in
                snapshot = Snapshot(
                    projects: state.projects,
                    everyone: state.everyone,
                    chats: state.chats ?? .mainOnly,
                    computers: state.computers,
                    approvals: state.approvals ?? [],
                    devices: state.devices ?? [],
                    members: state.members ?? [],
                    connectors: state.connectors ?? .empty,
                    activity: state.activity ?? [],
                    reports: state.reports ?? [],
                    avatarPresets: state.avatarPresets ?? [],
                    pupuAvatar: state.pupuAvatar,
                    error: nil,
                    loaded: true
                )
            }
            Push.shared.clearDelivered(pending: current.approvals.map(\.id))
        case .failure(let failure as APIError) where failure.unauthorized:
            Connection.shared.rejected(identity)
        case .failure(let failure):
            update(for: identity) { snapshot in
                snapshot.error = failure.localizedDescription
                snapshot.loaded = true
            }
        }
    }

    /// 会话连接上收到的 activity 帧：整份换掉，不用重新拉。`identity` 是那条连接的身份。
    func apply(activity next: [ComputerActivity], for identity: Identity) {
        guard next != current.activity else { return }
        update(for: identity) { $0.activity = next }
    }

    /// 改这个身份的那一份。不是现在的身份就不动。
    private func update(for identity: Identity, _ change: (inout Snapshot) -> Void) {
        guard identity == Connection.shared.identity else { return }
        var next = current
        change(&next)
        held = (identity, next)
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
