import UIKit

/// 成员的头像图：云端给的是相对地址（预设是 `/avatars/<id>.png`，上传的是 `/api/members/<id>/avatar?v=…`），
/// 这里带上这台手机的凭据去拿，存在内存里。地址里带着换的时间，换了头像地址就变，不用管过期。
@MainActor
final class Avatars {
    static let shared = Avatars()
    /// 拿到一张新图。设置页这种用 `UIListContentConfiguration` 画图的地方收到后重画一遍。
    static let loaded = Notification.Name("PupuAvatarLoaded")

    private let cache = NSCache<NSString, UIImage>()
    private var loading: Set<String> = []

    /// 有就直接给；没有就去拿，拿到了发 `loaded`。
    func image(_ path: String?) -> UIImage? {
        guard let path, let endpoint = Connection.shared.endpoint else { return nil }
        let key = "\(endpoint.base.absoluteString)\t\(path)" as NSString
        if let image = cache.object(forKey: key) { return image }
        guard !loading.contains(key as String), let url = URL(string: path, relativeTo: endpoint.base) else { return nil }
        loading.insert(key as String)
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        endpoint.authorize(&request)
        Task {
            let data = try? await URLSession.shared.data(for: request)
            loading.remove(key as String)
            guard let (data, response) = data, (response as? HTTPURLResponse)?.statusCode == 200,
                  let image = UIImage(data: data) else { return }
            cache.setObject(image, forKey: key)
            NotificationCenter.default.post(name: Self.loaded, object: path)
        }
        return nil
    }

    /// 预设是像素画，放大要按格子来，不能糊。
    static func isPixelArt(_ path: String?) -> Bool {
        path?.hasPrefix("/avatars/") == true
    }

    /// Pupu 现在的头像：换过的拿到了用换过的，没换过（或者还在拿）用自带的。
    func pupu() -> (image: UIImage?, pixelArt: Bool) {
        let path = Store.shared.pupuAvatar
        if let image = image(path) { return (image, Self.isPixelArt(path)) }
        return (UIImage(named: "pupu-avatar"), true)
    }

    /// 圆形头像：有图画图（像素画最近邻缩放），没图画名字的第一个字（规范 Avatar「没有头像」：`surface-inset` 圆底，字 600 `ink`）。
    /// 首字头像的底色和字色是动态色：浅色、深色各画一张放进同一个 UIImageAsset，图片视图跟着主题自己换。
    static func round(_ image: UIImage?, letter: String, size: CGFloat, pixelArt: Bool, fill: UIColor = Theme.surfaceInset, ink: UIColor = Theme.ink) -> UIImage {
        let bounds = CGRect(x: 0, y: 0, width: size, height: size)
        let format = UIGraphicsImageRendererFormat.preferred()
        let renderer = UIGraphicsImageRenderer(size: bounds.size, format: format)
        if let image {
            return renderer.image { context in
                UIBezierPath(ovalIn: bounds).addClip()
                context.cgContext.interpolationQuality = pixelArt ? .none : .high
                image.draw(in: bounds)
            }
        }
        // 注册时带上屏幕倍数：只按深浅色注册，取回来的图会变成 1 倍，30 的头像就画成 90。
        let asset = UIImageAsset()
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection { traits in
                traits.userInterfaceStyle = style
                traits.displayScale = format.scale
            }
            let drawn = renderer.image { context in
                UIBezierPath(ovalIn: bounds).addClip()
                fill.resolvedColor(with: traits).setFill()
                context.fill(bounds)
                let attributes: [NSAttributedString.Key: Any] = [
                    .font: UIFont.systemFont(ofSize: size * 0.45, weight: .semibold),
                    .foregroundColor: ink.resolvedColor(with: traits)
                ]
                let text = letter as NSString
                let measured = text.size(withAttributes: attributes)
                text.draw(at: CGPoint(x: (size - measured.width) / 2, y: (size - measured.height) / 2), withAttributes: attributes)
            }
            asset.register(drawn, with: traits)
        }
        return asset.image(with: UITraitCollection.current)
    }

    /// 名字的第一个字，大写。
    static func letter(_ name: String) -> String {
        name.first.map { String($0).uppercased() } ?? "我"
    }
}

