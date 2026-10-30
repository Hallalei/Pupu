import UIKit

/// 设置：授权的电脑、每台电脑的权限分级、怎么再配一台、连的是哪个 Pupu。
final class SettingsViewController: UICollectionViewController {
    nonisolated private enum Section: Hashable, Sendable {
        case computers
        case policy(computerId: String, name: String)
        case abilities
        case pair
        case connection
    }

    nonisolated private enum Item: Hashable, Sendable {
        case computer(Computer)
        case noComputer
        case policy(computerId: String, policy: Computer.Policy, selected: Bool)
        case abilities
        case pair(String)
        case server(String)
        case disconnect
    }

    private var source: UICollectionViewDiffableDataSource<Section, Item>!
    private var token: StoreToken?
    private var copied = false

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
        render()
    }

    private static func title(_ section: Section) -> String {
        switch section {
        case .computers: "电脑"
        case .policy(_, let name): "「\(name)」的权限分级"
        case .abilities: "这台电脑能做的"
        case .pair: "再配一台"
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
        snapshot.appendSections([.abilities, .pair, .connection])
        snapshot.appendItems([.abilities], toSection: .abilities)
        let base = Connection.shared.endpoint?.base.absoluteString ?? ""
        let token = Connection.shared.endpoint?.token == nil ? "" : " --token 访问口令"
        snapshot.appendItems([.pair("npm run bridge -- pair --url \(base)\(token) --name 电脑名")], toSection: .pair)
        snapshot.appendItems([.server(base), .disconnect], toSection: .connection)
        source.apply(snapshot, animatingDifferences: false)
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
            content.secondaryText = computer.label
            content.image = UIImage(systemName: "circle.fill")
            content.imageProperties.tintColor = computer.online ? Theme.online : Theme.offline
            content.imageProperties.maximumSize = CGSize(width: 8, height: 8)
            let revoke = UIButton(configuration: .plain(), primaryAction: UIAction(title: "吊销") { [weak self] _ in
                self?.confirmRevoke(computer)
            })
            revoke.configuration?.baseForegroundColor = Theme.dangerInk
            cell.accessories = [.customView(configuration: .init(customView: revoke, placement: .trailing()))]
        case .noComputer:
            content.text = "还没有授权的电脑"
            content.secondaryText = "在电脑上配对桥之后，这里会显示它在不在线。"
        case .policy(_, let policy, let selected):
            content.text = policy.title
            content.secondaryText = policy.detail
            cell.accessories = selected ? [.checkmark()] : []
        case .abilities:
            content.text = nil
            content.secondaryText = "跑命令，读写主目录里的文件，看屏幕、点鼠标、打字。第一次操作屏幕时，系统会要求允许 pupu-computer-use 的屏幕录制和辅助功能。"
        case .pair(let command):
            content.text = command
            content.textProperties.font = Theme.font(.code)
            content.textProperties.numberOfLines = 0
            let placeholders = Connection.shared.endpoint?.token == nil ? "「电脑名」" : "「访问口令」和「电脑名」"
            content.secondaryText = (copied ? "已复制。" : "点一下复制。") + "在 apps/cloud 目录里跑，先把\(placeholders)换成你的。"
        case .server(let base):
            content.text = base
            content.secondaryText = Connection.shared.endpoint?.token == nil ? "没有访问口令" : "访问口令存在钥匙串里"
        case .disconnect:
            content.text = "换一个 Pupu"
            content.textProperties.color = Theme.dangerInk
        }
        cell.contentConfiguration = content
    }

    override func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
        switch source.itemIdentifier(for: indexPath) {
        case .policy, .pair, .disconnect: true
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
        case .pair(let command):
            UIPasteboard.general.string = command
            copied = true
            var snapshot = source.snapshot()
            snapshot.reconfigureItems([.pair(command)])
            source.apply(snapshot, animatingDifferences: false)
        case .disconnect:
            let sheet = UIAlertController(
                title: nil,
                message: "这台手机会忘掉现在的地址和访问口令，回到连接页。",
                preferredStyle: .actionSheet
            )
            sheet.addAction(UIAlertAction(title: "换一个 Pupu", style: .destructive) { [weak self] _ in
                self?.dismiss(animated: true) { Connection.shared.forget() }
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

    private func show(_ text: String) {
        let alert = UIAlertController(title: "没做成", message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        present(alert, animated: true)
    }
}
