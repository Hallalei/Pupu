import UIKit

// 骨架（规范 Skeleton）：会话、列表和正文第一次打开、手上还什么都没有时，在内容的位置先画几根不动的圆角条。
// 不加闪光、不做呼吸，宽度写死。整块是一个读屏元素，念「正在打开」，里面的条不单独读。
// 拿到过一次内容以后不再换回骨架：什么时候出现由用的地方定。

/// 列表：一条组标题（宽 64、高 14，左边让出 4），隔 4 是一组三行（`surface-inset` 底、`radius-row`），每行高 52、左右 16。
/// 组里的条画在 `surface-inset` 上，用 `line`。有图标位时左边一块 18 见方、圆角 5，分隔线从图标后面画起（16 + 18 + 12）；
/// 没有图标的列表（邀请码、通行密钥）去掉图标位，分隔线从左边 16 画起。
final class ListSkeletonView: UIView {
    init(icons: Bool) {
        super.init(frame: .zero)
        isAccessibilityElement = true
        accessibilityLabel = "正在打开"
        let heading = Self.bar(width: 64, height: 14, color: Theme.surfaceInset)
        let headingRow = UIView()
        headingRow.addSubview(heading)
        NSLayoutConstraint.activate([
            heading.leadingAnchor.constraint(equalTo: headingRow.leadingAnchor, constant: Theme.Space.s1),
            heading.topAnchor.constraint(equalTo: headingRow.topAnchor),
            heading.bottomAnchor.constraint(equalTo: headingRow.bottomAnchor)
        ])
        let group = SurfaceView(.inset, radius: Theme.Radius.row)
        let rows = UIStackView()
        rows.axis = .vertical
        let indent = Theme.Space.s4 + (icons ? 18 + Theme.Space.s3 : 0)
        for (index, width) in [0.4, 0.55, 0.3].enumerated() {
            if index > 0 { rows.addArrangedSubview(Self.separator(indent: indent)) }
            let top = UIView()
            let bottom = UIView()
            let text = UIView()
            for (bar, height) in [(top, 12.0), (bottom, 10.0)] {
                bar.backgroundColor = Theme.line
                bar.layer.cornerRadius = height / 2
                bar.translatesAutoresizingMaskIntoConstraints = false
                text.addSubview(bar)
            }
            NSLayoutConstraint.activate([
                top.topAnchor.constraint(equalTo: text.topAnchor),
                top.leadingAnchor.constraint(equalTo: text.leadingAnchor),
                top.heightAnchor.constraint(equalToConstant: 12),
                top.widthAnchor.constraint(equalTo: text.widthAnchor, multiplier: width),
                bottom.topAnchor.constraint(equalTo: top.bottomAnchor, constant: Theme.Space.s2),
                bottom.leadingAnchor.constraint(equalTo: text.leadingAnchor),
                bottom.bottomAnchor.constraint(equalTo: text.bottomAnchor),
                bottom.heightAnchor.constraint(equalToConstant: 10),
                bottom.widthAnchor.constraint(equalTo: text.widthAnchor, multiplier: width + 0.2)
            ])
            let parts = icons ? [Self.bar(width: 18, height: 18, color: Theme.line, radius: 5), text] : [text]
            let row = UIStackView(arrangedSubviews: parts)
            row.spacing = Theme.Space.s3
            row.alignment = .center
            row.isLayoutMarginsRelativeArrangement = true
            row.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s4, bottom: 0, trailing: Theme.Space.s4)
            row.heightAnchor.constraint(equalToConstant: 52).isActive = true
            rows.addArrangedSubview(row)
        }
        group.contentView.addSubview(rows)
        rows.pin(to: group.contentView)
        let column = UIStackView(arrangedSubviews: [headingRow, group])
        column.axis = .vertical
        column.spacing = Theme.Space.s1
        addSubview(column)
        column.pin(to: self)
    }

    required init?(coder: NSCoder) { fatalError() }

    private static func bar(width: CGFloat, height: CGFloat, color: UIColor, radius: CGFloat? = nil) -> UIView {
        let view = UIView()
        view.backgroundColor = color
        view.layer.cornerRadius = radius ?? height / 2
        view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            view.widthAnchor.constraint(equalToConstant: width),
            view.heightAnchor.constraint(equalToConstant: height)
        ])
        return view
    }

    /// 行之间 1pt 的 `line`，左边让出 `indent`。
    private static func separator(indent: CGFloat) -> UIView {
        let holder = UIView()
        let line = UIView()
        line.backgroundColor = Theme.line
        line.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(line)
        NSLayoutConstraint.activate([
            line.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: indent),
            line.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
            line.topAnchor.constraint(equalTo: holder.topAnchor),
            line.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            line.heightAnchor.constraint(equalToConstant: 1)
        ])
        return holder
    }
}

