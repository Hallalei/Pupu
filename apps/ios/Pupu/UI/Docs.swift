import UIKit
import WebKit

/// Artifacts：资料、skill 和页面，组织层和看得到的空间里的，按地方分组。点开读正文，页面放进隔开的 WKWebView；
/// 右上角上传文字或一页 HTML。照网页的 Docs.tsx。
final class DocsViewController: UITableViewController {
    private let identity: Identity
    private var view_: DocsView?
    private var groups: [(place: DocsView.Place, docs: [DocMeta])] = []
    private let empty = UILabel(text: "还没有 Artifacts", style: .body, color: Theme.inkMuted)
    private let spinner = UIActivityIndicatorView(style: .medium)

    init(identity: Identity) {
        self.identity = identity
        super.init(style: .insetGrouped)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Artifacts"
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "doc")
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "上传", image: UIImage(systemName: "plus"),
            primaryAction: UIAction { [weak self] _ in self?.upload() }
        )
        navigationItem.rightBarButtonItem?.isEnabled = false
        empty.textAlignment = .center
        spinner.startAnimating()
        tableView.backgroundView = spinner
        refreshControl = UIRefreshControl(frame: .zero, primaryAction: UIAction { [weak self] _ in self?.load() })
        load()
    }

    func load() {
        Task { [weak self, identity] in
            do {
                let next = try await API(endpoint: identity.endpoint).docs()
                self?.show(next)
            } catch {
                self?.refreshControl?.endRefreshing()
                self?.empty.text = error.localizedDescription
                self?.tableView.backgroundView = self?.empty
            }
        }
    }

    private func show(_ next: DocsView) {
        view_ = next
        groups = next.places
            .map { place in (place, next.docs.filter { $0.spaceId == place.id }) }
            .filter { !$0.1.isEmpty }
        refreshControl?.endRefreshing()
        empty.text = "还没有 Artifacts"
        tableView.backgroundView = groups.isEmpty ? empty : nil
        navigationItem.rightBarButtonItem?.isEnabled = true
        tableView.reloadData()
    }

    override func numberOfSections(in tableView: UITableView) -> Int { groups.count }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        groups[section].docs.count
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        groups[section].place.name
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let doc = groups[indexPath.section].docs[indexPath.row]
        let cell = tableView.dequeueReusableCell(withIdentifier: "doc", for: indexPath)
        var content = UIListContentConfiguration.subtitleCell()
        content.image = UIImage(systemName: doc.isSkill ? "wand.and.stars" : doc.isPage ? "chevron.left.forwardslash.chevron.right" : "doc.text")
        content.imageProperties.tintColor = Theme.inkMuted
        content.text = doc.title
        content.textProperties.font = Theme.font(.body, weight: .medium)
        content.textProperties.numberOfLines = 1
        content.secondaryText = doc.summary.isEmpty ? nil : doc.summary
        content.secondaryTextProperties.font = Theme.font(.subheadline)
        content.secondaryTextProperties.color = Theme.inkMuted
        content.secondaryTextProperties.numberOfLines = 1
        cell.contentConfiguration = content
        cell.accessoryType = .disclosureIndicator
        cell.accessibilityLabel = doc.isSkill ? "\(doc.title)，skill" : doc.isPage ? "\(doc.title)，页面" : doc.title
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let doc = groups[indexPath.section].docs[indexPath.row]
        navigationController?.pushViewController(
            DocPageViewController(identity: identity, id: doc.id, title: doc.title) { [weak self] in
                self?.navigationController?.popToViewController(self!, animated: true)
                self?.load()
            },
            animated: true
        )
    }

    private func upload() {
        guard let places = view_?.places else { return }
        let form = UploadDocViewController(identity: identity, places: places) { [weak self] meta in
            guard let self else { return }
            self.load()
            self.navigationController?.pushViewController(
                DocPageViewController(identity: self.identity, id: meta.id, title: meta.title) { [weak self] in
                    guard let self else { return }
                    self.navigationController?.popToViewController(self, animated: true)
                    self.load()
                },
                animated: true
            )
        }
        present(UINavigationController(rootViewController: form), animated: true)
    }
}

