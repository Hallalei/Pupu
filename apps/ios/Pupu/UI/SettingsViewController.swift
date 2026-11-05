import UIKit

/// 「我」：右上角点进来的那一页，照 Hark 的设置页做。第一页上面是我是谁，下面两组入口，点进去是二级页：
/// 账户（连接器）、电脑和它的权限分级、成员、通知、设备和配对码、关于（连的是哪个 Pupu）。
/// 一页一个 `Page`，共用这一个类：列表、格子、点了做什么都在这里。
final class SettingsViewController: UICollectionViewController {
    nonisolated enum Page: Hashable, Sendable {
        case root
        case accounts
        case computers
        case computer(String)
        case members
        case notifications
        case devices
        case about

        var title: String? {
            switch self {
            case .root: nil
            case .accounts: "账户"
            case .computers: "电脑"
            case .computer: nil
            case .members: "成员"
            case .notifications: "通知"
            case .devices: "设备"
            case .about: "关于"
            }
        }

        var symbol: String {
            switch self {
            case .accounts: "link"
            case .computers, .computer: "desktopcomputer"
            case .members: "person.2"
            case .notifications: "bell"
            case .devices: "iphone"
            case .about, .root: "info.circle"
            }
        }
    }

    nonisolated private enum Section: Hashable, Sendable {
        case profile
        case pages(Int)
        case connected
        case services
        case computers
        case remoteDesktop
        case policy(computerId: String)
        case abilities
        case revokeComputer
        case notifications
        case members
        case devices
        case pair
        case connection
        case note
    }

    nonisolated private enum Item: Hashable, Sendable {
        case profile(title: String, detail: String)
        case link(Page, summary: String?)
        case account(Connectors.Account, owner: String?)
        case service(Connectors.Service, busy: Bool)
        case computer(Computer)
        case noComputer
        case remoteDesktop(Computer)
        case policy(computerId: String, policy: Computer.Policy, selected: Bool)
        case revokeComputer(Computer)
        case notifications(Push.Status, busy: Bool)
        case member(Member, removable: Bool)
        case invite
        case device(Device)
        case noDevice
        case newCode(note: String, busy: Bool)
        case code(PairingCode)
        case bridgeCommand(String)
        case server(String)
        case version(String)
        case disconnect
        case note(String)
    }

    private let page: Page
    private var source: UICollectionViewDiffableDataSource<Section, Item>!
    private var token: StoreToken?
    /// 刚复制的那段文字，对应的那一行写「已复制」。
    private var copied: String?
    private var pairing: PairingCode?
    /// 生成配对码时已经连上的设备和电脑。之后多出来的那台，就是用这个码连上的。
    private var known: Set<String> = []
    private var joined: String?
    private var creating = false
    private var testing = false
    /// 正在连的那个服务。授权页开着的时候留着登录会话。
    private var connecting: String?
    private var signIn: SignIn?
    private var pushToken: NSObjectProtocol?

