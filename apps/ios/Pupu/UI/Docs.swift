import UIKit
import UniformTypeIdentifiers
import WebKit

/// Artifacts（规范 Docs）：文字、skill 和页面，组织层和看得到的空间里的。是主界面里的一个地方，画在会话卡片上（窗框 `canvas`），
/// 从切换 sheet 的「Artifacts」一行进。卡片里自己带一个不显示导航栏的导航：列表和正文页左右推，正文页左上角画返回，侧滑也能回。
/// 照网页的 Docs.tsx。
final class DocsNavigationController: UINavigationController, UIGestureRecognizerDelegate {
    convenience init(identity: Identity) {
        self.init(rootViewController: DocsViewController(identity: identity))
        setNavigationBarHidden(true, animated: false)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }

    /// 从切换 sheet 再点一次 Artifacts：回到列表，重新拉一遍。
    func reload() {
        popToRootViewController(animated: false)
        (viewControllers.first as? DocsViewController)?.load()
    }
}

/// 返回和删除：`control-sm` 36 的圆，`surface-inset` 底（规范 Docs「正文页」）。
private func roundButton(_ image: String, ink: UIColor = Theme.ink, label: String, action: @escaping () -> Void) -> UIButton {
    let button = UIButton.round(image: image, foreground: ink, label: label)
    button.addAction(UIAction { _ in action() }, for: .primaryActionTriggered)
    return button
}

/// 列表（规范 Docs「列表」）：右上角「上传」，下面每个地方一组，组织在前；没有资料的地方不出组。
/// 第一次打开先画骨架；打不开在列表的位置写原因。
final class DocsViewController: UIViewController, UICollectionViewDelegate {
    nonisolated private enum Section: Hashable, Sendable {
        case top
        case place(String?)
        case state
    }

    nonisolated private enum Row: Hashable, Sendable {
        case upload
        case doc(DocMeta)
        case skeleton
        case empty
        case failure(String)
    }

    private let identity: Identity
    private var docs: DocsView?
    private var failure: String?
    private var collection: UICollectionView!
    private var source: UICollectionViewDiffableDataSource<Section, Row>!