/// 读一份资料。上传的人和空间主人右上角有删除，点了就删，不再问。
final class DocPageViewController: UIViewController {
    private let identity: Identity
    private let id: String
    private let onDeleted: () -> Void
    private let stack = UIStackView()
    private let spinner = UIActivityIndicatorView(style: .medium)

    init(identity: Identity, id: String, title: String, onDeleted: @escaping () -> Void) {
        self.identity = identity
        self.id = id
        self.onDeleted = onDeleted
        super.init(nibName: nil, bundle: nil)
        // 标题在正文顶上大字写着，导航栏不再重复；返回按钮的提示用它。
        navigationItem.backButtonTitle = title
        navigationItem.largeTitleDisplayMode = .never
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.surfaceSheet
        let scroll = UIScrollView()
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        scroll.pin(to: view)
        stack.axis = .vertical
        stack.spacing = Theme.Space.s3
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: Theme.Space.s4),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -Theme.Space.s6),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: Theme.Space.s5),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -Theme.Space.s5)
        ])
        spinner.startAnimating()
        stack.addArrangedSubview(spinner)
        Task { [weak self, identity, id] in
            do {
                let doc = try await API(endpoint: identity.endpoint).doc(id)
                self?.show(doc)
            } catch {
                self?.showError(error.localizedDescription)
            }
        }
    }

    private func show(_ doc: DocView) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if doc.mayDelete == true {
            let delete = UIBarButtonItem(
                title: "删除", image: UIImage(systemName: "trash"),
                primaryAction: UIAction { [weak self] _ in self?.delete() }
            )
            delete.tintColor = Theme.dangerInk
            navigationItem.rightBarButtonItem = delete
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
        stack.setCustomSpacing(Theme.Space.s4, after: stack.arrangedSubviews.last!)
        for segment in Markdown.segments(doc.body) {
            switch segment {
            case .text(let attributed):
                let label = LinkLabel()
                label.attributedText = attributed
                label.onLink = { url in UIApplication.shared.open(url) }
                stack.addArrangedSubview(label)
            case .code(let code):
                let block = CodeScrollView()
                block.text = code
                stack.addArrangedSubview(block)
            }
        }
    }

    /// 页面盖满这一屏，标题放导航栏。
    private func showPage(_ doc: DocView) {
        title = doc.title
        let page = PageView(html: doc.body)
        view.addSubview(page)
        page.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            page.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            page.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            page.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            page.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
    }

    private func showError(_ message: String) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        stack.addArrangedSubview(UILabel(text: message, style: .body, color: Theme.dangerInk, lines: 0))
    }

    private func delete() {
        navigationItem.rightBarButtonItem?.isEnabled = false
        Task { [weak self, identity, id] in
            do {
                try await API(endpoint: identity.endpoint).deleteDoc(id)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                self?.onDeleted()
            } catch {
                self?.navigationItem.rightBarButtonItem?.isEnabled = true
                let alert = UIAlertController(title: nil, message: error.localizedDescription, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "好", style: .default))
                self?.present(alert, animated: true)
            }
        }
    }
}