    init(page: Page = .root) {
        self.page = page
        var config = UICollectionLayoutListConfiguration(appearance: .insetGrouped)
        config.headerMode = .supplementary
        config.footerMode = .none
        super.init(collectionViewLayout: UICollectionViewCompositionalLayout.list(using: config))
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = page.title ?? Store.shared.computer(id: computerId ?? "")?.name
        if page == .root {
            navigationController?.navigationBar.prefersLargeTitles = true
            navigationItem.largeTitleDisplayMode = .never
            navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in
                self?.dismiss(animated: true)
            })
        } else {
            navigationItem.largeTitleDisplayMode = .always
        }

        let cell = UICollectionView.CellRegistration<UICollectionViewListCell, Item> { [weak self] cell, _, item in
            self?.configure(cell, item: item)
        }
        let header = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(
            elementKind: UICollectionView.elementKindSectionHeader
        ) { [weak self] view, _, path in
            var content = UIListContentConfiguration.header()
            content.text = self?.source.sectionIdentifier(for: path.section).flatMap { self?.title(of: $0) }
            view.contentConfiguration = content
        }
        source = UICollectionViewDiffableDataSource(collectionView: collectionView) { view, path, item in
            view.dequeueConfiguredReusableCell(using: cell, for: path, item: item)
        }
        source.supplementaryViewProvider = { view, _, path in
            view.dequeueConfiguredReusableSupplementary(using: header, for: path)
        }
        token = Store.shared.observe { [weak self] in self?.render() }
        pushToken = NotificationCenter.default.addObserver(forName: Push.changed, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.render() }
        }
        if page == .root || page == .notifications { Push.shared.register() }
        render()
    }

    private var computerId: String? {
        if case .computer(let id) = page { return id }
        return nil
    }

    private func title(of section: Section) -> String? {
        switch section {
        case .connected: "已连接"
        case .policy: "权限分级"
        case .abilities: "这台电脑能做的"
        case .devices: "手机、浏览器和电脑 App"
        case .pair: "连接新设备"
        case .connection: "连接的 Pupu"
        default: nil
        }
    }

    // MARK: - 每一页放什么

    private func render() {
        var snapshot = NSDiffableDataSourceSnapshot<Section, Item>()
        switch page {
        case .root: renderRoot(&snapshot)
        case .accounts: renderAccounts(&snapshot)
        case .computers: renderComputers(&snapshot)
        case .computer(let id): renderComputer(id, &snapshot)
        case .members: renderMembers(&snapshot)
        case .notifications:
            snapshot.appendSections([.notifications])
            snapshot.appendItems([.notifications(Push.shared.status, busy: testing)], toSection: .notifications)
        case .devices: renderDevices(&snapshot)
        case .about: renderAbout(&snapshot)
        }
        source.apply(snapshot, animatingDifferences: false)
    }

    private func renderRoot(_ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        let store = Store.shared
        let me = store.members.first(where: \.current)
        let host = Connection.shared.endpoint?.base.host() ?? ""
        snapshot.appendSections([.profile, .pages(0), .pages(1)])
        snapshot.appendItems([
            .profile(title: me?.email ?? UIDevice.current.name, detail: [me?.label, host].compactMap { $0 }.joined(separator: " · "))
        ], toSection: .profile)

        let connectors = store.connectors
        let accounts = connectors.accounts.isEmpty ? (connectors.enabled ? "未连接" : "未开启") : "\(connectors.accounts.count) 个"
        let online = store.computers.filter(\.online).count
        let computers = store.computers.isEmpty ? "没有" : online > 0 ? "\(online) 台在线" : "都离线"
        var first: [Item] = [.link(.accounts, summary: accounts), .link(.computers, summary: computers)]
        // 没开 Google 登录、还没有创建者时没有成员，不显示这一行。
        if !store.members.isEmpty { first.append(.link(.members, summary: "\(store.members.count) 人")) }
        snapshot.appendItems(first, toSection: .pages(0))
        snapshot.appendItems([
            .link(.notifications, summary: Push.shared.status.summary),
            .link(.devices, summary: store.devices.isEmpty ? nil : "\(store.devices.count) 台"),
            .link(.about, summary: nil)
        ], toSection: .pages(1))
    }

    private func renderAccounts(_ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        let store = Store.shared
        let connectors = store.connectors
        let me = store.members.first(where: \.current)?.id
        if !connectors.accounts.isEmpty {
            snapshot.appendSections([.connected])
            snapshot.appendItems(connectors.accounts.map {
                // 别人连的写上是谁的；自己的不写。
                .account($0, owner: $0.memberId == me ? nil : $0.ownerEmail)
            }, toSection: .connected)
        }
        snapshot.appendSections([.services, .note])
        if connectors.enabled {
            snapshot.appendItems(connectors.services.map { .service($0, busy: connecting == $0.id) }, toSection: .services)
            snapshot.appendItems([
                .note("Pupu 读邮件、看日程直接用；发信、建日程、改 issue 这类写操作，会先推到连这个账号的人的手机上批准。凭据存在这个 Pupu 自己的 open-connector 里。")
            ], toSection: .note)
        } else {
            snapshot.appendItems([
                .note("这个 Pupu 还没配连接器。配好 open-connector 之后，这里就能连 Gmail、Google 日历、云端硬盘和 GitHub。")
            ], toSection: .note)
        }
    }

    private func renderComputers(_ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        let store = Store.shared
        snapshot.appendSections([.computers])
        snapshot.appendItems(store.computers.isEmpty ? [.noComputer] : store.computers.map(Item.computer), toSection: .computers)
        renderPair(&snapshot)
    }

    private func renderComputer(_ id: String, _ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        guard let computer = Store.shared.computer(id: id) else {
            snapshot.appendSections([.note])
            snapshot.appendItems([.note("这台电脑已经吊销了。")], toSection: .note)
            return
        }
        title = computer.name
        // 只有主人自己的手机能开，云端也这么判。
        let me = Store.shared.members.first(where: \.current)
        if computer.ownerId == nil || computer.ownerId == me?.id {
            snapshot.appendSections([.remoteDesktop])
            snapshot.appendItems([.remoteDesktop(computer)], toSection: .remoteDesktop)
        }
        snapshot.appendSections([.policy(computerId: id), .abilities])
        snapshot.appendItems(Computer.Policy.allCases.map {
            .policy(computerId: id, policy: $0, selected: computer.currentPolicy == $0)
        }, toSection: .policy(computerId: id))
        snapshot.appendItems([
            .note("跑命令，读写主目录里的文件，看屏幕、点鼠标、打字。第一次操作屏幕前，要在那台电脑的系统设置里给 Pupu 电脑 App 开屏幕录制和辅助功能。")
        ], toSection: .abilities)
        if mayRevoke(owner: computer.ownerId) {
            snapshot.appendSections([.revokeComputer])
            snapshot.appendItems([.revokeComputer(computer)], toSection: .revokeComputer)
        }
    }

    private func renderMembers(_ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        let store = Store.shared
        let me = store.members.first(where: \.current)
        snapshot.appendSections([.members])
        snapshot.appendItems(store.members.map {
            .member($0, removable: me?.isCreator == true && !$0.isCreator)
        }, toSection: .members)
        // 邀请只有创建者在手机上能做（云端 members.ts 的 mayInvite）。
        if me?.isCreator == true { snapshot.appendItems([.invite], toSection: .members) }
    }

    private func renderDevices(_ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        let store = Store.shared
        snapshot.appendSections([.devices])
        snapshot.appendItems(store.devices.isEmpty ? [.noDevice] : store.devices.map(Item.device), toSection: .devices)
        renderPair(&snapshot)
    }

    /// 生成配对码：设备页和电脑页都有，新手机、浏览器和电脑都用它连上。
    private func renderPair(_ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        let base = Connection.shared.endpoint?.base.absoluteString ?? ""
        noticeJoined(Store.shared)
        snapshot.appendSections([.pair])
        if let pairing, pairing.expiresAt > Date.now.timeIntervalSince1970 * 1000 {
            snapshot.appendItems([
                .code(pairing),
                .bridgeCommand("npm run bridge -- pair --url \(base) --code \(pairing.code)")
            ], toSection: .pair)
        } else {
            let note = joined.map { "「\($0)」连上了。" }
                ?? (pairing == nil ? "新手机、浏览器和电脑都用配对码连上。码 10 分钟内有效，用一次就作废。" : "配对码过期了，再生成一个。")
            snapshot.appendItems([.newCode(note: note, busy: creating)], toSection: .pair)
        }
    }

    private func renderAbout(_ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        let base = Connection.shared.endpoint?.base.absoluteString ?? ""
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        snapshot.appendSections([.connection, .note])
        snapshot.appendItems([.server(base), .disconnect], toSection: .connection)
        snapshot.appendItems([.version("Pupu \(version)（\(build)）")], toSection: .note)
    }

    /// 生成码之后多出来一台设备或电脑，就是用这个码连上的：收起码，说一声。
    private func noticeJoined(_ store: Store) {
        guard pairing != nil else { return }
        let connected = store.devices.map { ($0.id, $0.name) } + store.computers.map { ($0.id, $0.name) }
        guard let added = connected.first(where: { !known.contains($0.0) }) else { return }
        joined = added.1
        pairing = nil
    }

    // MARK: - 格子

    private func configure(_ cell: UICollectionViewListCell, item: Item) {
        var content = UIListContentConfiguration.subtitleCell()
        content.textProperties.font = Theme.font(.body)
        content.textProperties.color = Theme.ink
        content.secondaryTextProperties.font = Theme.font(.subheadline)
        content.secondaryTextProperties.color = Theme.inkMuted
        content.secondaryTextProperties.numberOfLines = 0
        content.imageProperties.tintColor = Theme.ink
        cell.accessories = []
        switch item {
        case .profile(let title, let detail):
            content.text = title
            content.textProperties.font = Theme.font(.title)
            content.secondaryText = detail
            content.image = Self.avatar(for: title)
            content.imageProperties.maximumSize = CGSize(width: Theme.Size.control, height: Theme.Size.control)
            content.imageToTextPadding = Theme.Space.s3
            content.directionalLayoutMargins = NSDirectionalEdgeInsets(
                top: Theme.Space.s3, leading: Theme.Space.s4, bottom: Theme.Space.s3, trailing: Theme.Space.s4
            )
        case .link(let target, let summary):
            content = UIListContentConfiguration.cell()
            content.textProperties.font = Theme.font(.body)
            content.textProperties.color = Theme.ink
            content.text = target.title
            content.image = UIImage(systemName: target.symbol)
            content.imageProperties.tintColor = Theme.ink
            if let summary {
                cell.accessories.append(.label(text: summary, options: .init(tintColor: Theme.inkMuted, font: Theme.font(.body))))
            }
            cell.accessories.append(.disclosureIndicator())
        case .account(let account, let owner):
            content.text = account.name
            content.secondaryText = [account.account, owner.map { "\($0) 连的" }].compactMap { $0 }.joined(separator: " · ")
            content.image = UIImage(systemName: symbol(of: account.service))
            if account.removable {
                let remove = UIButton(configuration: .plain(), primaryAction: UIAction(image: UIImage(systemName: "trash")) { [weak self] _ in
                    self?.confirmRemove(account)
                })
                remove.configuration?.baseForegroundColor = Theme.inkMuted
                remove.accessibilityLabel = "断开\(account.name)"
                cell.accessories = [.customView(configuration: .init(customView: remove, placement: .trailing()))]
            }
        case .service(let service, let busy):
            content.text = service.name
            content.secondaryText = service.detail
            content.image = UIImage(systemName: service.symbol)
            var config = UIButton.Configuration.filled()
            config.title = busy ? "正在连…" : "连接"
            config.cornerStyle = .capsule
            config.baseBackgroundColor = Theme.surfaceInset
            config.baseForegroundColor = Theme.ink
            config.buttonSize = .small
            let connect = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in
                self?.connect(service)
            })
            connect.isEnabled = connecting == nil
            cell.accessories = [.customView(configuration: .init(customView: connect, placement: .trailing()))]
        case .computer(let computer):
            content.text = computer.name
            content.secondaryText = [computer.label, computer.currentPolicy.title, email(of: computer.ownerId)]
                .compactMap { $0 }.joined(separator: " · ")
            content.image = UIImage(systemName: "circle.fill")
            content.imageProperties.tintColor = computer.online ? Theme.online : Theme.offline
            content.imageProperties.maximumSize = CGSize(width: 8, height: 8)
            cell.accessories = [.disclosureIndicator()]
        case .noComputer:
            content.text = "还没有授权的电脑"
            content.secondaryText = "在下面生成配对码，在电脑上配对之后，这里会显示它在不在线。"
        case .remoteDesktop(let computer):
            content.text = "远程桌面"
            content.secondaryText = computer.online ? "看这台电脑的屏幕，用手机操作" : "这台电脑离线，连上才能打开"
            content.image = UIImage(systemName: "display")
            content.imageProperties.tintColor = Theme.ink
            cell.accessories = computer.online ? [.disclosureIndicator()] : []
        case .policy(_, let policy, let selected):
            content.text = policy.title
            content.secondaryText = policy.detail
            cell.accessories = selected ? [.checkmark()] : []
        case .revokeComputer(let computer):
            content = UIListContentConfiguration.cell()
            content.text = "吊销「\(computer.name)」"
            content.textProperties.color = Theme.dangerInk
        case .notifications(let status, let busy):
            switch status {
            case .on:
                content.text = busy ? "正在发…" : "发一条测试通知"
                content.secondaryText = "Pupu 要你批准的事会推到这台手机上。锁屏上长按通知就能批，「允许」要先解锁。"
            case .registering, .unknown:
                content.text = busy ? "正在发…" : "发一条测试通知"
                content.secondaryText = "通知已打开，正在把这台手机登记到 Pupu。"
            case .notAsked:
                content.text = "打开通知"
                content.secondaryText = "打开以后，Pupu 要你批准的事会推到锁屏上，不用盯着 App。"
            case .off:
                content.text = "通知已关闭"
                content.secondaryText = "点一下去系统设置里打开。关着的话，只有打开 App 才看得到要批准的事。"
            }
            content.textProperties.font = Theme.font(.body, weight: .semibold)
        case .member(let member, let removable):
            content.text = member.current ? "\(member.email) · 你" : member.email
            content.secondaryText = member.label
            if removable {
                let remove = UIButton(configuration: .plain(), primaryAction: UIAction(title: "移除") { [weak self] _ in
                    self?.confirmRemove(member)
                })
                remove.configuration?.baseForegroundColor = Theme.dangerInk
                cell.accessories = [.customView(configuration: .init(customView: remove, placement: .trailing()))]
            }
        case .invite:
            content.text = "邀请成员"
            content.textProperties.font = Theme.font(.body, weight: .semibold)
            content.secondaryText = "填他的 Google 邮箱。他用这个账号登录就能一起用 Pupu；他的第一台手机要一台已经连上的手机点「允许」。"
        case .device(let device):
            content.text = device.current ? "\(device.name) · 这台手机" : device.name
            content.secondaryText = device.label
            let revoke = UIButton(configuration: .plain(), primaryAction: UIAction(title: "吊销") { [weak self] _ in
                self?.confirmRevoke(device)
            })
            revoke.configuration?.baseForegroundColor = Theme.dangerInk
            if mayRevoke(owner: device.memberId) {
                cell.accessories = [.customView(configuration: .init(customView: revoke, placement: .trailing()))]
            }
        case .noDevice:
            content.text = "还没有配对的手机或浏览器"
        case .newCode(let note, let busy):
            content.text = busy ? "正在生成…" : "生成配对码"
            content.textProperties.font = Theme.font(.body, weight: .semibold)
            content.secondaryText = note
        case .code(let pairing):
            content.text = pairing.code
            content.textProperties.font = UIFontMetrics(forTextStyle: .title2)
                .scaledFont(for: .monospacedSystemFont(ofSize: 28, weight: .semibold))
            let until = Date(timeIntervalSince1970: pairing.expiresAt / 1000).formatted(date: .omitted, time: .shortened)
            let base = Connection.shared.endpoint?.base.absoluteString ?? ""
            content.secondaryText = (copied == pairing.code ? "已复制。" : "点一下复制。")
                + "\(until) 前有效，用一次就作废。手机在 Pupu App 的连接页填；浏览器打开 \(base) 填。"
        case .bridgeCommand(let command):
            content.text = command
            content.textProperties.font = Theme.font(.code)
            content.textProperties.numberOfLines = 0
            content.secondaryText = (copied == command ? "已复制。" : "点一下复制。")
                + "电脑上在 apps/cloud 目录里跑，配好再跑 npm run bridge -- install。"
        case .server(let base):
            content.text = base
            content.secondaryText = "这台手机的设备凭据存在钥匙串里"
        case .version(let text):
            content.text = nil
            content.secondaryText = text
        case .disconnect:
            content = UIListContentConfiguration.cell()
            content.text = "换一个 Pupu"
            content.textProperties.color = Theme.dangerInk
        case .note(let text):
            content.text = nil
            content.secondaryText = text
        }
        cell.contentConfiguration = content
    }

    private func symbol(of service: String) -> String {
        Store.shared.connectors.services.first { $0.id == service }?.symbol ?? "link"
    }

    /// 头像：名字的第一个字母放在一个圆里。
    private static func avatar(for name: String) -> UIImage {
        let size = CGSize(width: Theme.Size.control, height: Theme.Size.control)
        let letter = String(name.first.map(String.init)?.uppercased() ?? "P")
        return UIGraphicsImageRenderer(size: size).image { _ in
            Theme.action.setFill()
            UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).fill()
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 18, weight: .semibold),
                .foregroundColor: Theme.onAction
            ]
            let text = letter as NSString
            let bounds = text.size(withAttributes: attributes)
            text.draw(at: CGPoint(x: (size.width - bounds.width) / 2, y: (size.height - bounds.height) / 2), withAttributes: attributes)
        }
    }

    // MARK: - 点了做什么

    override func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
        switch source.itemIdentifier(for: indexPath) {
        case .link, .computer, .remoteDesktop, .policy, .revokeComputer, .notifications, .invite, .newCode, .code, .bridgeCommand, .disconnect: true
        default: false
        }
    }

    override func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: true)
        switch source.itemIdentifier(for: indexPath) {
        case .link(let target, _):
            navigationController?.pushViewController(SettingsViewController(page: target), animated: true)
        case .computer(let computer):
            navigationController?.pushViewController(SettingsViewController(page: .computer(computer.id)), animated: true)
        case .remoteDesktop(let computer):
            guard computer.online, let endpoint = Connection.shared.endpoint else { return }
            RemoteDesktopViewController.open(computer, endpoint: endpoint, from: self)
        case .policy(let computerId, let policy, let selected):
            guard !selected, let api = Store.shared.api else { return }
            Task {
                do {
                    try await api.setPolicy(policy, computer: computerId)
                    UISelectionFeedbackGenerator().selectionChanged()
                } catch {
                    self.show(error.localizedDescription)
                }
                Store.shared.refresh()
            }
        case .revokeComputer(let computer):
            confirmRevoke(computer)
        case .notifications(let status, _):
            switch status {
            case .notAsked:
                Push.shared.register()
            case .off:
                if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            default:
                testPush()
            }
        case .invite:
            askInvite()
        case .newCode:
            createCode()
        case .code(let pairing):
            copy(pairing.code, item: .code(pairing))
        case .bridgeCommand(let command):
            copy(command, item: .bridgeCommand(command))
        case .disconnect:
            let sheet = UIAlertController(
                title: nil,
                message: "这台手机会从这个 Pupu 注销，回到连接页。要再连，就用配对码重新配对。",
                preferredStyle: .actionSheet
            )
            sheet.addAction(UIAlertAction(title: "换一个 Pupu", style: .destructive) { [weak self] _ in
                self?.dismiss(animated: true) {
                    Task { await Connection.shared.signOut() }
                }
            })
            sheet.addAction(UIAlertAction(title: "取消", style: .cancel))
            present(sheet, animated: true)
        default:
            break
        }
    }

    /// 连一个账号：云端在 open-connector 发起授权，系统登录页里授权完跳回 App。
    private func connect(_ service: Connectors.Service) {
        guard connecting == nil, let api = Store.shared.api else { return }
        connecting = service.id
        render()
        Task {
            defer {
                connecting = nil
                signIn = nil
                render()
            }
            do {
                let url = try await api.connect(service: service.id)
                let session = SignIn(anchor: view.window)
                signIn = session
                let result = try await session.connect(authorization: url)
                Store.shared.refresh()
                if !result.connected {
                    show(result.message.isEmpty ? "没连上 \(service.name)，再试一次。" : result.message)
                } else {
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                }
            } catch is CancellationError {
                // 用户自己关了授权页。
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    private func confirmRemove(_ account: Connectors.Account) {
        let label = account.account.map { "\(account.name)（\($0)）" } ?? account.name
        let sheet = UIAlertController(
            title: nil,
            message: "断开后 Pupu 不能再用\(label)，授权在那边一起撤销。要再用就重新连。",
            preferredStyle: .actionSheet
        )
        sheet.addAction(UIAlertAction(title: "断开\(account.name)", style: .destructive) { [weak self] _ in
            guard let api = Store.shared.api else { return }
            Task {
                do {
                    try await api.remove(connector: account.id)
                } catch {
                    self?.show(error.localizedDescription)
                }
                Store.shared.refresh()
            }
        })
        sheet.addAction(UIAlertAction(title: "取消", style: .cancel))
        present(sheet, animated: true)
    }

    private func confirmRevoke(_ computer: Computer) {
        let sheet = UIAlertController(
            title: nil,
            message: "吊销后「\(computer.name)」会断开。要再用，就在那台电脑上重新配对。",
            preferredStyle: .actionSheet
        )
        sheet.addAction(UIAlertAction(title: "吊销「\(computer.name)」", style: .destructive) { [weak self] _ in
            guard let api = Store.shared.api else { return }
            Task {
                do {
                    try await api.revoke(computer: computer.id)
                    if case .computer = self?.page { self?.navigationController?.popViewController(animated: true) }
                } catch {
                    self?.show(error.localizedDescription)
                }
                Store.shared.refresh()
            }
        })
        sheet.addAction(UIAlertAction(title: "取消", style: .cancel))
        present(sheet, animated: true)
    }

    private func copy(_ text: String, item: Item) {
        UIPasteboard.general.string = text
        copied = text
        var snapshot = source.snapshot()
        snapshot.reconfigureItems([item])
        source.apply(snapshot, animatingDifferences: false)
    }

    private func createCode() {
        guard !creating, let api = Store.shared.api else { return }
        creating = true
        render()
        Task {
            defer {
                creating = false
                render()
            }
            do {
                let code = try await api.createPairingCode()
                known = Set(Store.shared.devices.map(\.id) + Store.shared.computers.map(\.id))
                joined = nil
                copied = nil
                pairing = code
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    private func testPush() {
        guard !testing, let api = Store.shared.api else { return }
        testing = true
        render()
        Task {
            defer {
                testing = false
                render()
            }
            do {
                let test = try await api.testPush()
                let failed = (test.results ?? []).filter { $0.status != 200 }
                if !failed.isEmpty {
                    let reasons = failed.map { "\($0.env)：\($0.status) \($0.reason ?? "")" }.joined(separator: "\n")
                    show("APNs 没收：\n\(reasons)")
                }
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    private func confirmRevoke(_ device: Device) {
        let sheet = UIAlertController(
            title: nil,
            message: device.current
                ? "吊销后这台手机马上退出，回到连接页。要再用就重新配对。"
                : "吊销后「\(device.name)」马上断开。要再用，就在那台设备上重新配对。",
            preferredStyle: .actionSheet
        )
        sheet.addAction(UIAlertAction(title: "吊销「\(device.name)」", style: .destructive) { [weak self] _ in
            guard let api = Store.shared.api else { return }
            Task {
                do {
                    try await api.revoke(device: device.id)
                    if device.current {
                        self?.dismiss(animated: true) { Connection.shared.forget() }
                        return
                    }
                } catch {
                    self?.show(error.localizedDescription)
                }
                Store.shared.refresh()
            }
        })
        sheet.addAction(UIAlertAction(title: "取消", style: .cancel))
        present(sheet, animated: true)
    }

    /// 成员 id 对应的邮箱。
    private func email(of member: String?) -> String? {
        guard let member else { return nil }
        return Store.shared.members.first { $0.id == member }?.email
    }

    /// 和云端 members.ts 的 mayRevoke 一样：自己名下的自己能吊销，创建者能吊销所有人的。
    /// 还没有成员（没开 Google 登录）时都能吊销，和以前一样。
    private func mayRevoke(owner: String?) -> Bool {
        let members = Store.shared.members
        guard !members.isEmpty else { return true }
        guard let me = members.first(where: \.current) else { return false }
        return me.isCreator || owner == me.id
    }

    private func askInvite() {
        let alert = UIAlertController(title: "邀请成员", message: "填他的 Google 邮箱。", preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "name@gmail.com"
            field.keyboardType = .emailAddress
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.textContentType = .emailAddress
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "邀请", style: .default) { [weak self, weak alert] _ in
            let email = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespaces) ?? ""
            guard !email.isEmpty, let api = Store.shared.api else { return }
            Task {
                do {
                    try await api.invite(email: email)
                } catch {
                    self?.show(error.localizedDescription)
                }
                Store.shared.refresh()
            }
        })
        present(alert, animated: true)
    }

    private func confirmRemove(_ member: Member) {
        let sheet = UIAlertController(
            title: nil,
            message: "移除后 \(member.email) 不能再登录，他名下的手机、浏览器、电脑 App、电脑和连的账号马上断开。",
            preferredStyle: .actionSheet
        )
        sheet.addAction(UIAlertAction(title: "移除 \(member.email)", style: .destructive) { [weak self] _ in
            guard let api = Store.shared.api else { return }
            Task {
                do {
                    try await api.remove(member: member.id)
                } catch {
                    self?.show(error.localizedDescription)
                }
                Store.shared.refresh()
            }
        })
        sheet.addAction(UIAlertAction(title: "取消", style: .cancel))
        present(sheet, animated: true)
    }

    private func show(_ text: String) {
        let alert = UIAlertController(title: "没做成", message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        present(alert, animated: true)
    }
}

private extension Push.Status {
    /// 「我」第一页通知那一行右边的字。
    var summary: String {
        switch self {
        case .on, .registering, .unknown: "已打开"
        case .notAsked: "未打开"
        case .off: "已关闭"
        }
    }
}
