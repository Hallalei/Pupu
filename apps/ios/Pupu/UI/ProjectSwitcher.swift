import UIKit

/// 切换项目的整页列表，照 Hark 做：第一行「新项目」，下面是项目名和进展，最近活动的在前，当前项目加粗。
/// 盖在项目页的内容上，顶栏留在上面，所以不用 present。
final class ProjectSwitcher: UIVisualEffectView, UICollectionViewDelegate {
    nonisolated private enum Item: Hashable, Sendable {
        case create
        case project(Project, current: Bool, waiting: Bool)
    }

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

        let cell = UICollectionView.CellRegistration<ProjectCell, Item> { cell, _, item in
            switch item {
            case .create:
                cell.show(title: "新项目", weight: .medium, detail: nil, waiting: false)
            case .project(let project, let current, let waiting):
                cell.show(title: project.name, weight: current ? .semibold : .regular, detail: project.summary, waiting: waiting)
            }
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
        let waiting = ComputerActivity.waitingProjects(Store.shared.activity)
        var snapshot = NSDiffableDataSourceSnapshot<Int, Item>()
        snapshot.appendSections([0])
        snapshot.appendItems([.create] + Store.shared.projects.map {
            .project($0, current: $0.id == current, waiting: waiting.contains($0.id))
        })
        source.apply(snapshot, animatingDifferences: false)
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: false)
        switch source.itemIdentifier(for: indexPath) {
        case .create:
            create()
        case .project(let project, _, _):
            open(project)
        case nil:
            break
        }
    }
}

/// 列表的一行：名字和进展，等批时右边带标记。自己排版：UICellAccessory 放这个标记时会超出屏幕右边。
private final class ProjectCell: UICollectionViewListCell {
    private let name = UILabel(style: .body)
    private let detail = UILabel(style: .subheadline, color: Theme.inkMuted)
    private let mark = WaitingMark()

    override init(frame: CGRect) {
        super.init(frame: frame)
        let text = UIStackView(arrangedSubviews: [name, detail])
        text.axis = .vertical
        text.spacing = 2
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let row = UIStackView(arrangedSubviews: [text, UIView(), mark])
        row.spacing = Theme.Space.s3
        row.alignment = .center
        contentView.addSubview(row)
        row.pin(to: contentView, insets: UIEdgeInsets(top: Theme.Space.s2_5, left: Theme.Space.s4, bottom: Theme.Space.s2_5, right: Theme.Space.s4))
        let height = contentView.heightAnchor.constraint(greaterThanOrEqualToConstant: 52)
        height.priority = .required - 1
        height.isActive = true
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { fatalError() }

    func show(title: String, weight: UIFont.Weight, detail text: String?, waiting: Bool) {
        name.text = title
        name.font = Theme.font(.body, weight: weight)
        detail.text = text
        detail.isHidden = text == nil
        mark.isHidden = !waiting
        accessibilityLabel = [title, text, waiting ? "等你批准" : nil].compactMap { $0 }.joined(separator: "，")
    }
}
