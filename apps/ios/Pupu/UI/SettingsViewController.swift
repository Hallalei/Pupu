import UIKit

/// 设置（规范 SettingsSheet）：从切换 sheet 最底下自己的头像进。首页是自己、换一个 Pupu、这个 Pupu（电脑、设备、成员、模型），
/// 最下面「这台手机」放只有手机才有的通知和关于（规范没画，记在规范对照里）。自己那一行进「账户」：头像、Google 账户、邀请码和连上的服务。
/// 点进去是二级页：电脑和它的权限分级、成员、邀请码、通知、设备和配对码、关于（连的是哪个 Pupu）。
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
        /// 账户页最上面：头像、Google 账户、邀请码。
        case me
        case orgs
        case pages(Int)
        case connected
        case services
        /// 一台电脑那一块（规范 ComputerRow）：头、两行档位、吊销。
        case panel(String)
        /// 电脑页上离线的电脑，一台一行。
        case offline
        case notifications
        case members
        case invites
        case devices
        case pair
        case connection
        case note
    }

    nonisolated private enum Item: Hashable, Sendable {
        /// 自己：名字和头像地址，点进「账户」。
        case profile(title: String, avatar: String?)
        /// Pupu 自己的头像，创建者才有这一行。值是换过的地址，只用来在换了之后重画。
        case pupuAvatar(String?)
        /// 账户页的「头像」：右边是现在的头像，点进去换。
        case myAvatar(name: String, avatar: String?)
        /// 只看的一行：左边名字，右边值。
        case value(title: String, value: String)
        /// 在用的模型。手机上只看，不带箭头、点不进去（规范 ModelSettings）。
        case model(String)
        /// 这个账号在的一个 Pupu。`status` 是切过去时右边的字（正在切换、等已有的手机允许）。
        case org(OrgList.Org, status: String?)
        case openOwn
        case link(Page, summary: String?)
        case account(Connectors.Account, owner: String?)
        case service(Connectors.Service, busy: Bool)
        case computerHead(Computer)
        case policy(Computer)
        case remoteConfirm(Computer)
        case revokeComputer(Computer)
        case offlineComputer(Computer)
        case notifications(Push.Status, busy: Bool)
        case member(Member, removable: Bool)
        case invite
        case inviteCode(InviteList.Invite)
        case newInvite(left: Int, busy: Bool)
        case device(Device)
        /// 「生成配对码」那一行。`failed` 时下面那句是出错的原因，换 `danger-ink`。
        case newCode(title: String, note: String, failed: Bool, busy: Bool)
        case code(PairingCode)
        case server(String)
        case disconnect
        /// 组下面的说明（`footnote`、`ink-muted`），没有行底。
        case note(String)

        /// 画在 `HostCell` 里、自己排的几种。
        var hosted: Bool {
            switch self {
            case .computerHead, .policy, .remoteConfirm, .code: true
            default: false
            }
        }
    }

    private let page: Page
    private var source: UICollectionViewDiffableDataSource<Section, Item>!
    private var token: StoreToken?
    private var pairing: PairingCode?
    /// 生成配对码时已经连上的设备和电脑。之后多出来的那台，就是用这个码连上的。
    private var known: Set<String> = []
    private var joined: String?
    private var creating = false
    private var pairError: String?
    /// 点了「收起」：码在用掉或过期之前仍然有效，照样等它连上。
    private var pairCollapsed = false
    /// 电脑页右上角的「配对」点开了。
    private var pairOpen = false
    /// 点码复制的时候：倒计时那里写两秒「已复制。」。
    private var copiedAt: Date?
    private var ticker: Timer?
    private var testing = false
    /// 正在连的那个服务。授权页开着的时候留着登录会话。
    private var connecting: String?
    private var signIn: SignIn?
    private var pushToken: NSObjectProtocol?
    private var avatarToken: NSObjectProtocol?
    /// 邀请码列表。拿到 403（不是第一个 Pupu 的创建者）一直是 nil，账户页也就不放这一行。
    private var invites: InviteList?
    private var creatingInvite = false
    /// 这个账号在的 Pupu。只有一个、也开不了自己的时候，第一页不放这一组。
    private var orgs: OrgList?
    /// 正在切过去的那个，和右边写什么。
    private var switching: (org: String, status: String)?
    private lazy var pairButton = makePairButton()

    init(page: Page = .root) {
        self.page = page
        super.init(collectionViewLayout: UICollectionViewFlowLayout())
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = page == .root ? "设置" : page.title ?? Store.shared.computer(id: computerId ?? "")?.name
        if page == .root {
            navigationItem.rightBarButtonItem = .sheetButton(image: "xmark", label: "关闭") { [weak self] in
                self?.dismiss(animated: true)
            }
        }
        collectionView.backgroundColor = Theme.surfaceSheet
        collectionView.contentInset.bottom = Theme.Space.s6
        collectionView.setCollectionViewLayout(makeLayout(), animated: false)

        let cell = UICollectionView.CellRegistration<UICollectionViewListCell, Item> { [weak self] cell, _, item in
            self?.configure(cell, item: item)
        }
        let host = UICollectionView.CellRegistration<HostCell, Item> { [weak self] cell, _, item in
            self?.configure(host: cell, item: item)
        }
        let header = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(
            elementKind: UICollectionView.elementKindSectionHeader
        ) { [weak self] view, _, path in
            // 规范 SettingsSheet：组标题 `footnote`、`ink-muted`，左边让出 4，离自己的组 4。
            var content = UIListContentConfiguration.header()
            content.text = self?.source.sectionIdentifier(for: path.section).flatMap { self?.title(of: $0) }
            content.textProperties.font = Theme.font(.footnote)
            content.textProperties.color = Theme.inkMuted
            content.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s1, bottom: Theme.Space.s1, trailing: Theme.Space.s1)
            view.contentConfiguration = content
        }
        source = UICollectionViewDiffableDataSource(collectionView: collectionView) { view, path, item in
            if item.hosted { return view.dequeueConfiguredReusableCell(using: host, for: path, item: item) }
            return view.dequeueConfiguredReusableCell(using: cell, for: path, item: item)
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
        if page == .accounts || page == .invites { loadInvites() }
        if page == .root { loadOrgs() }
        render()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // 从邀请码页回来时，账户页那一行的「还能生成几个」跟着变。
        if page == .accounts, invites != nil { loadInvites() }
        if pairing != nil { startTicking() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        stopTicking()
    }

    private var computerId: String? {
        if case .computer(let id) = page { return id }
        return nil
    }

    /// 看得见的组标题。设置首页和账户页的组只有读屏念的名字（和网页一样），不画标题。
    private func title(of section: Section) -> String? {
        switch section {
        case .connected: "已连接"
        case .offline: "离线的电脑"
        case .devices: "手机、浏览器和电脑 App"
        case .pair: "连接新设备"
        case .connection: "连接的 Pupu"
        default: nil
        }
    }

    /// 规范 SettingsSheet「外观」：组之间 14；有标题的组，标题离上一组 20；组下面的说明紧跟着组（说明自己离组 8）。
    private func makeLayout() -> UICollectionViewLayout {
        UICollectionViewCompositionalLayout { [weak self] index, environment in
            let section = self?.source?.sectionIdentifier(for: index)
            let titled = section.flatMap { self?.title(of: $0) } != nil
            var config = UICollectionLayoutListConfiguration(appearance: .insetGrouped)
            config.backgroundColor = Theme.surfaceSheet
            config.separatorConfiguration.color = Theme.line
            config.headerMode = titled ? .supplementary : .none
            // 标题离上一组 20 放在标题上面；section 的 contentInsets.top 会落在标题和组之间。
            config.headerTopPadding = index == 0 ? Theme.Space.s2 : Theme.Space.s5
            config.footerMode = .none
            if section == .note { config.showsSeparators = false }
            let layout = NSCollectionLayoutSection.list(using: config, layoutEnvironment: environment)
            // 有标题的组：标题底下自带 4，组本身不再往下推。
            layout.contentInsets.top = titled || section == .note ? 0 : index == 0 ? Theme.Space.s2 : 14
            layout.contentInsets.bottom = 0
            return layout
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
        snapshot.appendSections([.profile])
        snapshot.appendItems([.profile(title: me?.displayName ?? UIDevice.current.name, avatar: me?.avatar)], toSection: .profile)
        // 一个账号在好几个 Pupu 里：点一下切过去（docs/协作方案.md 第 1 节）。
        if let orgs, orgs.orgs.count > 1 || orgs.canOpenOwn {
            snapshot.appendSections([.orgs])
            snapshot.appendItems(orgs.orgs.map {
                .org($0, status: switching?.org == $0.id ? switching?.status : nil)
            } + (orgs.canOpenOwn ? [.openOwn] : []), toSection: .orgs)
        }
        snapshot.appendSections([.pages(0), .pages(1)])

        let online = store.computers.filter(\.online).count
        let computers = store.computers.isEmpty ? "还没有" : "\(store.computers.count) 台 · \(online) 台在线"
        var pupu: [Item] = [
            .link(.computers, summary: computers),
            .link(.devices, summary: store.devices.isEmpty ? nil : "\(store.devices.count) 台")
        ]
        // 没开 Google 登录、还没有创建者时没有成员，不显示这一行。
        if !store.members.isEmpty { pupu.append(.link(.members, summary: "\(store.members.count) 人")) }
        if let model = store.model { pupu.append(.model(model.summary(computers: store.computers))) }
        // 创建者能换 Pupu 的头像。没开 Google 登录（没有成员）时，云端把没主人的设备都当创建者，见 members.ts 的 actorOf。
        if me?.isCreator == true || store.members.isEmpty { pupu.append(.pupuAvatar(store.pupuAvatar)) }
        snapshot.appendItems(pupu, toSection: .pages(0))
        // 只有手机才有的两行，规范没画：单放一组在最下面。
        snapshot.appendItems([
            .link(.notifications, summary: Push.shared.status.summary),
            .link(.about, summary: nil)
        ], toSection: .pages(1))
    }

    private func renderAccounts(_ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        let store = Store.shared
        let connectors = store.connectors
        let member = store.members.first(where: \.current)
        let me = member?.id
        var mine: [Item] = []
        if let member {
            mine.append(.myAvatar(name: member.displayName, avatar: member.avatar))
            mine.append(.value(title: "Google 账户", value: member.email))
        }
        if let invites { mine.append(.link(.invites, summary: "还能生成 \(invites.left) 个")) }
        if !mine.isEmpty {
            snapshot.appendSections([.me])
            snapshot.appendItems(mine, toSection: .me)
        }
        if !connectors.accounts.isEmpty {
            snapshot.appendSections([.connected])
            snapshot.appendItems(connectors.accounts.map {
                // 别人连的写上是谁的；自己的不写。
                .account($0, owner: $0.memberId == me ? nil : $0.ownerEmail)
            }, toSection: .connected)
        }
        if connectors.enabled {
            snapshot.appendSections([.services, .note])
            snapshot.appendItems(connectors.services.map { .service($0, busy: connecting == $0.id) }, toSection: .services)
            snapshot.appendItems([
                .note("Pupu 读邮件、看日程直接用；发信、建日程、改 issue 这类写操作，会先推到连这个账号的人的手机上批准。凭据存在这个 Pupu 自己的 open-connector 里。")
            ], toSection: .note)
        } else {
            snapshot.appendSections([.note])
            snapshot.appendItems([
                .note("这个 Pupu 还没配连接器。配好 open-connector 之后，这里就能连 Gmail、Google 日历、云端硬盘和 GitHub。")
            ], toSection: .note)
        }
    }

    /// 电脑页（规范 ComputerRow）：在线的每台一块；离线的一台一行，点进去是同样的一块。右上角「配对」在最上面展开「连接新设备」，
    /// 一台电脑都没有时这一组一直开着。
    private func renderComputers(_ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        let computers = Store.shared.computers
        navigationItem.rightBarButtonItem = computers.isEmpty ? nil : pairButton
        pairButton.customView?.accessibilityValue = pairOpen ? "已展开" : "已收起"
        if pairOpen || computers.isEmpty { renderPair(&snapshot) }
        for computer in computers where computer.online { renderPanel(computer.settled, &snapshot) }
        let offline = computers.filter { !$0.online }
        if !offline.isEmpty {
            snapshot.appendSections([.offline])
            snapshot.appendItems(offline.map { .offlineComputer($0.settled) }, toSection: .offline)
        }
    }

    private func renderComputer(_ id: String, _ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        guard let computer = Store.shared.computer(id: id) else {
            snapshot.appendSections([.note])
            snapshot.appendItems([.note("这台电脑已经吊销了。")], toSection: .note)
            return
        }
        title = computer.name
        renderPanel(computer.settled, &snapshot)
    }

    /// 一台电脑那一块：头（主人自己的接「远程控制」），「Pupu 用它之前问我」，主人自己的「远程控制前」，能吊销的接「吊销」。
    private func renderPanel(_ computer: Computer, _ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        snapshot.appendSections([.panel(computer.id)])
        var items: [Item] = [.computerHead(computer), .policy(computer)]
        if isMine(computer) { items.append(.remoteConfirm(computer)) }
        if mayRevoke(owner: computer.ownerId) { items.append(.revokeComputer(computer)) }
        snapshot.appendItems(items, toSection: .panel(computer.id))
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
        guard let invites else {
            snapshot.appendSections([.note])
            snapshot.appendItems([.note("加载中…")], toSection: .note)
            return
        }
        snapshot.appendSections([.invites, .note])
        snapshot.appendItems(invites.invites.map(Item.inviteCode) + [.newInvite(left: invites.left, busy: creatingInvite)], toSection: .invites)
        snapshot.appendItems([
            .note("一个码给一个人开他自己的 Pupu，用一次就失效。没用掉的码也占名额，用不上就作废。")
        ], toSection: .note)
    }

    private func renderDevices(_ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        let store = Store.shared
        if store.devices.isEmpty {
            snapshot.appendSections([.note])
            snapshot.appendItems([.note("还没有配对的手机、浏览器或电脑 App。")], toSection: .note)
        } else {
            snapshot.appendSections([.devices])
            snapshot.appendItems(store.devices.map(Item.device), toSection: .devices)
        }
        renderPair(&snapshot)
    }

    /// 连接新设备（规范 Devices）：没生成时一整行是按钮；生成了是二维码、码和倒计时；用这个码的设备连上了、过期了或者点了「收起」，
    /// 换回一行按钮，下面写发生了什么。设备页和电脑页都有。
    private func renderPair(_ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        noticeJoined(Store.shared)
        snapshot.appendSections([.pair])
        let left = secondsLeft
        if let pairing, left > 0, !pairCollapsed {
            snapshot.appendItems([.code(pairing)], toSection: .pair)
            return
        }
        let expired = pairing != nil && left == 0
        let title = creating ? "正在生成…" : joined != nil || expired ? "再生成一个配对码" : "生成配对码"
        let note = pairError
            ?? joined.map { "「\($0)」连上了。" }
            ?? (expired ? "配对码已过期。" : "新手机、浏览器和电脑都用配对码连上。码 10 分钟内有效，用一次就作废。")
        snapshot.appendItems([.newCode(title: title, note: note, failed: pairError != nil, busy: creating)], toSection: .pair)
    }

    private func renderAbout(_ snapshot: inout NSDiffableDataSourceSnapshot<Section, Item>) {
        let base = Connection.shared.endpoint?.base.absoluteString ?? ""
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        snapshot.appendSections([.connection, .note])
        snapshot.appendItems([.server(base), .disconnect], toSection: .connection)
        snapshot.appendItems([.note("Pupu \(version)（\(build)）")], toSection: .note)
    }

    /// 生成码之后多出来一台设备或电脑，就是用这个码连上的：收起码，说一声。
    private func noticeJoined(_ store: Store) {
        guard pairing != nil else { return }
        let connected = store.devices.map { ($0.id, $0.name) } + store.computers.map { ($0.id, $0.name) }
        guard let added = connected.first(where: { !known.contains($0.0) }) else { return }
        joined = added.1
        pairing = nil
        stopTicking()
    }

    // MARK: - 格子

    /// 行底：`surface-inset`，按下换 `line`（和网页的 hover 一样）；组下面的说明没有行底。
    private func paint(_ cell: UICollectionViewListCell, plain: Bool) {
        cell.configurationUpdateHandler = { cell, state in
            var background = UIBackgroundConfiguration.listCell()
            background.backgroundColor = plain ? .clear : state.isHighlighted || state.isSelected ? Theme.line : Theme.surfaceInset
            cell.backgroundConfiguration = background
        }
    }

    /// 一行的字：`body`、`ink`；第二行 `subheadline`、`ink-muted`，能折行。行至少 52 高。
    private func rowContent(_ base: UIListContentConfiguration = .subtitleCell()) -> UIListContentConfiguration {
        var content = base
        content.textProperties.font = Theme.font(.body)
        content.textProperties.color = Theme.ink
        content.secondaryTextProperties.font = Theme.font(.subheadline)
        content.secondaryTextProperties.color = Theme.inkMuted
        content.secondaryTextProperties.numberOfLines = 0
        content.textToSecondaryTextVerticalPadding = Theme.Space.s0_5
        content.imageProperties.tintColor = Theme.ink
        content.imageToTextPadding = Theme.Space.s3
        content.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 15, leading: Theme.Space.s4, bottom: 15, trailing: Theme.Space.s4)
        return content
    }

    /// 两行字的行：上下 `space-2.5` 10。
    private func twoLines(_ content: inout UIListContentConfiguration) {
        content.directionalLayoutMargins.top = Theme.Space.s2_5
        content.directionalLayoutMargins.bottom = Theme.Space.s2_5
    }

    /// 「这个 Pupu」这一组左边的线条图标：20 见方。
    private func icon(_ content: inout UIListContentConfiguration, _ symbol: String) {
        content.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17))
        content.imageProperties.maximumSize = CGSize(width: 20, height: 20)
        content.imageProperties.reservedLayoutSize = CGSize(width: 20, height: 20)
    }

    private var chevron: UICellAccessory {
        .disclosureIndicator(options: .init(tintColor: Theme.inkFaint))
    }

    private func summary(_ text: String) -> UICellAccessory {
        .label(text: text, options: .init(tintColor: Theme.inkMuted, font: Theme.font(.subheadline)))
    }

    /// 行尾的文字按钮（「吊销」「移除」「断开」「作废」）：`subheadline`，`danger-ink`。
    private func textButton(_ title: String, label: String? = nil, action: @escaping () -> Void) -> UICellAccessory {
        var config = UIButton.Configuration.plain()
        config.title = title
        config.contentInsets = NSDirectionalEdgeInsets(top: Theme.Space.s2, leading: Theme.Space.s1, bottom: Theme.Space.s2, trailing: 0)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.subheadline)
            attributes.foregroundColor = Theme.dangerInk
            return attributes
        }
        let button = UIButton(configuration: config, primaryAction: UIAction { _ in action() })
        button.accessibilityLabel = label
        return .customView(configuration: .init(customView: button, placement: .trailing(), reservedLayoutWidth: .actual))
    }

    /// 名字后面跟一段 `ink-muted` 的字，比如「iPhone · 这台手机」。
    private func name(_ name: String, suffix: String?) -> NSAttributedString {
        let text = NSMutableAttributedString(string: name, attributes: [.font: Theme.font(.body), .foregroundColor: Theme.ink])
        if let suffix {
            text.append(NSAttributedString(string: " · \(suffix)", attributes: [.font: Theme.font(.body), .foregroundColor: Theme.inkMuted]))
        }
        return text
    }

    private func configure(_ cell: UICollectionViewListCell, item: Item) {
        var content = rowContent()
        cell.accessories = []
        cell.accessibilityTraits = []
        var plain = false
        switch item {
        case .profile(let title, let avatar):
            // 规范 SettingsSheet：头像 42、名字 `headline`，下面「账户、连上的服务」，这一行 64 高。
            content.text = title
            content.textProperties.font = Theme.font(.headline)
            content.secondaryText = "账户、连上的服务"
            content.secondaryTextProperties.numberOfLines = 1
            content.image = Avatars.round(
                Avatars.shared.image(avatar),
                letter: Avatars.letter(title),
                size: 42,
                pixelArt: Avatars.isPixelArt(avatar),
                fill: Theme.surface
            )
            content.imageProperties.maximumSize = CGSize(width: 42, height: 42)
            content.directionalLayoutMargins.top = 11
            content.directionalLayoutMargins.bottom = 11
            cell.accessories = [chevron]
        case .pupuAvatar:
            content = rowContent(.cell())
            content.text = "Pupu 的头像"
            let pupu = Avatars.shared.pupu()
            content.image = Avatars.round(pupu.image, letter: "P", size: 20, pixelArt: pupu.pixelArt)
            content.imageProperties.maximumSize = CGSize(width: 20, height: 20)
            content.imageProperties.reservedLayoutSize = CGSize(width: 20, height: 20)
            cell.accessories = [chevron]
        case .myAvatar(let name, let avatar):
            content = rowContent(.cell())
            content.text = "头像"
            let image = UIImageView(image: Avatars.round(
                Avatars.shared.image(avatar),
                letter: Avatars.letter(name),
                size: 28,
                pixelArt: Avatars.isPixelArt(avatar),
                fill: Theme.surface
            ))
            image.accessibilityLabel = "现在的头像"
            cell.accessories = [.customView(configuration: .init(customView: image, placement: .trailing(), reservedLayoutWidth: .actual)), chevron]
        case .value(let title, let value):
            content = rowContent(.valueCell())
            content.text = title
            content.secondaryText = value
            content.secondaryTextProperties.numberOfLines = 1
            content.prefersSideBySideTextAndSecondaryText = true
        case .model(let summary):
            content = rowContent(.valueCell())
            content.text = "模型"
            content.secondaryText = summary
            content.secondaryTextProperties.numberOfLines = 1
            content.prefersSideBySideTextAndSecondaryText = true
            icon(&content, "sparkles")
        case .org(let org, let status):
            // 规范 SettingsSheet：那个 Pupu 的头像 28（像素猫，不用名字的字），右边「N 人」，当前的打勾。
            content = rowContent(.cell())
            content.text = org.name
            let cat = org.current ? Avatars.shared.pupu() : orgAvatar(org)
            content.image = Avatars.round(cat.image, letter: "P", size: 28, pixelArt: cat.pixelArt)
            content.imageProperties.maximumSize = CGSize(width: 28, height: 28)
            cell.accessories = [summary(status ?? "\(org.members) 人")]
            if org.current {
                cell.accessories.append(.checkmark(options: .init(tintColor: Theme.ink)))
                cell.accessibilityTraits = [.selected]
            }
        case .openOwn:
            content = rowContent(.cell())
            content.text = "开自己的 Pupu"
            content.image = UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16))
            content.imageProperties.reservedLayoutSize = CGSize(width: 28, height: 28)
        case .link(let target, let text):
            content = rowContent(.cell())
            content.text = target.title
            // 只有设置首页的入口左边画图标；账户页的「邀请码」不画，和「头像」「Google 账户」对齐。
            if page == .root { icon(&content, target.symbol) }
            if let text { cell.accessories.append(summary(text)) }
            cell.accessories.append(chevron)
        case .account(let account, let owner):
            content.text = account.name
            content.secondaryText = [account.account, owner.map { "\($0) 连的" }].compactMap { $0 }.joined(separator: " · ")
            content.image = UIImage(systemName: symbol(of: account.service))
            twoLines(&content)
            if account.removable {
                cell.accessories = [textButton("断开", label: "断开\(account.name)") { [weak self] in self?.confirmRemove(account) }]
            }
        case .service(let service, let busy):
            content.text = service.name
            content.secondaryText = service.detail
            content.image = UIImage(systemName: service.symbol)
            twoLines(&content)
            // 行里的小胶囊（网页 PILL_ROW）：`surface` 底、往里收 1pt `line`，高 32，`subheadline` 600。
            var config = UIButton.Configuration.filled()
            config.title = busy ? "正在连…" : "连接"
            config.cornerStyle = .capsule
            config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s3, bottom: 0, trailing: Theme.Space.s3)
            config.background.strokeColor = Theme.line
            config.background.strokeWidth = 1
            config.paint(fill: Theme.surface, ink: Theme.ink, style: .subheadline)
            let connect = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in
                self?.connect(service)
            })
            connect.configurationUpdateHandler = { button in
                button.configuration?.paint(fill: Theme.surface, ink: button.isEnabled ? Theme.ink : Theme.inkMuted, pressed: button.isHighlighted, style: .subheadline)
            }
            connect.heightAnchor.constraint(equalToConstant: 32).isActive = true
            connect.isEnabled = connecting == nil
            cell.accessories = [.customView(configuration: .init(customView: connect, placement: .trailing(), reservedLayoutWidth: .actual))]
        case .offlineComputer(let computer):
            content.text = computer.name
            content.secondaryAttributedText = statusText(computer.label, online: false)
            icon(&content, "desktopcomputer")
            twoLines(&content)
            cell.accessories = [chevron]
        case .revokeComputer:
            content = rowContent(.cell())
            content.text = "吊销"
            content.textProperties.color = Theme.dangerInk
            cell.accessibilityTraits = .button
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
            twoLines(&content)
            content.directionalLayoutMargins.top = Theme.Space.s3
            content.directionalLayoutMargins.bottom = Theme.Space.s3
        case .member(let member, let removable):
            content.attributedText = name(member.email, suffix: member.current ? "你" : nil)
            content.secondaryText = member.label
            // 规范 Avatar：成员列表 32；行是 surface-inset 底，首字的圆垫 surface。
            content.image = Avatars.round(
                Avatars.shared.image(member.avatar),
                letter: Avatars.letter(member.displayName),
                size: 32,
                pixelArt: Avatars.isPixelArt(member.avatar),
                fill: Theme.surface
            )
            content.imageProperties.maximumSize = CGSize(width: 32, height: 32)
            twoLines(&content)
            if removable {
                cell.accessories = [textButton("移除", label: "移除 \(member.email)") { [weak self] in self?.confirmRemove(member) }]
            }
        case .invite:
            content.text = "邀请成员"
            content.textProperties.font = Theme.font(.body, weight: .semibold)
            content.secondaryText = "填他的 Google 邮箱。他用这个账号登录就能一起用 Pupu；他的第一台手机要一台已经连上的手机点「允许」。"
            content.directionalLayoutMargins.top = Theme.Space.s3
            content.directionalLayoutMargins.bottom = Theme.Space.s3
        case .inviteCode(let invite):
            content.text = invite.code
            content.textProperties.font = UIFontMetrics(forTextStyle: .body)
                .scaledFont(for: .monospacedSystemFont(ofSize: 17, weight: .semibold))
            twoLines(&content)
            if let usedBy = invite.usedBy {
                content.secondaryText = usedBy
            } else {
                content.secondaryText = "点一下发给对方"
                cell.accessories = [textButton("作废", label: "作废 \(invite.code)") { [weak self] in self?.revokeInvite(invite.code) }]
            }
        case .newInvite(let left, let busy):
            content.text = busy ? "正在生成…" : "生成邀请码"
            content.textProperties.font = Theme.font(.body, weight: .semibold)
            content.textProperties.color = left > 0 ? Theme.ink : Theme.inkMuted
            content.secondaryText = left > 0 ? "还能生成 \(left) 个" : "名额用完了"
            content.directionalLayoutMargins.top = Theme.Space.s3
            content.directionalLayoutMargins.bottom = Theme.Space.s3
        case .device(let device):
            // 规范 Devices：第一行名字，眼前这台跟「 · 这台手机」；第二行种类、谁的、上次用的时间。
            content.attributedText = name(device.name, suffix: device.current ? "这台手机" : nil)
            content.secondaryText = device.label
            twoLines(&content)
            if mayRevoke(owner: device.memberId) {
                cell.accessories = [textButton("吊销", label: "吊销「\(device.name)」") { [weak self] in self?.confirmRevoke(device) }]
            }
        case .newCode(let title, let note, let failed, let busy):
            // 规范 Devices：内边距上下 12，字 `body` 600；下面一句 `subheadline`，出错时 `danger-ink`。
            content.text = title
            content.textProperties.font = Theme.font(.body, weight: .semibold)
            content.textProperties.color = busy ? Theme.inkMuted : Theme.ink
            content.secondaryText = note
            content.secondaryTextProperties.color = failed ? Theme.dangerInk : Theme.inkMuted
            content.directionalLayoutMargins.top = Theme.Space.s3
            content.directionalLayoutMargins.bottom = Theme.Space.s3
            cell.accessibilityTraits = .button
        case .server(let base):
            content.text = base
            content.secondaryText = "这台手机的设备凭据存在钥匙串里"
            twoLines(&content)
        case .disconnect:
            content = rowContent(.cell())
            content.text = "退出这个 Pupu"
            content.textProperties.color = Theme.dangerInk
            cell.accessibilityTraits = .button
        case .note(let text):
            // 组下面的说明：`footnote`、`ink-muted`，左边让出 4，离组 8。
            plain = true
            content = UIListContentConfiguration.cell()
            content.text = text
            content.textProperties.font = Theme.font(.footnote)
            content.textProperties.color = Theme.inkMuted
            content.textProperties.numberOfLines = 0
            content.directionalLayoutMargins = NSDirectionalEdgeInsets(top: Theme.Space.s2, leading: Theme.Space.s1, bottom: 0, trailing: Theme.Space.s1)
        case .computerHead, .policy, .remoteConfirm, .code:
            break
        }
        cell.contentConfiguration = content
        paint(cell, plain: plain)
    }

    /// 自己排的几行：电脑那一块的头、两行档位、生成好的配对码。
    private func configure(host cell: HostCell, item: Item) {
        cell.accessories = []
        paint(cell, plain: false)
        switch item {
        case .computerHead(let computer):
            let view = cell.hosted { ComputerHeadView() }
            let owner = computer.ownerId.flatMap { id in Store.shared.members.first { $0.id == id }?.displayName }
            let status = [computer.label, owner.map { "\($0)的" }].compactMap { $0 }.joined(separator: " · ")
            view.show(
                name: computer.name,
                status: status,
                online: computer.online,
                remote: isMine(computer) ? computer.online ? .online : .offline : .none
            )
            view.onRemote = { [weak self] in
                guard let self, let endpoint = Connection.shared.endpoint,
                      let fresh = Store.shared.computer(id: computer.id), fresh.online else { return }
                RemoteDesktopViewController.open(fresh, endpoint: endpoint, from: self)
            }
        case .policy(let computer):
            let view = cell.hosted { MenuRowView() }
            view.show(
                title: "Pupu 用它之前问我",
                value: computer.currentPolicy.title,
                menu: policyMenu(for: computer),
                label: "「\(computer.name)」上什么时候先问你"
            )
        case .remoteConfirm(let computer):
            let view = cell.hosted { MenuRowView() }
            view.show(
                title: "远程控制前",
                value: computer.currentRemoteConfirm.title,
                menu: remoteConfirmMenu(for: computer),
                label: "远程控制「\(computer.name)」前要不要确认"
            )
        case .code(let pairing):
            let view = cell.hosted { PairCodeView() }
            view.show(code: pairing.code, link: pairLink(pairing), seconds: secondsLeft, copied: copiedAt.map { Date.now.timeIntervalSince($0) < 2 } ?? false)
            view.onCopy = { [weak self] in self?.copyCode(pairing) }
            view.onCollapse = { [weak self] in
                self?.pairCollapsed = true
                self?.render()
            }
        default:
            break
        }
    }

    private func symbol(of service: String) -> String {
        Store.shared.connectors.services.first { $0.id == service }?.symbol ?? "link"
    }

    /// 拿到了头像图，有头像的格子重画一遍。
    private func reconfigureAvatars() {
        var snapshot = source.snapshot()
        let items = snapshot.itemIdentifiers.filter {
            switch $0 {
            case .profile, .member, .pupuAvatar, .myAvatar, .org: true
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
        case .profile, .myAvatar, .link, .pupuAvatar, .offlineComputer, .revokeComputer, .notifications, .invite, .disconnect: true
        case .inviteCode(let invite): invite.usedBy == nil
        case .newInvite(let left, let busy): left > 0 && !busy
        case .newCode(_, _, _, let busy): !busy
        case .org(let org, _): !org.current && switching == nil
        case .openOwn: switching == nil
        default: false
        }
    }

    override func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: true)
        switch source.itemIdentifier(for: indexPath) {
        case .profile:
            navigationController?.pushViewController(SettingsViewController(page: .accounts), animated: true)
        case .myAvatar:
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
        case .offlineComputer(let computer):
            navigationController?.pushViewController(SettingsViewController(page: .computer(computer.id)), animated: true)
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
        case .disconnect:
            let sheet = UIAlertController(
                title: nil,
                message: "这台手机会从这个 Pupu 注销，回到连接页。要再连，就用配对码重新配对。",
                preferredStyle: .actionSheet
            )
            sheet.addAction(UIAlertAction(title: "退出这个 Pupu", style: .destructive) { _ in
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

    /// 点码复制：倒计时那里写两秒「已复制。」，下一跳就换回倒计时。
    private func copyCode(_ pairing: PairingCode) {
        UIPasteboard.general.string = pairing.code
        copiedAt = .now
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        reconfigureCode()
    }

    private func createCode() {
        guard !creating, let api = Store.shared.api else { return }
        creating = true
        pairError = nil
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
                copiedAt = nil
                pairCollapsed = false
                pairing = code
                startTicking()
            } catch {
                pairError = error.localizedDescription
            }
        }
    }

    /// 还剩几秒。没有码是 0。
    private var secondsLeft: Int {
        guard let pairing else { return 0 }
        return max(0, Int((pairing.expiresAt / 1000 - Date.now.timeIntervalSince1970).rounded(.up)))
    }

    /// 二维码里的链接：`pupu://pair?server=<Pupu 的地址>&code=<配对码>`，和网页一样编码。
    private func pairLink(_ pairing: PairingCode) -> String {
        var server = Connection.shared.endpoint?.base.absoluteString ?? ""
        if server.hasSuffix("/") { server.removeLast() }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()"))
        let encode = { (text: String) in text.addingPercentEncoding(withAllowedCharacters: allowed) ?? text }
        return "pupu://pair?server=\(encode(server))&code=\(encode(pairing.code))"
    }

    /// 倒计时每秒走一次，离开这一页就停。走完了收起，写「配对码已过期。」。
    private func startTicking() {
        guard ticker == nil, pairing != nil else { return }
        ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func stopTicking() {
        ticker?.invalidate()
        ticker = nil
    }

    private func tick() {
        guard pairing != nil else { return stopTicking() }
        if secondsLeft == 0 {
            stopTicking()
            render()
        } else {
            reconfigureCode()
        }
    }

    private func reconfigureCode() {
        var snapshot = source.snapshot()
        let codes = snapshot.itemIdentifiers.filter { if case .code = $0 { true } else { false } }
        guard !codes.isEmpty else { return }
        snapshot.reconfigureItems(codes)
        source.apply(snapshot, animatingDifferences: false)
    }

    /// 电脑页右上角的「配对」（规范 Devices）：`surface-inset` 胶囊，`plus` 加「配对」，高 36。点了在最上面展开、收起「连接新设备」。
    private func makePairButton() -> UIBarButtonItem {
        var config = UIButton.Configuration.filled()
        config.title = "配对"
        config.image = UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold))
        config.imagePadding = Theme.Space.s1
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 14, bottom: 0, trailing: 14)
        config.paint(fill: Theme.surfaceInset, ink: Theme.ink, style: .subheadline)
        let button = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in
            guard let self else { return }
            self.pairOpen.toggle()
            self.render()
        })
        button.configurationUpdateHandler = { button in
            button.configuration?.paint(fill: Theme.surfaceInset, ink: Theme.ink, pressed: button.isHighlighted, style: .subheadline)
        }
        button.heightAnchor.constraint(equalToConstant: Theme.Size.controlSmall).isActive = true
        let item = UIBarButtonItem(customView: button)
        item.hidesSharedBackground = true
        return item
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

    /// 主人自己的电脑（还没主人的也算）：「远程控制」和「远程控制前」只给主人，云端也这么判。
    private func isMine(_ computer: Computer) -> Bool {
        let me = Store.shared.members.first(where: \.current)
        return computer.ownerId == nil || computer.ownerId == me?.id
    }

    /// 别的 Pupu 的头像：只知道预设的像素猫，上传的图、没拿到时用自带的猫。
    private func orgAvatar(_ org: OrgList.Org) -> (image: UIImage?, pixelArt: Bool) {
        if Avatars.isPixelArt(org.avatar), let image = Avatars.shared.image(org.avatar) { return (image, true) }
        return (UIImage(named: "pupu-avatar"), true)
    }

    /// 分级的三档。别人的电脑只能往严里改，放宽的几项灰掉。
    private func policyMenu(for computer: Computer) -> UIMenu {
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
        return UIMenu(options: .singleSelection, children: actions)
    }

    /// 远程控制前确认几档。手机按面容确认，三档都能选；放宽只有主人（这一行也只给主人）。
    private func remoteConfirmMenu(for computer: Computer) -> UIMenu {
        let actions = Computer.RemoteConfirm.allCases.map { level in
            UIAction(title: level.title, state: computer.currentRemoteConfirm == level ? .on : .off) { [weak self] _ in
                guard level != computer.currentRemoteConfirm else { return }
                self?.setRemoteConfirm(level, of: computer.id)
            }
        }
        return UIMenu(options: .singleSelection, children: actions)
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
    /// 设置首页通知那一行右边的字。
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
        return Computer(id: id, name: name, ownerId: ownerId, online: online, stale: stale, lastSeenAt: nil, policy: policy, screen: screen, remoteConfirm: remoteConfirm, remoteTrusted: remoteTrusted, model: model)
    }
}