    init(identity: Identity) {
        self.identity = identity
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.surface
        collection = UICollectionView(frame: .zero, collectionViewLayout: makeLayout())
        collection.backgroundColor = .clear
        collection.delegate = self
        collection.contentInset.bottom = Theme.Space.s6
        collection.refreshControl = UIRefreshControl(frame: .zero, primaryAction: UIAction { [weak self] _ in self?.load() })
        view.addSubview(collection)
        collection.pin(to: view)

        let upload = UICollectionView.CellRegistration<UICollectionViewListCell, Row> { [weak self] cell, _, _ in
            cell.contentConfiguration = nil
            cell.backgroundConfiguration = .clear()
            let button = UIButton.secondary(title: "上传", image: "plus")
            button.configuration?.imagePadding = 6
            button.configuration?.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
            button.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s4, bottom: 0, trailing: Theme.Space.s4)
            button.addAction(UIAction { _ in self?.upload() }, for: .primaryActionTriggered)
            button.isEnabled = self?.docs != nil
            button.translatesAutoresizingMaskIntoConstraints = false
            cell.contentView.subviews.forEach { $0.removeFromSuperview() }
            cell.contentView.addSubview(button)
            NSLayoutConstraint.activate([
                button.topAnchor.constraint(equalTo: cell.contentView.topAnchor),
                button.bottomAnchor.constraint(equalTo: cell.contentView.bottomAnchor),
                button.trailingAnchor.constraint(equalTo: cell.contentView.trailingAnchor),
                button.heightAnchor.constraint(equalToConstant: Theme.Size.control)
            ])
        }
        let doc = UICollectionView.CellRegistration<DocRowCell, Row> { cell, _, row in
            guard case .doc(let meta) = row else { return }
            cell.show(meta)
        }
        let skeleton = UICollectionView.CellRegistration<UICollectionViewListCell, Row> { cell, _, _ in
            cell.contentConfiguration = nil
            cell.backgroundConfiguration = .clear()
            cell.contentView.subviews.forEach { $0.removeFromSuperview() }
            let view = ListSkeletonView(icons: true)
            cell.contentView.addSubview(view)
            view.pin(to: cell.contentView, insets: UIEdgeInsets(top: Theme.Space.s4, left: 0, bottom: 0, right: 0))
        }
        let message = UICollectionView.CellRegistration<UICollectionViewListCell, Row> { cell, _, row in
            cell.backgroundConfiguration = .clear()
            var content = UIListContentConfiguration.cell()
            content.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s1, bottom: 0, trailing: Theme.Space.s1)
            switch row {
            case .failure(let text):
                content.text = text
                content.textProperties.font = Theme.font(.subheadline)
                content.textProperties.color = Theme.dangerInk
            default:
                // 规范 Docs「空状态」：居中「还没有 Artifacts」（`message`，`ink`），下面一行 `subheadline`、`ink-muted`。
                content.text = "还没有 Artifacts"
                content.textProperties.font = Theme.font(.message)
                content.textProperties.color = Theme.ink
                content.textProperties.alignment = .center
                content.secondaryText = "组织和你看得到的空间里的文字、skill 和页面会列在这里。让 Pupu 在聊天里记下来，或者点「上传」放一份文字或一页 HTML。"
                content.secondaryTextProperties.font = Theme.font(.subheadline)
                content.secondaryTextProperties.color = Theme.inkMuted
                content.secondaryTextProperties.alignment = .center
                content.textToSecondaryTextVerticalPadding = Theme.Space.s2
                content.directionalLayoutMargins.top = 48
            }
            content.textProperties.numberOfLines = 0
            cell.contentConfiguration = content
        }
        let header = UICollectionView.SupplementaryRegistration<DocsHeaderView>(elementKind: UICollectionView.elementKindSectionHeader) { [weak self] view, _, path in
            guard case .place(let id) = self?.source.sectionIdentifier(for: path.section),
                  let place = self?.docs?.places.first(where: { $0.id == id }) else { return }
            view.show(place)
        }
        source = UICollectionViewDiffableDataSource(collectionView: collection) { view, path, row in
            switch row {
            case .upload: view.dequeueConfiguredReusableCell(using: upload, for: path, item: row)
            case .doc: view.dequeueConfiguredReusableCell(using: doc, for: path, item: row)
            case .skeleton: view.dequeueConfiguredReusableCell(using: skeleton, for: path, item: row)
            case .empty, .failure: view.dequeueConfiguredReusableCell(using: message, for: path, item: row)
            }
        }
        source.supplementaryViewProvider = { view, _, path in
            view.dequeueConfiguredReusableSupplementary(using: header, for: path)
        }
        render()
        load()
    }

    /// 规范 Docs「列表」：卡片里左右 16；组之间 20，组标题和组隔 4。
    private func makeLayout() -> UICollectionViewLayout {
        UICollectionViewCompositionalLayout { [weak self] index, environment in
            let section = self?.source?.sectionIdentifier(for: index)
            let grouped: Bool = if case .place = section { true } else { false }
            var config = UICollectionLayoutListConfiguration(appearance: grouped ? .insetGrouped : .plain)
            config.backgroundColor = .clear
            config.showsSeparators = grouped
            config.separatorConfiguration.color = Theme.line
            config.headerMode = grouped ? .supplementary : .none
            // 组之间的 20 放在组标题上面；section 的 contentInsets.top 会落在标题和组之间，那里只要标题自带的 4。
            let gap = index == 0 ? Theme.Space.s1 : Theme.Space.s5
            config.headerTopPadding = gap
            let layout = NSCollectionLayoutSection.list(using: config, layoutEnvironment: environment)
            layout.contentInsets = NSDirectionalEdgeInsets(
                top: grouped ? 0 : gap,
                leading: Theme.Space.s4,
                bottom: 0,
                trailing: Theme.Space.s4
            )
            layout.contentInsetsReference = .none
            return layout
        }
    }

    func load() {
        Task { [weak self, identity] in
            do {
                let next = try await API(endpoint: identity.endpoint).docs()
                self?.docs = next
                self?.failure = nil
            } catch {
                self?.failure = error.localizedDescription
            }
            self?.collection.refreshControl?.endRefreshing()
            self?.render()
        }
    }

    private func render() {
        var snapshot = NSDiffableDataSourceSnapshot<Section, Row>()
        snapshot.appendSections([.top])
        snapshot.appendItems([.upload], toSection: .top)
        if let docs {
            let groups = docs.places
                .map { place in (place, docs.docs.filter { $0.spaceId == place.id }) }
                .filter { !$0.1.isEmpty }
            if groups.isEmpty {
                snapshot.appendSections([.state])
                snapshot.appendItems([.empty], toSection: .state)
            }
            for (place, rows) in groups {
                snapshot.appendSections([.place(place.id)])
                snapshot.appendItems(rows.map(Row.doc), toSection: .place(place.id))
            }
        } else {
            snapshot.appendSections([.state])
            snapshot.appendItems([failure.map(Row.failure) ?? .skeleton], toSection: .state)
        }
        // 「上传」拿到地方列表才能点：重配一次那一格。
        snapshot.reconfigureItems([.upload])
        source.apply(snapshot, animatingDifferences: false)
    }

    func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
        if case .doc = source.itemIdentifier(for: indexPath) { return true }
        return false
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: true)
        guard case .doc(let meta) = source.itemIdentifier(for: indexPath) else { return }
        open(meta)
    }

    private func open(_ meta: DocMeta) {
        navigationController?.pushViewController(
            DocPageViewController(identity: identity, id: meta.id) { [weak self] in
                guard let self else { return }
                self.navigationController?.popToViewController(self, animated: true)
                self.load()
            },
            animated: true
        )
    }

    private func upload() {
        guard let places = docs?.places else { return }
        let form = UploadDocViewController(identity: identity, places: places) { [weak self] meta in
            self?.load()
            self?.open(meta)
        }
        let navigation = SheetNavigationController(rootViewController: form)
        if let sheet = navigation.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = Theme.Radius.sheetTop
        }
        present(navigation, animated: true)
    }
}

