import SwiftUI
import UIKit

/// "Share to Hobwork": sends a link, text or files from another app to a hob's share target.
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        model.finish = { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }
        let cancel: () -> Void = { [weak self] in
            self?.model.cancel()
            self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
        }
        let host = UIHostingController(rootView: ShareView(model: model, cancel: cancel))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        host.didMove(toParent: self)
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        Task { await model.start(items) }
    }
}

struct ShareView: View {
    @Bindable var model: ShareModel
    let cancel: () -> Void

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Share to Hobwork")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if case .sent = model.state {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done", action: model.finish)
                        }
                    } else {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel", action: cancel)
                        }
                    }
                    if model.state == .choosing {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Send", action: model.send)
                                .disabled(model.selected == nil || model.problem != nil)
                        }
                    }
                }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .choosing:
            List {
                Section {
                    SharedSummary(items: model.items)
                }
                ForEach(hobs, id: \.self) { hob in
                    Section(hob) {
                        ForEach(model.options.filter { $0.hob == hob }) { option in
                            HStack {
                                Text(option.target.title)
                                Spacer()
                                if option.id == model.selection {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                            .contentShape(Rectangle())
                            .onTapGesture { model.selection = option.id }
                            .accessibilityAddTraits(option.id == model.selection ? .isSelected : [])
                        }
                    }
                }
                if let problem = model.problem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        case let .sending(progress):
            VStack(spacing: 16) {
                if progress.total > 0, case .uploading = progress.stage {
                    ProgressView(value: Double(progress.sent), total: Double(progress.total))
                } else {
                    ProgressView()
                }
                Text(caption(progress))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Text("Keep this open until it's sent.")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .sent(say):
            ContentUnavailableView {
                Label("Sent", systemImage: "checkmark.circle")
            } description: {
                Text(say)
            }
        case let .failed(message):
            ContentUnavailableView {
                Label("Couldn't Share", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            }
        }
    }

    private var hobs: [String] {
        model.options.reduce(into: []) { if !$0.contains($1.hob) { $0.append($1.hob) } }
    }

    private func caption(_ progress: ShareProgress) -> String {
        switch progress.stage {
        case let .uploading(file):
            let name = model.fileName(at: file, of: model.selected) ?? "file"
            let sent = ByteCountFormatter.string(fromByteCount: Int64(progress.sent), countStyle: .file)
            let total = ByteCountFormatter.string(fromByteCount: Int64(progress.total), countStyle: .file)
            return "Uploading \(name), \(sent) of \(total)"
        case .sending:
            return "Sending to \(model.selected?.hob ?? "the hob")…"
        }
    }
}

private struct SharedSummary: View {
    let items: SharedItems

    var body: some View {
        if let url = items.url {
            Label(url.host() ?? url.absoluteString, systemImage: "link")
                .lineLimit(1)
        }
        if let text = items.text {
            Label(text, systemImage: "text.alignleft")
                .lineLimit(2)
        }
        ForEach(items.files, id: \.file) { file in
            Label {
                Text(file.name).lineLimit(1)
                Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
                    .foregroundStyle(.secondary)
            } icon: {
                Image(systemName: "doc")
            }
        }
    }
}