/// 换头像：上面是现在的样子，中间一格一格的预设，下面从相册选一张（系统自带的方形裁剪），或者换回默认的。
/// 自己的默认是名字的第一个字；Pupu 的（创建者才能换）默认是自带的那张。
final class AvatarPickerViewController: UIViewController, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    private let target: AvatarTarget
    private let preview = UIImageView()
    private let grid = UIStackView()
    private let actions = UIStackView()
    private var buttons: [(id: String, url: String, view: UIButton)] = []
    private var token: StoreToken?
    private var loadedToken: NSObjectProtocol?
    private var busy = false

    init(target: AvatarTarget = .me) {
        self.target = target
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = target == .pupu ? "Pupu 的头像" : "头像"
        view.backgroundColor = Theme.surfaceSheet

        let scroll = UIScrollView()
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        scroll.pin(to: view)

        preview.contentMode = .scaleAspectFill
        preview.clipsToBounds = true
        preview.layer.cornerRadius = 48
        preview.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            preview.widthAnchor.constraint(equalToConstant: 96),
            preview.heightAnchor.constraint(equalToConstant: 96)
        ])
        let previewRow = UIStackView(arrangedSubviews: [preview])
        previewRow.alignment = .center
        previewRow.axis = .vertical

        grid.axis = .vertical
        grid.spacing = Theme.Space.s3
        let gridCard = card(grid, insets: Theme.Space.s4)

        actions.axis = .vertical
        let actionsCard = card(actions, insets: 0)

        let column = UIStackView(arrangedSubviews: [previewRow, gridCard, actionsCard])
        column.axis = .vertical
        column.spacing = Theme.Space.s6
        column.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: Theme.Space.s4),
            column.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -Theme.Space.s6),
            column.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: Theme.Space.s4),
            column.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -Theme.Space.s4)
        ])

        token = Store.shared.observe { [weak self] in self?.render() }
        loadedToken = NotificationCenter.default.addObserver(forName: Avatars.loaded, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.render() }
        }
        buildGrid()
        render()
    }

    private func card(_ content: UIView, insets: CGFloat) -> UIView {
        let card = UIView()
        card.backgroundColor = Theme.surfaceInset
        card.layer.cornerRadius = Theme.Radius.row
        card.layer.cornerCurve = .continuous
        content.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(content)
        content.pin(to: card, insets: UIEdgeInsets(top: insets, left: insets, bottom: insets, right: insets))
        return card
    }

    /// 成员挑小人，Pupu 挑猫。
    private var presets: [AvatarPreset] {
        target == .pupu ? Store.shared.pupuAvatarPresets : Store.shared.avatarPresets
    }

    private func buildGrid() {
        grid.arrangedSubviews.forEach { $0.removeFromSuperview() }
        buttons = []
        let presets = self.presets
        for start in stride(from: 0, to: presets.count, by: 4) {
            let row = UIStackView()
            row.distribution = .fillEqually
            row.spacing = Theme.Space.s3
            for index in start..<start + 4 {
                guard index < presets.count else {
                    row.addArrangedSubview(UIView())
                    continue
                }
                let preset = presets[index]
                let button = UIButton(type: .custom)
                button.accessibilityLabel = preset.name
                button.imageView?.contentMode = .scaleAspectFit
                button.imageView?.layer.magnificationFilter = .nearest
                button.clipsToBounds = true
                button.heightAnchor.constraint(equalTo: button.widthAnchor).isActive = true
                button.addAction(UIAction { [weak self] _ in self?.choose(preset.id) }, for: .touchUpInside)
                row.addArrangedSubview(button)
                buttons.append((preset.id, preset.url, button))
            }
            grid.addArrangedSubview(row)
        }
    }

    private func render() {
        let me = Store.shared.members.first(where: \.current)
        let current = target == .pupu ? Store.shared.pupuAvatar : me?.avatar
        if buttons.count != presets.count { buildGrid() }
        if target == .pupu {
            let pupu = Avatars.shared.pupu()
            preview.layer.magnificationFilter = pupu.pixelArt ? .nearest : .linear
            preview.image = pupu.image
        } else {
            preview.layer.magnificationFilter = Avatars.isPixelArt(current) ? .nearest : .linear
            preview.image = Avatars.shared.image(current)
                ?? Avatars.round(nil, letter: Avatars.letter(me?.name ?? me?.email ?? "我"), size: 96, pixelArt: false)
        }
        for item in buttons {
            item.view.setImage(Avatars.shared.image(item.url), for: .normal)
            let selected = current == item.url
            item.view.accessibilityTraits = selected ? [.button, .selected] : .button
            item.view.layer.borderWidth = selected ? 3 : 0
            item.view.layer.borderColor = Theme.ink.resolvedColor(with: traitCollection).cgColor
            item.view.isEnabled = !busy
        }
        actions.arrangedSubviews.forEach { $0.removeFromSuperview() }
        actions.addArrangedSubview(row("从相册选") { [weak self] in self?.pickPhoto() })
        if current != nil {
            actions.addArrangedSubview(divider())
            actions.addArrangedSubview(row(target == .pupu ? "用原来的" : "用名字的第一个字") { [weak self] in self?.choose(nil) })
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        for item in buttons { item.view.layer.cornerRadius = item.view.bounds.width / 2 }
    }

    private func row(_ title: String, action: @escaping () -> Void) -> UIView {
        var config = UIButton.Configuration.plain()
        config.title = title
        config.baseForegroundColor = Theme.ink
        config.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: Theme.Space.s4, bottom: 14, trailing: Theme.Space.s4)
        let button = UIButton(configuration: config, primaryAction: UIAction { _ in action() })
        button.contentHorizontalAlignment = .leading
        button.isEnabled = !busy
        return button
    }

    private func divider() -> UIView {
        let line = UIView()
        line.backgroundColor = Theme.line
        line.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return line
    }

    private func choose(_ preset: String?) {
        let target = target
        run { api in try await api.setAvatar(preset: preset, of: target) }
    }

    private func pickPhoto() {
        let picker = UIImagePickerController()
        picker.sourceType = .photoLibrary
        picker.allowsEditing = true
        picker.delegate = self
        present(picker, animated: true)
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        guard let picked = (info[.editedImage] ?? info[.originalImage]) as? UIImage,
              let data = Self.squareJPEG(picked) else { return }
        let target = target
        run { api in try await api.uploadAvatar(data, type: "image/jpeg", of: target) }
    }

    /// 裁成正中的正方形（系统裁剪框已经是方的，这一步兜底），缩到 256，存成 JPEG。云端只验不转码。
    static func squareJPEG(_ image: UIImage) -> Data? {
        let side: CGFloat = 256
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let scale = side / min(image.size.width, image.size.height)
        let drawn = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let square = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            image.draw(in: CGRect(x: (side - drawn.width) / 2, y: (side - drawn.height) / 2, width: drawn.width, height: drawn.height))
        }
        return square.jpegData(compressionQuality: 0.85)
    }

    private func run(_ action: @escaping (API) async throws -> Void) {
        guard !busy, let api = Store.shared.api else { return }
        busy = true
        render()
        Task {
            do {
                try await action(api)
                UISelectionFeedbackGenerator().selectionChanged()
            } catch {
                let alert = UIAlertController(title: "没换成", message: error.localizedDescription, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "好", style: .default))
                present(alert, animated: true)
            }
            busy = false
            Store.shared.refresh()
            render()
        }
    }
}