/// 一组的标题（规范 Docs「组标题」）：空间是 SpaceMark 20 加名字，组织层是 `building.2` 线条图标（20，`ink-muted`）；
/// 名字 `footnote`、`ink-muted`，和图标隔 8，左边让出 4。
private final class DocsHeaderView: UICollectionReusableView {
    private let mark = SpaceMarkView()
    private let building = UIImageView(image: UIImage(systemName: "building.2", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14)))
    private let name = UILabel(style: .footnote, color: Theme.inkMuted)

    override init(frame: CGRect) {
        super.init(frame: frame)
        building.tintColor = Theme.inkMuted
        building.contentMode = .center
        building.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            building.widthAnchor.constraint(equalToConstant: Theme.Size.mark),
            building.heightAnchor.constraint(equalToConstant: Theme.Size.mark)
        ])
        name.lineBreakMode = .byTruncatingTail
        let row = UIStackView(arrangedSubviews: [mark, building, name])
        row.spacing = Theme.Space.s2
        row.alignment = .center
        addSubview(row)
        row.pin(to: self, insets: UIEdgeInsets(top: 0, left: Theme.Space.s1, bottom: Theme.Space.s1, right: Theme.Space.s1))
        isAccessibilityElement = true
        accessibilityTraits = .header
    }

    required init?(coder: NSCoder) { fatalError() }

    func show(_ place: DocsView.Place) {
        let org = place.id == nil
        mark.isHidden = org
        building.isHidden = !org
        if !org { mark.show(color: place.color, icon: place.icon, name: place.name) }
        name.text = place.name
        accessibilityLabel = place.name
    }
}

