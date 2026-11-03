import UIKit

/// 设置：授权的电脑、每台电脑的权限分级、通知、成员、配对过的手机和浏览器、给新设备生成配对码、连的是哪个 Pupu。
final class SettingsViewController: UICollectionViewController {
    nonisolated private enum Section: Hashable, Sendable {
        case computers
        case policy(computerId: String, name: String)
        case abilities
        case notifications
        case members
        case devices
        case pair
        case connection
    }

    nonisolated private enum Item: Hashable, Sendable {
        case computer(Computer)
        case noComputer
        case policy(computerId: String, policy: Computer.Policy, selected: Bool)
        case abilities
        case notifications(Push.Status, busy: Bool)
        case member(Member, removable: Bool)
        case invite
        case device(Device)
        case noDevice
        case newCode(note: String, busy: Bool)
        case code(PairingCode)
        case bridgeCommand(String)
        case server(String)
        case disconnect
    }

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
    private var pushToken: NSObjectProtocol?

    init() {
        var config = UICollectionLayoutListConfiguration(appearance: .insetGrouped)
        config.headerMode = .supplementary
        super.init(collectionViewLayout: UICollectionViewCompositionalLayout.list(using: config))
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "设置"
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })

        let cell = UICollectionView.CellRegistration<UICollectionViewListCell, Item> { [weak self] cell, _, item in
            self?.configure(cell, item: item)
        }
        let header = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(
            elementKind: UICollectionView.elementKindSectionHeader
        ) { [weak self] view, _, path in
            var content = UIListContentConfiguration.header()
            content.text = self?.source.sectionIdentifier(for: path.section).map(Self.title)
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
        Push.shared.register()
        render()
    }

    private static func title(_ section: Section) -> String {
        switch section {
        case .computers: "电脑"
        case .policy(_, let name): "「\(name)」的权限分级"
        case .abilities: "这台电脑能做的"
        case .notifications: "通知"
        case .members: "成员"
        case .devices: "手机、浏览器和电脑 App"
        case .pair: "连接新设备"
        case .connection: "连接"
        }
    }

    private func render() {
        let store = Store.shared
        var snapshot = NSDiffableDataSourceSnapshot<Section, Item>()
        snapshot.appendSections([.computers])
        snapshot.appendItems(store.computers.isEmpty ? [.noComputer] : store.computers.map(Item.computer), toSection: .computers)
        for computer in store.computers {
            let section = Section.policy(computerId: computer.id, name: computer.name)
            snapshot.appendSections([section])
            snapshot.appendItems(Computer.Policy.allCases.map {
                .policy(computerId: computer.id, policy: $0, selected: computer.currentPolicy == $0)
            }, toSection: section)
        }
        snapshot.appendSections([.abilities, .notifications])
        snapshot.appendItems([.abilities], toSection: .abilities)
        snapshot.appendItems([.notifications(Push.shared.status, busy: testing)], toSection: .notifications)
        // 没开 Google 登录、还没有创建者时没有成员，这一节不显示。
        if !store.members.isEmpty {
            let me = store.members.first(where: \.current)
            snapshot.appendSections([.members])
            snapshot.appendItems(store.members.map {
                .member($0, removable: me?.isCreator == true && !$0.isCreator)
            }, toSection: .members)
            // 邀请只有创建者在手机上能做（云端 members.ts 的 mayInvite）。
            if me?.isCreator == true { snapshot.appendItems([.invite], toSection: .members) }
        }
        snapshot.appendSections([.devices, .pair, .connection])
        snapshot.appendItems(store.devices.isEmpty ? [.noDevice] : store.devices.map(Item.device), toSection: .devices)
        let base = Connection.shared.endpoint?.base.absoluteString ?? ""
        noticeJoined(store)
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
        snapshot.appendItems([.server(base), .disconnect], toSection: .connection)
        source.apply(snapshot, animatingDifferences: false)
    }

    /// 生成码之后多出来一台设备或电脑，就是用这个码连上的：收起码，说一声。
    private func noticeJoined(_ store: Store) {
        guard pairing != nil else { return }
        let connected = store.devices.map { ($0.id, $0.name) } + store.computers.map { ($0.id, $0.name) }
        guard let added = connected.first(where: { !known.contains($0.0) }) else { return }
        joined = added.1
        pairing = nil
    }

    private func configure(_ cell: UICollectionViewListCell, item: Item) {
        var content = UIListContentConfiguration.subtitleCell()
        content.textProperties.font = Theme.font(.body)
        content.textProperties.color = Theme.ink
        content.secondaryTextProperties.font = Theme.font(.subheadline)
        content.secondaryTextProperties.color = Theme.inkMuted
        content.secondaryTextProperties.numberOfLines = 0
        cell.accessories = []
        switch item {
        case .computer(let computer):
            content.text = computer.name
            content.secondaryText = [computer.label, email(of: computer.ownerId)].compactMap { $0 }.joined(separator: " · ")
            content.image = UIImage(systemName: "circle.fill")
            content.imageProperties.tintColor = computer.online ? Theme.online : Theme.offline
            content.imageProperties.maximumSize = CGSize(width: 8, height: 8)
            let revoke = UIButton(configuration: .plain(), primaryAction: UIAction(title: "吊销") { [weak self] _ in
                self?.confirmRevoke(computer)
            })
            revoke.configuration?.baseForegroundColor = Theme.dangerInk
            if mayRevoke(owner: computer.ownerId) {
                cell.accessories = [.customView(configuration: .init(customView: revoke, placement: .trailing()))]
            }
        case .noComputer:
            content.text = "还没有授权的电脑"
            content.secondaryText = "在电脑上配对桥之后，这里会显示它在不在线。"
        case .policy(_, let policy, let selected):
            content.text = policy.title
            content.secondaryText = policy.detail
            cell.accessories = selected ? [.checkmark()] : []
        case .abilities:
            content.text = nil
            content.secondaryText = "跑命令，读写主目录里的文件，看屏幕、点鼠标、打字。第一次操作屏幕前，要在那台电脑的系统设置里给 Pupu 电脑 App 开屏幕录制和辅助功能（开发版叫 Electron）。"
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
        case .disconnect:
            content.text = "换一个 Pupu"
            content.textProperties.color = Theme.dangerInk
        }
        cell.contentConfiguration = content
    }

    override func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
        switch source.itemIdentifier(for: indexPath) {
        case .policy, .notifications, .invite, .newCode, .code, .bridgeCommand, .disconnect: true
        default: false
        }
    }

    override func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: true)
        switch source.itemIdentifier(for: indexPath) {
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
            message: "移除后 \(member.email) 不能再登录，他名下的手机、浏览器、电脑 App 和电脑马上断开。",
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
