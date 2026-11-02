import UIKit

/// 切换项目的 sheet：第一行「新项目」，下面是全部项目，最近活动的在前。
/// 每行两行字：名字和目标；右边当前项目打勾，其余写多久前动过。
final class ProjectSwitcherViewController: UICollectionViewController {
    nonisolated private enum Item: Hashable, Sendable {
        case create
        case project(Project)
    }

    private let current: String?
    private let open: (Project) -> Void
    private let create: () -> Void
    private var source: UICollectionViewDiffableDataSource<Int, Item>!
    private var token: StoreToken?

    init(current: String?, open: @escaping (Project) -> Void, create: @escaping () -> Void) {
        self.current = current
        self.open = open
        self.create = create
        var config = UICollectionLayoutListConfiguration(appearance: .plain)
        config.backgroundColor = .clear
        super.init(collectionViewLayout: UICollectionViewCompositionalLayout.list(using: config))
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "项目"
        let cell = UICollectionView.CellRegistration<UICollectionViewListCell, Item> { [weak self] cell, _, item in
            var content: UIListContentConfiguration
            switch item {
            case .create:
                content = .cell()
                content.text = "新项目"
                content.image = UIImage(systemName: "plus")
                content.textProperties.font = Theme.font(.body)
                content.textProperties.color = Theme.ink
                content.imageProperties.tintColor = Theme.ink
                cell.accessories = []
            case .project(let project):
                content = .subtitleCell()
                content.text = project.name
                content.secondaryText = project.goal.isBlank ? "没写目标" : project.goal
                let selected = project.id == self?.current
                content.textProperties.font = Theme.font(selected ? .headline : .body)
                content.textProperties.color = Theme.ink
                content.secondaryTextProperties.font = Theme.font(.subheadline)
                content.secondaryTextProperties.color = Theme.inkMuted
                content.secondaryTextProperties.numberOfLines = 1
                content.textToSecondaryTextVerticalPadding = 2
                content.directionalLayoutMargins = NSDirectionalEdgeInsets(
                    top: Theme.Space.s3, leading: 0, bottom: Theme.Space.s3, trailing: 0
                )
                let time = UILabel(text: Ago.text(project.updatedAt), style: .caption, color: Theme.inkMuted)
                cell.accessories = selected
                    ? [.checkmark()]
                    : [.customView(configuration: .init(customView: time, placement: .trailing()))]
            }
            content.textProperties.numberOfLines = 1
            cell.contentConfiguration = content
            var background = UIBackgroundConfiguration.listCell()
            background.backgroundColor = .clear
            cell.backgroundConfiguration = background
        }
        source = UICollectionViewDiffableDataSource(collectionView: collectionView) { view, path, item in
            view.dequeueConfiguredReusableCell(using: cell, for: path, item: item)
        }
        token = Store.shared.observe { [weak self] in self?.render() }
        render()
    }

    private func render() {
        var snapshot = NSDiffableDataSourceSnapshot<Int, Item>()
        snapshot.appendSections([0])
        snapshot.appendItems([.create] + Store.shared.projects.map(Item.project))
        source.apply(snapshot, animatingDifferences: false)
    }

    override func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: true)
        switch source.itemIdentifier(for: indexPath) {
        case .create:
            create()
        case .project(let project):
            dismiss(animated: true)
            open(project)
        case nil:
            break
        }
    }
}