/// 一行资料（规范 Docs「行」）：`doc.text` 18（`ink-muted`，页面是 `<>`），标题 `body` 500 一行截断，skill 在标题后跟「skill」小胶囊；
/// 有说明时第二行 `subheadline`、`ink-muted`。行高 52 起，上下 10、左右 16，图标和字隔 12，分隔线从字的左边画。
private final class DocRowCell: UICollectionViewListCell {
    private let icon = UIImageView()
    private let title = UILabel(style: .body)
    private let skill = PaddedLabel(text: "skill")
    private let summary = UILabel(style: .subheadline, color: Theme.inkMuted)
    private let text = UIStackView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        icon.tintColor = Theme.inkMuted
        icon.contentMode = .center
        icon.translatesAutoresizingMaskIntoConstraints = false
        title.font = Theme.font(.body, weight: .medium)
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        summary.lineBreakMode = .byTruncatingTail
        let line = UIStackView(arrangedSubviews: [title, skill, UIView()])
        line.spacing = Theme.Space.s2
        line.alignment = .center
        text.addArrangedSubview(line)
        text.addArrangedSubview(summary)
        text.axis = .vertical
        text.spacing = Theme.Space.s0_5
        let row = UIStackView(arrangedSubviews: [icon, text])
        row.spacing = Theme.Space.s3
        row.alignment = .center
        row.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(row)
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 18),
            row.topAnchor.constraint(equalTo: contentView.topAnchor, constant: Theme.Space.s2_5),
            row.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -Theme.Space.s2_5),
            row.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: Theme.Space.s4),
            row.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -Theme.Space.s4),
            contentView.heightAnchor.constraint(greaterThanOrEqualToConstant: 52),
            separatorLayoutGuide.leadingAnchor.constraint(equalTo: text.leadingAnchor)
        ])
        configurationUpdateHandler = { cell, state in
            var background = UIBackgroundConfiguration.listCell()
            background.backgroundColor = state.isHighlighted || state.isSelected ? Theme.line : Theme.surfaceInset
            cell.backgroundConfiguration = background
        }
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { fatalError() }

    func show(_ meta: DocMeta) {
        icon.image = UIImage(
            systemName: meta.isPage ? "chevron.left.forwardslash.chevron.right" : "doc.text",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: meta.isPage ? 13 : 16)
        )
        title.text = meta.title
        skill.isHidden = !meta.isSkill
        summary.text = meta.summary
        summary.isHidden = meta.summary.isEmpty
        accessibilityLabel = meta.isSkill ? "\(meta.title)，skill" : meta.isPage ? "\(meta.title)，页面" : meta.title
        accessibilityValue = meta.summary.isEmpty ? nil : meta.summary
    }
}

/// 「skill」小胶囊：`caption`，`surface` 底，`ink-muted`，左右 8。
private final class PaddedLabel: UILabel {
    convenience init(text: String) {
        self.init(frame: .zero)
        self.text = text
        font = Theme.font(.caption)
        textColor = Theme.inkMuted
        backgroundColor = Theme.surface
        clipsToBounds = true
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
    }

    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + Theme.Space.s2 * 2, height: size.height + Theme.Space.s0_5 * 2)
    }

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.insetBy(dx: Theme.Space.s2, dy: 0))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
    }
}

/// 正文页（规范 Docs「正文页」）：左上返回，上传的人和空间主人右边有删除，点了先问一句再删；下面隔 12 是标题（`title`）、
/// 说明（`subheadline`、`ink-muted`）、正文，彼此隔 8。正文是 Markdown，直接写在卡片上。
/// 页面（一页 HTML）占满卡片，标题（`headline`）写在返回键旁边。
final class DocPageViewController: UIViewController {
    private let identity: Identity
    private let id: String
    private let onDeleted: () -> Void
    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private let bar = UIStackView()
    private let pageTitle = UILabel(style: .headline)
    private let failure = UILabel(style: .subheadline, color: Theme.dangerInk, lines: 0)
    private var delete: UIButton?
    /// 删除确认框的标题要用。
    private var docTitle = ""

