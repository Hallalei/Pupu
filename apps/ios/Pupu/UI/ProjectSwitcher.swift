import UIKit

/// 切换项目的整页列表，照 Hark 做：第一行「新项目」，下面是项目名，最近活动的在前，当前项目加粗。
/// 盖在项目页的内容上，顶栏留在上面，所以不用 present。
final class ProjectSwitcher: UIVisualEffectView, UICollectionViewDelegate {
    nonisolated private enum Item: Hashable, Sendable {
        case create
        case project(Project, current: Bool)
    }

    private static let rowHeight: CGFloat = 52

    /// 当前项目的 id。
    var current: String? {
        didSet { render() }
    }

    /// 顶栏下方还有审批卡时，列表让开的高度。
    var topInset: CGFloat = 0 {
        didSet { list.contentInset.top = Theme.Space.s3 + topInset }
    }

    private let open: (Project) -> Void
    private let create: () -> Void
    private let list: UICollectionView
    private var source: UICollectionViewDiffableDataSource<Int, Item>!
    private var token: StoreToken?

    init(open: @escaping (Project) -> Void, create: @escaping () -> Void) {
        self.open = open
        self.create = create
        var config = UICollectionLayoutListConfiguration(appearance: .plain)
        config.backgroundColor = .clear
        config.showsSeparators = false
        list = UICollectionView(frame: .zero, collectionViewLayout: UICollectionViewCompositionalLayout.list(using: config))
        super.init(effect: UIBlurEffect(style: .systemUltraThinMaterial))
        contentView.backgroundColor = Theme.surfaceStrong
        list.backgroundColor = .clear
        list.contentInset.top = Theme.Space.s3
        list.topEdgeEffect.style = .soft
        list.delegate = self
        contentView.addSubview(list)
        list.pin(to: contentView)

        let cell = UICollectionView.CellRegistration<UICollectionViewListCell, Item> { cell, _, item in
            var content = UIListContentConfiguration.cell()
            switch item {
            case .create:
                content.text = "新项目"
                content.textProperties.font = Theme.font(.body, weight: .medium)
            case .project(let project, let current):
                content.text = project.name
                content.textProperties.font = Theme.font(.body, weight: current ? .semibold : .regular)
            }
            content.textProperties.color = Theme.ink
            content.textProperties.numberOfLines = 1
            let margin = max(Theme.Space.s2, (Self.rowHeight - content.textProperties.font.lineHeight) / 2)
            content.axesPreservingSuperviewLayoutMargins = []
            content.directionalLayoutMargins = NSDirectionalEdgeInsets(
                top: margin, leading: Theme.Space.s4, bottom: margin, trailing: Theme.Space.s4
            )
            cell.contentConfiguration = content
            cell.configurationUpdateHandler = { cell, state in
                var background = UIBackgroundConfiguration.clear()
                background.backgroundColor = state.isHighlighted ? Theme.scrim : .clear
                cell.backgroundConfiguration = background
            }
        }
        source = UICollectionViewDiffableDataSource(collectionView: list) { view, path, item in
            view.dequeueConfiguredReusableCell(using: cell, for: path, item: item)
        }
        token = Store.shared.observe { [weak self] in self?.render() }
        render()
    }

    required init?(coder: NSCoder) { fatalError() }

    private func render() {
        var snapshot = NSDiffableDataSourceSnapshot<Int, Item>()
        snapshot.appendSections([0])
        snapshot.appendItems([.create] + Store.shared.projects.map { .project($0, current: $0.id == current) })
        source.apply(snapshot, animatingDifferences: false)
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: false)
        switch source.itemIdentifier(for: indexPath) {
        case .create:
            create()
        case .project(let project, _):
            open(project)
        case nil:
            break
        }
    }
}