/// 正文：标题（高 20、宽 40%）、说明（高 14、宽 25%）和三行正文（高 16，宽 92%、85%、60%）的 `surface-inset` 色条，彼此隔 12。
final class PageSkeletonView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        isAccessibilityElement = true
        accessibilityLabel = "正在打开"
        let column = UIStackView()
        column.axis = .vertical
        column.spacing = Theme.Space.s3
        column.alignment = .leading
        for (width, height) in [(0.4, 20.0), (0.25, 14.0), (0.92, 16.0), (0.85, 16.0), (0.6, 16.0)] {
            let bar = UIView()
            bar.backgroundColor = Theme.surfaceInset
            bar.layer.cornerRadius = height / 2
            bar.translatesAutoresizingMaskIntoConstraints = false
            column.addArrangedSubview(bar)
            NSLayoutConstraint.activate([
                bar.heightAnchor.constraint(equalToConstant: height),
                bar.widthAnchor.constraint(equalTo: column.widthAnchor, multiplier: width)
            ])
        }
        addSubview(column)
        column.pin(to: self)
    }

    required init?(coder: NSCoder) { fatalError() }
}

/// 会话：Pupu 的一段三行回复（高 16，宽 92%、85%、60%），靠右一块我的气泡位（高 44、宽 50%、`radius-bubble`），
/// 再一段两行（92%、70%），彼此隔 12。条直接画在卡片上，用 `surface-inset`。不画头像、名字和时间。
/// 放在对话列里，左右 16、上面 12、最宽 column-max 由外面定，和消息开始的地方一样。
final class ChatSkeletonView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        isAccessibilityElement = true
        accessibilityLabel = "正在打开"
        let column = UIStackView()
        column.axis = .vertical
        column.spacing = Theme.Space.s3
        let shapes: [(width: CGFloat, height: CGFloat, mine: Bool)] = [
            (0.92, 16, false), (0.85, 16, false), (0.6, 16, false), (0.5, 44, true), (0.92, 16, false), (0.7, 16, false)
        ]
        for shape in shapes {
            let row = UIView()
            let bar = UIView()
            bar.backgroundColor = Theme.surfaceInset
            bar.layer.cornerRadius = shape.mine ? Theme.Radius.bubble : shape.height / 2
            if shape.mine { bar.layer.cornerCurve = .continuous }
            bar.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(bar)
            NSLayoutConstraint.activate([
                bar.topAnchor.constraint(equalTo: row.topAnchor),
                bar.bottomAnchor.constraint(equalTo: row.bottomAnchor),
                bar.heightAnchor.constraint(equalToConstant: shape.height),
                bar.widthAnchor.constraint(equalTo: row.widthAnchor, multiplier: shape.width),
                shape.mine ? bar.trailingAnchor.constraint(equalTo: row.trailingAnchor) : bar.leadingAnchor.constraint(equalTo: row.leadingAnchor)
            ])
            column.addArrangedSubview(row)
        }
        addSubview(column)
        column.pin(to: self)
    }

    required init?(coder: NSCoder) { fatalError() }
}
