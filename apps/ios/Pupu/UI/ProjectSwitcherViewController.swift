import UIKit

/// 切换项目的 sheet：第一行「新项目」，下面是全部项目，最近活动的在前。
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
            var content = UIListContentConfiguration.cell()
            switch item {
            case .create:
                content.text = "新项目"
                content.image = UIImage(systemName: "plus")
                content.textProperties.color = Theme.inkMuted
                content.imageProperties.tintColor = Theme.inkMuted
                cell.accessories = []
            case .project(let project):
                content.text = project.name
                let selected = project.id == self?.current
                content.textProperties.font = Theme.font(selected ? .headline : .body)
                content.textProperties.color = Theme.ink
                cell.accessories = selected ? [.checkmark()] : []
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