    init(identity: Identity, id: String, onDeleted: @escaping () -> Void) {
        self.identity = identity
        self.id = id
        self.onDeleted = onDeleted
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.surface
        let back = roundButton("chevron.left", label: "回到 Artifacts") { [weak self] in
            self?.navigationController?.popViewController(animated: true)
        }
        pageTitle.isHidden = true
        pageTitle.lineBreakMode = .byTruncatingTail
        pageTitle.accessibilityTraits = .header
        bar.addArrangedSubview(back)
        bar.addArrangedSubview(pageTitle)
        bar.addArrangedSubview(UIView())
        bar.spacing = Theme.Space.s3
        bar.alignment = .center
        failure.isHidden = true

        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        scroll.pin(to: view)
        let column = UIStackView(arrangedSubviews: [bar, failure, stack])
        column.axis = .vertical
        column.spacing = Theme.Space.s3
        column.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: Theme.Space.s1),
            column.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -Theme.Space.s6),
            column.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: Theme.Space.s4),
            column.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -Theme.Space.s4)
        ])
        stack.axis = .vertical
        stack.spacing = Theme.Space.s2
        stack.addArrangedSubview(PageSkeletonView())
        Task { [weak self, identity, id] in
            do {
                let doc = try await API(endpoint: identity.endpoint).doc(id)
                self?.show(doc)
            } catch {
                self?.showMissing()
            }
        }
    }

    private func show(_ doc: DocView) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        docTitle = doc.title
        if doc.mayDelete == true {
            let delete = roundButton("trash", ink: Theme.dangerInk, label: "删除") { [weak self] in self?.confirmRemove() }
            bar.addArrangedSubview(delete)
            self.delete = delete
        }
        if doc.kind == "page" {
            showPage(doc)
            return
        }
        let heading = UILabel(text: doc.title, style: .title, lines: 0)
        heading.accessibilityTraits = .header
        stack.addArrangedSubview(heading)
        if !doc.summary.isEmpty {
            stack.addArrangedSubview(UILabel(text: doc.summary, style: .subheadline, color: Theme.inkMuted, lines: 0))
        }
        let body = UIStackView()
        body.axis = .vertical
        body.spacing = Theme.Space.s3
        for segment in Markdown.segments(doc.body) {
            switch segment {
            case .text(let attributed):
                let label = LinkLabel()
                label.attributedText = attributed
                label.onLink = { url in UIApplication.shared.open(url) }
                body.addArrangedSubview(label)
            case .code(let code):
                let block = CodeScrollView()
                block.text = code
                body.addArrangedSubview(block)
            }
        }
        stack.addArrangedSubview(body)
    }

    /// 页面占满卡片：白底的沙箱，`radius-row` 圆角，外面一圈 1pt `line`。
    private func showPage(_ doc: DocView) {
        pageTitle.text = doc.title
        pageTitle.isHidden = false
        scroll.alwaysBounceVertical = false
        scroll.isScrollEnabled = false
        let page = PageView(html: doc.body)
        page.layer.cornerRadius = Theme.Radius.row
        page.layer.cornerCurve = .continuous
        page.layer.borderWidth = 1
        page.layer.borderColor = Theme.line.resolvedColor(with: traitCollection).cgColor
        page.clipsToBounds = true
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _: UITraitCollection) in
            page.layer.borderColor = Theme.line.resolvedColor(with: self.traitCollection).cgColor
        }
        view.addSubview(page)
        page.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            page.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: Theme.Space.s3),
            page.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -Theme.Space.s4),
            page.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Theme.Space.s4),
            page.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Theme.Space.s4)
        ])
    }

    private func showMissing() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        stack.addArrangedSubview(UILabel(text: "没有这一份", style: .message, lines: 0))
    }

    /// 删之前先问一句（规范 Docs「删除」）：系统确认框，「删掉」是破坏性的。
    private func confirmRemove() {
        guard let delete, delete.isEnabled else { return }
        let alert = UIAlertController(title: "删掉「\(docTitle)」？", message: "组织里的人都看不到了，删了找不回来。", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "删掉", style: .destructive) { [weak self] _ in self?.remove() })
        present(alert, animated: true)
    }

    private func remove() {
        guard let delete, delete.isEnabled else { return }
        delete.isEnabled = false
        delete.configuration?.showsActivityIndicator = true
        failure.isHidden = true
        Task { [weak self, identity, id] in
            do {
                try await API(endpoint: identity.endpoint).deleteDoc(id)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                self?.onDeleted()
            } catch {
                delete.isEnabled = true
                delete.configuration?.showsActivityIndicator = false
                self?.failure.text = error.localizedDescription
                self?.failure.isHidden = false
            }
        }
    }
}