/// 上传文字资料：标题、一句说明、正文，放在哪，是不是做事的方法（skill）。
final class UploadDocViewController: UIViewController {
    private let identity: Identity
    private let places: [DocsView.Place]
    private let onDone: (DocMeta) -> Void
    private let titleField = UITextField()
    private let summaryField = UITextField()
    private let body = UITextView()
    private let bodyHint = UILabel(text: "贴进正文，或者一整页 HTML", style: .body, color: .placeholderText)
    private let placeButton = UIButton(type: .system)
    private let skill = UISwitch()
    private var place: String?
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
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "上传", primaryAction: UIAction { [weak self] _ in self?.save() })
        navigationItem.rightBarButtonItem?.style = .done

        for (field, placeholder) in [(titleField, "标题"), (summaryField, "一句说明（选填）")] {
            field.placeholder = placeholder
            field.font = Theme.font(.body)
            field.accessibilityLabel = placeholder
            field.addAction(UIAction { [weak self] _ in self?.validate() }, for: .editingChanged)
        }
        body.font = Theme.font(.body)
        body.backgroundColor = .clear
        body.accessibilityLabel = "正文"
        body.textContainerInset = .zero
        body.textContainer.lineFragmentPadding = 0
        body.delegate = self
        bodyHint.isAccessibilityElement = false
        bodyHint.translatesAutoresizingMaskIntoConstraints = false
        body.addSubview(bodyHint)
        NSLayoutConstraint.activate([
            bodyHint.topAnchor.constraint(equalTo: body.topAnchor),
            bodyHint.leadingAnchor.constraint(equalTo: body.leadingAnchor)
        ])

        var config = UIButton.Configuration.plain()
        config.baseForegroundColor = Theme.ink
        config.contentInsets = .zero
        placeButton.configuration = config
        placeButton.showsMenuAsPrimaryAction = true
        placeButton.changesSelectionAsPrimaryAction = true
        placeButton.menu = UIMenu(children: places.map { item in
            UIAction(title: item.name, state: item.id == nil ? .on : .off) { [weak self] _ in self?.place = item.id }
        })
        placeButton.accessibilityLabel = "放在哪"

        let fields = card([titleField, summaryField].map { row($0) })
        let bodyCard = card([row(body, height: 180)])
        let placeRow = row(UIStackView(arrangedSubviews: [UILabel(text: "放在哪", style: .body), UIView(), placeButton]))
        let skillRow = row(UIStackView(arrangedSubviews: [UILabel(text: "是做事的方法（skill）", style: .body), UIView(), skill]))
        skill.addAction(UIAction { [weak self] _ in
            self?.summaryField.placeholder = self?.skill.isOn == true ? "什么时候用它" : "一句说明（选填）"
        }, for: .valueChanged)
        let options = card([placeRow, skillRow])

        let stack = UIStackView(arrangedSubviews: [fields, bodyCard, options])
        stack.axis = .vertical
        stack.spacing = Theme.Space.s4
        let scroll = UIScrollView()
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)
        scroll.pin(to: view)
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: Theme.Space.s4),
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

    private func card(_ rows: [UIView]) -> UIView {
        let stack = UIStackView(arrangedSubviews: rows)
        stack.axis = .vertical
        let card = UIView()
        card.backgroundColor = Theme.surfaceInset
        card.layer.cornerRadius = Theme.Radius.row
        card.layer.cornerCurve = .continuous
        card.addSubview(stack)
        stack.pin(to: card)
        for (index, row) in rows.enumerated() where index > 0 {
            let line = UIView()
            line.backgroundColor = Theme.line
            line.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(line)
            NSLayoutConstraint.activate([
                line.topAnchor.constraint(equalTo: row.topAnchor),
                line.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: Theme.Space.s4),
                line.trailingAnchor.constraint(equalTo: row.trailingAnchor),
                line.heightAnchor.constraint(equalToConstant: 1)
            ])
        }
        return card
    }

    private func row(_ content: UIView, height: CGFloat = 52) -> UIView {
        let row = UIView()
        row.addSubview(content)
        content.pin(to: row, insets: UIEdgeInsets(top: height > 52 ? Theme.Space.s3 : 0, left: Theme.Space.s4, bottom: height > 52 ? Theme.Space.s3 : 0, right: Theme.Space.s4))
        row.heightAnchor.constraint(greaterThanOrEqualToConstant: height).isActive = true
        if let stack = content as? UIStackView { stack.alignment = .center }
        return row
    }

    private func validate() {
        let ready = !(titleField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !body.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        navigationItem.rightBarButtonItem?.isEnabled = ready
    }

    private func save() {
        navigationItem.rightBarButtonItem?.isEnabled = false
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
                self?.validate()
                let alert = UIAlertController(title: nil, message: error.localizedDescription, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "好", style: .default))
                self?.present(alert, animated: true)
            }
        }
    }
}

extension UploadDocViewController: UITextViewDelegate {
    func textViewDidChange(_ textView: UITextView) {
        bodyHint.isHidden = !textView.text.isEmpty
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
        web.loadHTMLString(html, baseURL: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

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
