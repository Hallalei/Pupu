import UIKit

/// 「我」：右上角点进来的那一页，照 Hark 的设置页做。第一页上面是我是谁，下面两组入口，点进去是二级页：
/// 账户（连接器）、电脑和它的权限分级、成员、邀请码、通知、设备和配对码、关于（连的是哪个 Pupu）。
/// 一页一个 `Page`，共用这一个类：列表、格子、点了做什么都在这里。
final class SettingsViewController: UICollectionViewController {
    nonisolated enum Page: Hashable, Sendable {
        case root
        case accounts
        case computers
        case computer(String)
        case members
        case invites
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
            case .invites: "邀请码"
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
            case .invites: "ticket"
            case .notifications: "bell"
            case .devices: "iphone"
            case .about, .root: "info.circle"
            }
        }
    }

    nonisolated private enum Section: Hashable, Sendable {
        case profile
        case orgs
        case pages(Int)
        case connected
        case services
        case computers
        case remoteDesktop
        case remoteConfirm
        case policy(computerId: String)
        case abilities
        case revokeComputer
        case notifications
        case members
        case invites
        case devices
        case pair
        case connection
        case note
    }

    nonisolated private enum Item: Hashable, Sendable {
        /// avatar 是自己的头像地址；member 是 false 时（不是成员）点不进去换头像。
        case profile(title: String, detail: String, avatar: String?, member: Bool)
        /// Pupu 自己的头像，创建者才有这一行。值是换过的地址，只用来在换了之后重画。
        case pupuAvatar(String?)
        /// 这个账号在的一个 Pupu。`status` 是切过去时右边的字（正在切换、等已有的手机允许）。
        case org(OrgList.Org, status: String?)
        case openOwn
        case link(Page, summary: String?)
        case account(Connectors.Account, owner: String?)
        case service(Connectors.Service, busy: Bool)
        case computer(Computer)
        case noComputer
        case remoteDesktop(Computer)
        case remoteConfirm(Computer)
        case policy(computerId: String, policy: Computer.Policy, selected: Bool)
        case revokeComputer(Computer)
        case notifications(Push.Status, busy: Bool)
        case member(Member, removable: Bool)
        case invite
        case inviteCode(InviteList.Invite)
        case newInvite(left: Int, busy: Bool)
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
    private var avatarToken: NSObjectProtocol?
    /// 邀请码列表。拿到 403（不是第一个 Pupu 的创建者）一直是 nil，第一页也就不放这一行。
    private var invites: InviteList?
    private var creatingInvite = false
    /// 这个账号在的 Pupu。只有一个、也开不了自己的时候，第一页不放这一组。
    private var orgs: OrgList?
    /// 正在切过去的那个，和右边写什么。
    private var switching: (org: String, status: String)?

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
        // 头像图是异步拿的，拿到了重画：列表格子的图是画好了塞进去的。
        avatarToken = NotificationCenter.default.addObserver(forName: Avatars.loaded, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.reconfigureAvatars() }
        }
        if page == .root || page == .notifications { Push.shared.register() }
        if page == .root || page == .invites { loadInvites() }
        if page == .root { loadOrgs() }
        render()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // 从邀请码页回来时，第一页那一行的「还能生成几个」跟着变。
        if page == .root, invites != nil { loadInvites() }
    }

    private var computerId: String? {
        if case .computer(let id) = page { return id }
        return nil
    }

    private func title(of section: Section) -> String? {
        switch section {
        case .connected: "已连接"
        case .policy: "什么时候先问你"
        case .computers: Store.shared.computers.isEmpty ? nil : "管理设备"
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
        case .invites: renderInvites(&snapshot)
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
        snapshot.appendSections([.profile])
        snapshot.appendItems([
            .profile(
                title: me?.email ?? UIDevice.current.name,
                detail: [me?.label, host].compactMap { $0 }.joined(separator: " · "),
                avatar: me?.avatar,
                member: me != nil
            )
        ], toSection: .profile)
        // 一个账号在好几个 Pupu 里：点一下切过去（docs/协作方案.md 第 1 节）。
        if let orgs, orgs.orgs.count > 1 || orgs.canOpenOwn {
            snapshot.appendSections([.orgs])
            snapshot.appendItems(orgs.orgs.map {
                .org($0, status: switching?.org == $0.id ? switching?.status : nil)
            } + (orgs.canOpenOwn ? [.openOwn] : []), toSection: .orgs)
        }
        snapshot.appendSections([.pages(0), .pages(1)])

        let connectors = store.connectors
        let accounts = connectors.accounts.isEmpty ? (connectors.enabled ? "未连接" : "未开启") : "\(connectors.accounts.count) 个"
        let online = store.computers.filter(\.online).count
        let computers = store.computers.isEmpty ? "没有" : "\(store.computers.count) 台 · \(online) 台在线"
        // 电脑从主界面挪进了设置，排在第一行。
        var first: [Item] = [.link(.computers, summary: computers), .link(.accounts, summary: accounts)]
        // 创建者能换 Pupu 的头像。没开 Google 登录（没有成员）时，云端把没主人的设备都当创建者，见 members.ts 的 actorOf。
        if me?.isCreator == true || store.members.isEmpty { first.insert(.pupuAvatar(store.pupuAvatar), at: 0) }
        // 没开 Google 登录、还没有创建者时没有成员，不显示这一行。
        if !store.members.isEmpty { first.append(.link(.members, summary: "\(store.members.count) 人")) }
        if let invites { first.append(.link(.invites, summary: "还能生成 \(invites.left) 个")) }
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
        snapshot.appendItems(store.computers.isEmpty ? [.noComputer] : store.computers.map { .computer($0.settled) }, toSection: .computers)
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
            snapshot.appendItems([.remoteDesktop(computer.settled)], toSection: .remoteDesktop)
            snapshot.appendSections([.remoteConfirm])
            snapshot.appendItems([.remoteConfirm(computer.settled)], toSection: .remoteConfirm)
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
            snapshot.appendItems([.revokeComputer(computer.settled)], toSection: .revokeComputer)
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

    private func renderInvites(_ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        snapshot.appendSections([.invites, .note])
        guard let invites else {
            snapshot.appendItems([.note("加载中…")], toSection: .note)
            return
        }
        snapshot.appendItems(invites.invites.map(Item.inviteCode) + [.newInvite(left: invites.left, busy: creatingInvite)], toSection: .invites)
        snapshot.appendItems([
            .note("一个码给一个人开他自己的 Pupu，用一次就失效。没用掉的码也占名额，用不上就作废。")
        ], toSection: .note)
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
        cell.backgroundConfiguration = cell.defaultBackgroundConfiguration()
        cell.accessibilityTraits = []
        switch item {
        case .profile(let title, let detail, let avatar, let member):
            content.text = title
            content.textProperties.font = Theme.font(.title)
            content.secondaryText = detail
            content.image = Avatars.round(
                Avatars.shared.image(avatar),
                letter: Avatars.letter(title),
                size: Theme.Size.control,
                pixelArt: Avatars.isPixelArt(avatar)
            )
            if member { cell.accessories = [.disclosureIndicator()] }
            content.imageProperties.maximumSize = CGSize(width: Theme.Size.control, height: Theme.Size.control)
            content.imageToTextPadding = Theme.Space.s3
            content.directionalLayoutMargins = NSDirectionalEdgeInsets(
                top: Theme.Space.s3, leading: Theme.Space.s4, bottom: Theme.Space.s3, trailing: Theme.Space.s4
            )
        case .pupuAvatar:
            content = UIListContentConfiguration.cell()
            content.textProperties.font = Theme.font(.body)
            content.textProperties.color = Theme.ink
            content.text = "Pupu 的头像"
            let pupu = Avatars.shared.pupu()
            content.image = Avatars.round(pupu.image, letter: "P", size: 28, pixelArt: pupu.pixelArt)
            content.imageProperties.maximumSize = CGSize(width: 28, height: 28)
            cell.accessories = [.disclosureIndicator()]
        case .org(let org, let status):
            content = UIListContentConfiguration.cell()
            content.textProperties.font = Theme.font(.body)
            content.textProperties.color = Theme.ink
            content.text = org.name
            content.image = Avatars.round(nil, letter: Avatars.letter(org.creator ?? org.name), size: 28, pixelArt: false)
            content.imageProperties.maximumSize = CGSize(width: 28, height: 28)
            cell.accessories = [.label(text: status ?? "\(org.members) 人", options: .init(tintColor: Theme.inkMuted, font: Theme.font(.body)))]
            if org.current {
                cell.accessories.append(.checkmark(options: .init(tintColor: Theme.ink)))
                cell.accessibilityTraits = [.selected]
            }
        case .openOwn:
            content = UIListContentConfiguration.cell()
            content.textProperties.font = Theme.font(.body)
            content.textProperties.color = Theme.ink
            content.text = "开自己的 Pupu"
            content.image = UIImage(systemName: "plus")
            content.imageProperties.tintColor = Theme.ink
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
            content.secondaryText = [computer.label, email(of: computer.ownerId)]
                .compactMap { $0 }.joined(separator: " · ")
            content.image = UIImage(systemName: "circle.fill")
            content.imageProperties.tintColor = computer.online ? Theme.online : Theme.offline
            content.imageProperties.maximumSize = CGSize(width: 8, height: 8)
            // 学 Grok Bot 的「电脑」页：每台电脑右边直接是分级的下拉，不用点进去。
            cell.accessories = [
                .customView(configuration: .init(customView: policyMenu(for: computer), placement: .trailing())),
                .disclosureIndicator()
            ]
        case .noComputer:
            content.text = "还没有授权的电脑"
            content.secondaryText = "在下面生成配对码，在电脑上配对之后，这里会显示它在不在线。"
        case .remoteDesktop(let computer):
            // 墨色的主操作：整行就是按钮。不用 Pupu 正在用这台电脑。
            content = UIListContentConfiguration.cell()
            content.text = computer.online ? "远程控制" : "离线，连上才能远程控制"
            content.textProperties.font = Theme.font(.body, weight: .semibold)
            content.textProperties.color = Theme.onAction
            content.textProperties.alignment = .center
            content.image = computer.online ? UIImage(systemName: "cursorarrow") : nil
            content.imageProperties.tintColor = Theme.onAction
            var background = UIBackgroundConfiguration.listCell()
            background.backgroundColor = computer.online ? Theme.action : Theme.action.withAlphaComponent(0.35)
            background.cornerRadius = Theme.Size.control / 2
            cell.backgroundConfiguration = background
            cell.accessibilityTraits = computer.online ? .button : [.button, .notEnabled]
        case .remoteConfirm(let computer):
            content.text = "远程控制前"
            cell.accessories = [.customView(configuration: .init(customView: remoteConfirmMenu(for: computer), placement: .trailing()))]
        case .policy(let computerId, let policy, let selected):
            content.text = policy.title
            let allowed = Store.shared.computer(id: computerId).map { mayChangePolicy($0, to: policy) } ?? false
            content.textProperties.color = allowed ? Theme.ink : Theme.inkMuted
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
            content.image = Avatars.round(
                Avatars.shared.image(member.avatar),
                letter: Avatars.letter(member.displayName),
                size: Theme.Size.avatar,
                pixelArt: Avatars.isPixelArt(member.avatar),
                fill: Theme.surfaceStrong,
                ink: Theme.ink
            )
            content.imageProperties.maximumSize = CGSize(width: Theme.Size.avatar, height: Theme.Size.avatar)
            content.imageToTextPadding = Theme.Space.s3
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
        case .inviteCode(let invite):
            content.text = invite.code
            content.textProperties.font = UIFontMetrics(forTextStyle: .body)
                .scaledFont(for: .monospacedSystemFont(ofSize: 17, weight: .semibold))
            if let usedBy = invite.usedBy {
                content.secondaryText = usedBy
            } else {
                content.secondaryText = "点一下发给对方"
                let revoke = UIButton(configuration: .plain(), primaryAction: UIAction(title: "作废") { [weak self] _ in
                    self?.revokeInvite(invite.code)
                })
                revoke.configuration?.baseForegroundColor = Theme.dangerInk
                cell.accessories = [.customView(configuration: .init(customView: revoke, placement: .trailing()))]
            }
        case .newInvite(let left, let busy):
            content.text = busy ? "正在生成…" : "生成邀请码"
            content.textProperties.font = Theme.font(.body, weight: .semibold)
            content.textProperties.color = left > 0 ? Theme.ink : Theme.inkMuted
            content.secondaryText = left > 0 ? "还能生成 \(left) 个" : "名额用完了"
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
    /// 拿到了头像图，有头像的格子重画一遍。
    private func reconfigureAvatars() {
        var snapshot = source.snapshot()
        let items = snapshot.itemIdentifiers.filter {
            switch $0 {
            case .profile, .member, .pupuAvatar: true
            default: false
            }
        }
        guard !items.isEmpty else { return }
        snapshot.reconfigureItems(items)
        source.apply(snapshot, animatingDifferences: false)
    }

    // MARK: - 点了做什么

    override func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
        switch source.itemIdentifier(for: indexPath) {
        case .profile(_, _, _, let member): member
        case .link, .pupuAvatar, .computer, .remoteDesktop, .policy, .revokeComputer, .notifications, .invite, .newCode, .code, .bridgeCommand, .disconnect: true
        case .inviteCode(let invite): invite.usedBy == nil
        case .newInvite(let left, let busy): left > 0 && !busy
        case .org(let org, _): !org.current && switching == nil
        case .openOwn: switching == nil
        default: false
        }
    }

    override func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: true)
        switch source.itemIdentifier(for: indexPath) {
        case .profile:
            navigationController?.pushViewController(AvatarPickerViewController(), animated: true)
        case .pupuAvatar:
            navigationController?.pushViewController(AvatarPickerViewController(target: .pupu), animated: true)
        case .org(let org, _):
            guard !org.current, switching == nil else { return }
            switchOrg(org.id) { progress in try await Connection.shared.switchTo(org: org.id, progress: progress) }
        case .openOwn:
            askOpenOwn()
        case .link(let target, _):
            navigationController?.pushViewController(SettingsViewController(page: target), animated: true)
        case .computer(let computer):
            navigationController?.pushViewController(SettingsViewController(page: .computer(computer.id)), animated: true)
        case .remoteDesktop(let computer):
            guard computer.online, let endpoint = Connection.shared.endpoint else { return }
            RemoteDesktopViewController.open(computer, endpoint: endpoint, from: self)
        case .policy(let computerId, let policy, let selected):
            guard !selected, let computer = Store.shared.computer(id: computerId), mayChangePolicy(computer, to: policy) else { return }
            setPolicy(policy, of: computerId)
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
        case .inviteCode(let invite):
            guard invite.usedBy == nil, let cell = collectionView.cellForItem(at: indexPath) else { return }
            share(invite.code, from: cell)
        case .newInvite:
            createInvite()
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
            sheet.addAction(UIAlertAction(title: "换一个 Pupu", style: .destructive) { _ in
                Connection.shared.signOut()
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
            // 吊销这台手机就是从这个 Pupu 注销：先在本机忘掉，之后到的 401 就不会被当成「在别处被吊销了」。
            if device.current {
                Connection.shared.signOut()
                return
            }
            guard let api = Store.shared.api else { return }
            Task {
                do {
                    try await api.revoke(device: device.id)
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
    /// 分级的下拉：一颗小胶囊，点开是三档。别人的电脑只能往严里改，放宽的几项灰掉。
    private func policyMenu(for computer: Computer) -> UIButton {
        var config = UIButton.Configuration.gray()
        config.title = computer.currentPolicy.title
        config.image = UIImage(systemName: "chevron.up.chevron.down")
        config.imagePlacement = .trailing
        config.imagePadding = 4
        config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .caption2, scale: .small)
        config.cornerStyle = .capsule
        config.buttonSize = .small
        config.baseForegroundColor = Theme.ink
        let actions = Computer.Policy.allCases.map { policy in
            UIAction(
                title: policy.title,
                attributes: mayChangePolicy(computer, to: policy) ? [] : [.disabled],
                state: computer.currentPolicy == policy ? .on : .off
            ) { [weak self] _ in
                guard policy != computer.currentPolicy else { return }
                self?.setPolicy(policy, of: computer.id)
            }
        }
        let button = UIButton(configuration: config)
        button.menu = UIMenu(options: .singleSelection, children: actions)
        button.showsMenuAsPrimaryAction = true
        button.accessibilityLabel = "「\(computer.name)」上什么时候先问你：\(computer.currentPolicy.title)"
        return button
    }

    /// 远程控制前确认几档：和分级一样的小胶囊。手机按面容确认，三档都能选；放宽只有主人（这一行也只给主人）。
    private func remoteConfirmMenu(for computer: Computer) -> UIButton {
        var config = UIButton.Configuration.gray()
        config.title = computer.currentRemoteConfirm.title
        config.image = UIImage(systemName: "chevron.up.chevron.down")
        config.imagePlacement = .trailing
        config.imagePadding = 4
        config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .caption2, scale: .small)
        config.cornerStyle = .capsule
        config.buttonSize = .small
        config.baseForegroundColor = Theme.ink
        let actions = Computer.RemoteConfirm.allCases.map { level in
            UIAction(title: level.title, state: computer.currentRemoteConfirm == level ? .on : .off) { [weak self] _ in
                guard level != computer.currentRemoteConfirm else { return }
                self?.setRemoteConfirm(level, of: computer.id)
            }
        }
        let button = UIButton(configuration: config)
        button.menu = UIMenu(options: .singleSelection, children: actions)
        button.showsMenuAsPrimaryAction = true
        button.accessibilityLabel = "远程控制「\(computer.name)」前：\(computer.currentRemoteConfirm.title)"
        return button
    }

    private func setRemoteConfirm(_ level: Computer.RemoteConfirm, of computerId: String) {
        guard let api = Store.shared.api else { return }
        Task {
            do {
                try await api.setRemoteConfirm(level, computer: computerId)
                UISelectionFeedbackGenerator().selectionChanged()
            } catch {
                self.show(error.localizedDescription)
            }
            Store.shared.refresh()
        }
    }

    /// 改分级不用再确认（2026-11-13 定）：主人在哪个端都能改，别人只能往严里改。
    private func mayChangePolicy(_ computer: Computer, to policy: Computer.Policy) -> Bool {
        if policy.strictness >= computer.currentPolicy.strictness { return true }
        let members = Store.shared.members
        guard !members.isEmpty else { return true }
        guard let me = members.first(where: \.current) else { return false }
        return computer.ownerId == nil || computer.ownerId == me.id
    }

    private func setPolicy(_ policy: Computer.Policy, of computerId: String) {
        guard let api = Store.shared.api else { return }
        Task {
            do {
                try await api.setPolicy(policy, computer: computerId)
                UISelectionFeedbackGenerator().selectionChanged()
            } catch {
                self.show(error.localizedDescription)
            }
            Store.shared.refresh()
        }
    }

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

    private func loadOrgs() {
        guard let api = Store.shared.api else { return }
        Task {
            // 老云端没有这个接口：留着 nil，这一组不出现。
            orgs = try? await api.orgs()
            render()
        }
    }

    /// 切过去。切好了 `Connection` 发 changed，主界面整个按新的身份重建，这一页跟着关掉。
    private func switchOrg(_ key: String, work: @escaping (@escaping (SignIn.Progress) -> Void) async throws -> Void) {
        switching = (key, "正在切换…")
        render()
        Task {
            do {
                try await work { [weak self] progress in
                    Task { @MainActor in
                        guard let self, case .waiting = progress else { return }
                        self.switching = (key, "等已有的手机允许")
                        self.render()
                    }
                }
            } catch is CancellationError {
            } catch {
                show(error.localizedDescription)
            }
            switching = nil
            render()
        }
    }

    private func askOpenOwn() {
        let alert = UIAlertController(title: "开自己的 Pupu", message: "填邀请码。", preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "ABCD-EFGH"
            field.autocapitalizationType = .allCharacters
            field.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "开", style: .default) { [weak self, weak alert] _ in
            let code = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespaces) ?? ""
            guard !code.isEmpty else { return }
            self?.switchOrg("own") { progress in try await Connection.shared.openOwn(code: code, progress: progress) }
        })
        present(alert, animated: true)
    }

    private func loadInvites() {
        guard let api = Store.shared.api else { return }
        Task {
            // 不是第一个 Pupu 的创建者会拿到 403：留着 nil，这一行不出现。
            invites = try? await api.invites()
            render()
        }
    }

    private func createInvite() {
        guard !creatingInvite, let api = Store.shared.api else { return }
        creatingInvite = true
        render()
        Task {
            do {
                let code = try await api.createInvite()
                // 先把新码放上去，再拉一次整份；拉失败也不会看着像没生成。
                invites?.invites.insert(.init(code: code, createdAt: Date.now.timeIntervalSince1970 * 1000, usedBy: nil, usedAt: nil), at: 0)
                invites?.left -= 1
            } catch {
                show(error.localizedDescription)
            }
            creatingInvite = false
            render()
            if let fresh = try? await api.invites() {
                invites = fresh
                render()
            }
        }
    }

    private func revokeInvite(_ code: String) {
        let sheet = UIAlertController(title: nil, message: "作废后 \(code) 不能再用，名额空出来。", preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "作废 \(code)", style: .destructive) { [weak self] _ in
            guard let api = Store.shared.api else { return }
            Task {
                do {
                    try await api.revoke(invite: code)
                    self?.invites?.invites.removeAll { $0.code == code }
                    self?.invites?.left += 1
                } catch {
                    self?.show(error.localizedDescription)
                }
                self?.render()
                if let fresh = try? await api.invites() {
                    self?.invites = fresh
                    self?.render()
                }
            }
        })
        sheet.addAction(UIAlertAction(title: "取消", style: .cancel))
        present(sheet, animated: true)
    }

    /// 系统分享面板：发消息、拷贝都在里面。带上怎么用，对方不用再问。
    private func share(_ code: String, from cell: UIView) {
        let text = "Pupu 内测邀请码：\(code)\n网页版打开 https://app.getpupu.com ，Mac 版在 https://getpupu.com 下载。用 Google 账号登录，按提示填这个码。"
        let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = cell
        present(sheet, animated: true)
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

private extension Computer {
    /// 放进列表格子的样子：在线时去掉每次心跳都变的 lastSeenAt（在线时也不显示它）。
    /// 不去掉的话，每次心跳格子都被删了重建，正点着的那一下就丢了。
    var settled: Computer {
        guard online, lastSeenAt != nil else { return self }
        return Computer(id: id, name: name, ownerId: ownerId, online: online, stale: stale, lastSeenAt: nil, policy: policy, screen: screen, remoteConfirm: remoteConfirm, remoteTrusted: remoteTrusted)
    }
}