/// 上传（规范 Docs「上传」）：标题、一句说明、正文，「选文件」和「放在哪」，是不是做事的方法（skill），最下面「取消」「上传」并排等宽。
/// 规范画的是居中弹窗；手机上要打字，放进整页 sheet，里面的排法照弹窗。正文认出是一整页 HTML 就存成页面，skill 开关换成一句话。
final class UploadDocViewController: UIViewController, UIDocumentPickerDelegate {
    private let identity: Identity
    private let places: [DocsView.Place]
    private let onDone: (DocMeta) -> Void
    private let titleField = FieldView()
    private let summaryField = FieldView()
    private let body = UITextView()
    private let bodyHint = UILabel(text: "贴进正文，或者一整页 HTML", style: .body, color: Theme.inkMuted)
    private let placeButton = UIButton(configuration: .filled())
    private let skill = SwitchView()
    private let skillRow = UIStackView()
    private let pageNote = UILabel(text: "是一页 HTML，存成页面", style: .subheadline, color: Theme.inkMuted)
    private let failure = UILabel(style: .subheadline, color: Theme.dangerInk, lines: 0)
    private let save = UIButton.action(title: "上传")
    private var place: String?
    private var busy = false
    /// 同一次上传点两下、网络重试，云端按它去重。
    private let operation = UUID().uuidString

    init(identity: Identity, places: [DocsView.Place], onDone: @escaping (DocMeta) -> Void) {
        self.identity = identity
        self.places = places
        self.onDone = onDone
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "上传"
        view.backgroundColor = Theme.surfaceSheet

        for (field, placeholder) in [(titleField, "标题"), (summaryField, "一句说明（选填）")] {
            field.placeholder = placeholder
            field.accessibilityLabel = placeholder
            field.addAction(UIAction { [weak self] _ in self?.validate() }, for: .editingChanged)
        }
        titleField.returnKeyType = .next
        summaryField.returnKeyType = .next

        // 正文：和输入框一样的 `surface-inset` 底、`radius-field`，8 行高。
        body.font = Theme.font(.body)
        body.textColor = Theme.ink
        body.backgroundColor = Theme.surfaceInset
        body.layer.cornerRadius = Theme.Radius.field
        body.layer.cornerCurve = .continuous
        body.accessibilityLabel = "正文"
        body.textContainerInset = UIEdgeInsets(top: Theme.Space.s2_5, left: Theme.Space.s3, bottom: Theme.Space.s2_5, right: Theme.Space.s3)
        body.textContainer.lineFragmentPadding = 0
        body.delegate = self
        body.heightAnchor.constraint(equalToConstant: 8 * (Theme.font(.body).lineHeight) + Theme.Space.s2_5 * 2).isActive = true
        bodyHint.isAccessibilityElement = false
        bodyHint.translatesAutoresizingMaskIntoConstraints = false
        body.addSubview(bodyHint)
        NSLayoutConstraint.activate([
            bodyHint.topAnchor.constraint(equalTo: body.topAnchor, constant: Theme.Space.s2_5),
            bodyHint.leadingAnchor.constraint(equalTo: body.leadingAnchor, constant: Theme.Space.s3)
        ])

        // 「选文件」「放在哪」：`surface-inset` 胶囊，高 32，`subheadline`。
        let pick = pill(title: "选文件")
        pick.addAction(UIAction { [weak self] _ in self?.pickFile() }, for: .primaryActionTriggered)
        placeButton.configuration = pillConfiguration(title: places.first?.name ?? "组织")
        placeButton.configuration?.image = UIImage(systemName: "chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold))
        placeButton.configuration?.imagePlacement = .trailing
        placeButton.configuration?.imagePadding = 6
        placeButton.configuration?.imageColorTransformer = UIConfigurationColorTransformer { _ in Theme.inkMuted }
        // changesSelectionAsPrimaryAction 会自己在后面加一个上下箭头，和上面的 chevron.down 重复；只留一个，和网页一样。
        placeButton.configuration?.indicator = .none
        placeButton.heightAnchor.constraint(equalToConstant: 32).isActive = true
        placeButton.showsMenuAsPrimaryAction = true
        placeButton.changesSelectionAsPrimaryAction = true
        placeButton.menu = UIMenu(options: .singleSelection, children: places.map { item in
            UIAction(title: item.name, state: item.id == nil ? .on : .off) { [weak self] _ in self?.place = item.id }
        })
        placeButton.accessibilityLabel = "放在哪"
        let files = UIStackView(arrangedSubviews: [pick, UIView(), placeButton])
        files.alignment = .center

        let skillLabel = UILabel(text: "是做事的方法（skill）", style: .body, lines: 0)
        skill.addAction(UIAction { [weak self] _ in self?.updateKind() }, for: .valueChanged)
        skillRow.addArrangedSubview(skillLabel)
        skillRow.addArrangedSubview(skill)
        skillRow.alignment = .center
        skillRow.spacing = Theme.Space.s3
        skillRow.isLayoutMarginsRelativeArrangement = true
        skillRow.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s1, bottom: 0, trailing: Theme.Space.s1)
        pageNote.isHidden = true
        failure.isHidden = true

        let cancel = UIButton.secondary(title: "取消")
        cancel.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .primaryActionTriggered)
        save.addAction(UIAction { [weak self] _ in self?.upload() }, for: .primaryActionTriggered)
        let buttons = UIStackView(arrangedSubviews: [cancel, save])
        buttons.spacing = Theme.Space.s2
        buttons.distribution = .fillEqually
        buttons.heightAnchor.constraint(equalToConstant: Theme.Size.control).isActive = true

        let stack = UIStackView(arrangedSubviews: [titleField, summaryField, body, files, skillRow, pageNote, failure, buttons])
        stack.axis = .vertical
        stack.spacing = Theme.Space.s3
        stack.setCustomSpacing(Theme.Space.s4, after: failure)
        let scroll = UIScrollView()
        scroll.keyboardDismissMode = .interactive
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        scroll.pin(to: view)
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: Theme.Space.s3),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -Theme.Space.s6),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: Theme.Space.s4),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -Theme.Space.s4)
        ])
        validate()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        titleField.becomeFirstResponder()
    }

    private func pillConfiguration(title: String) -> UIButton.Configuration {
        var config = UIButton.Configuration.filled()
        config.title = title
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s3, bottom: 0, trailing: Theme.Space.s3)
        config.paint(fill: Theme.surfaceInset, ink: Theme.ink, style: .subheadline)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.subheadline)
            attributes.foregroundColor = Theme.ink
            return attributes
        }
        return config
    }

    private func pill(title: String) -> UIButton {
        let button = UIButton(configuration: pillConfiguration(title: title))
        button.heightAnchor.constraint(equalToConstant: 32).isActive = true
        return button
    }

    /// 一整页 HTML 存成页面：skill 开关换成一句话，说明的占位跟着换。
    private func updateKind() {
        let page = PageView.looksLikePage(body.text)
        skillRow.isHidden = page
        pageNote.isHidden = !page
        summaryField.placeholder = skill.isOn && !page ? "什么时候用它" : "一句说明（选填）"
    }

    private func validate() {
        let ready = !(titleField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !body.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        save.isEnabled = ready && !busy
    }

    /// 「选文件」：只收 .md、.markdown、.txt、.html，读进正文；标题空着时填文件名（去掉扩展名）。
    private func pickFile() {
        let types = ["md", "markdown", "txt", "html", "htm"].compactMap { UTType(filenameExtension: $0) } + [.plainText, .html]
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return }
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            failure.text = "这个文件读不出来，要是 UTF-8 的文字。"
            failure.isHidden = false
            return
        }
        body.text = text
        bodyHint.isHidden = !text.isEmpty
        if (titleField.text ?? "").trimmingCharacters(in: .whitespaces).isEmpty {
            titleField.text = url.deletingPathExtension().lastPathComponent
        }
        failure.isHidden = true
        updateKind()
        validate()
    }

    private func upload() {
        guard !busy else { return }
        busy = true
        save.configuration?.showsActivityIndicator = true
        validate()
        failure.isHidden = true
        let title = (titleField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let summary = (summaryField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let text = body.text ?? ""
        let kind = PageView.looksLikePage(text) ? "page" : skill.isOn ? "skill" : "doc"
        Task { [weak self, identity, operation, place] in
            do {
                let meta = try await API(endpoint: identity.endpoint).uploadDoc(
                    title: title, summary: summary, body: text, kind: kind, spaceId: place, operation: operation
                )
                self?.dismiss(animated: true) { self?.onDone(meta) }
            } catch {
                self?.busy = false
                self?.save.configuration?.showsActivityIndicator = false
                self?.failure.text = error.localizedDescription
                self?.failure.isHidden = false
                self?.validate()
            }
        }
    }
}

extension UploadDocViewController: UITextViewDelegate {
    func textViewDidChange(_ textView: UITextView) {
        bodyHint.isHidden = !textView.text.isEmpty
        updateKind()
        validate()
    }
}

/// 一页 HTML（Artifacts 里的页面）。和 App 隔开：不存东西的数据仓、没有 baseURL（不透明源）、不挂任何脚本接口，
/// App 的凭据在请求头里，页面拿不到。页面里点链接交给 Safari，自己只显示这一页。和网页的 PAGE_SANDBOX 是一个意思。
final class PageView: UIView, WKNavigationDelegate, WKUIDelegate {
    private let web: WKWebView

    init(html: String) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        web = WKWebView(frame: .zero, configuration: configuration)
        super.init(frame: .zero)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = .white
        backgroundColor = .white
        addSubview(web)
        web.pin(to: self)
        web.loadHTMLString(Self.withViewport(html), baseURL: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// 没写 viewport 的页面补一个设备宽的：WKWebView 不像网页里的 iframe，没有它就按 980 宽缩小显示，字很小。
    /// 补在 `<head>` 后面，没有就在 `<html>` 或 doctype 后面：放到 doctype 前面页面会掉进怪异模式。
    static func withViewport(_ html: String) -> String {
        let options: String.CompareOptions = [.regularExpression, .caseInsensitive]
        if html.range(of: #"<meta\b[^>]*\bname\s*=\s*["']?viewport["'\s/>]"#, options: options) != nil { return html }
        let meta = #"<meta name="viewport" content="width=device-width, initial-scale=1">"#
        for tag in [#"<head\b[^>]*>"#, #"<html\b[^>]*>"#, #"<!doctype\b[^>]*>"#] {
            if let range = html.range(of: tag, options: options) {
                var page = html
                page.insert(contentsOf: meta, at: range.upperBound)
                return page
            }
        }
        return meta + html
    }

    /// 和云端 docs.ts 的 looksLikePage 一样：以 <!doctype html> 或 <html 开头。
    static func looksLikePage(_ text: String) -> Bool {
        text.range(of: #"^\s*(<!--[\s\S]*?-->\s*)*<(!doctype\s+html|html[\s>])"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        // 只放行这一页自己（about:blank 和页内锚点）和页面里的 iframe。主框架要换成别的地址一律不让：
        // 人点的链接交给 Safari，脚本自己跳的直接丢掉，免得页面一载入就把人带走。
        if action.targetFrame?.isMainFrame == false || action.request.url?.scheme == "about" {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        if action.navigationType == .linkActivated { open(action.request.url) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // target=_blank 的链接也走这里；只认人点的。
        if action.navigationType == .linkActivated { open(action.request.url) }
        return nil
    }

    private func open(_ url: URL?) {
        guard let url, url.scheme == "https" || url.scheme == "http" || url.scheme == "mailto" else { return }
        UIApplication.shared.open(url)
    }
}
