import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var serverProcess: Process?
    private var readOnlyServerProcess: Process?
    private let port = ProcessInfo.processInfo.environment["TEAM_CALENDAR_PORT"] ?? "8787"
    private lazy var readOnlyPort: String = {
        if let configured = ProcessInfo.processInfo.environment["TEAM_CALENDAR_READONLY_PORT"] {
            return configured
        }
        return String((Int(port) ?? 8787) + 1)
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        startServer()
        buildWindow()
        loadScheduler()
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
        readOnlyServerProcess?.terminate()
    }

    private func buildWindow() {
        let configuration = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "team-calendar"
        window.center()
        window.contentView = webView

        let toolbar = NSToolbar(identifier: "TeamCalendarToolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconAndLabel
        window.toolbar = toolbar
        window.makeKeyAndOrderFront(nil)
    }

    private func startServer() {
        guard serverProcess == nil else { return }
        do {
            serverProcess = try makeServerProcess(host: "127.0.0.1", port: port, readOnly: false)
        } catch {
            showAlert(title: "启动服务失败", message: "无法启动内置 Web 服务：\(error.localizedDescription)")
        }
    }

    private func ensureReadOnlyServer() -> Bool {
        if let process = readOnlyServerProcess, process.isRunning { return true }
        do {
            readOnlyServerProcess = try makeServerProcess(host: "0.0.0.0", port: readOnlyPort, readOnly: true)
            return true
        } catch {
            showAlert(title: "启动只读分享失败", message: "无法启动只读 Web 服务：\(error.localizedDescription)")
            return false
        }
    }

    private func makeServerProcess(host: String, port: String, readOnly: Bool) throws -> Process {
        let appDirectory = try bundledAppDirectory()
        let serverURL = appDirectory.appendingPathComponent("server.py")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", serverURL.path]
        process.currentDirectoryURL = appDirectory
        var environment = ProcessInfo.processInfo.environment
        environment["HOST"] = host
        environment["PORT"] = port
        let dataDirectory = applicationSupportDirectory().appendingPathComponent("data")
        environment["DATA_DIR"] = dataDirectory.path
        environment["DB_PATH"] = dataDirectory.appendingPathComponent("scheduler.sqlite").path
        environment["CONFIG_DIR"] = appDirectory.appendingPathComponent("config").path
        if readOnly {
            environment["READONLY_SERVER"] = "1"
        }
        process.environment = environment
        try process.run()
        return process
    }

    private func bundledAppDirectory() throws -> URL {
        guard let resourceURL = Bundle.main.resourceURL else {
            throw NSError(domain: "team-calendar", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法定位应用资源目录"])
        }
        return resourceURL.appendingPathComponent("app")
    }

    private func applicationSupportDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        let directory = base.appendingPathComponent("TeamCalendar", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: nil)
        return directory
    }

    private func loadScheduler() {
        guard let url = URL(string: "http://127.0.0.1:\(port)") else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.webView.load(URLRequest(url: url))
        }
    }

    @objc private func reloadPage() {
        webView.reload()
    }

    @objc private func shareReadOnlyAddress(_ sender: AnyObject?) {
        guard ensureReadOnlyServer() else { return }
        let shareURL = "http://\(localIPv4Address()):\(readOnlyPort)/?readonly=1"
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(shareURL, forType: .string)

        let picker = NSSharingServicePicker(items: [shareURL])
        if let view = window.contentView {
            picker.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
        } else {
            showAlert(title: "已复制只读访问地址", message: shareURL)
        }
    }

    private func localIPv4Address() -> String {
        var address = "127.0.0.1"
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else { return address }
        defer { freeifaddrs(interfaces) }

        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let interface = pointer.pointee
            guard let socketAddress = interface.ifa_addr else { continue }
            let family = socketAddress.pointee.sa_family
            guard family == UInt8(AF_INET) else { continue }
            let name = String(cString: interface.ifa_name)
            guard name == "en0" || name == "en1" || name.hasPrefix("bridge") else { continue }

            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            getnameinfo(socketAddress, socklen_t(socketAddress.pointee.sa_len), &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST)
            let candidate = String(cString: hostname)
            if !candidate.hasPrefix("127.") {
                address = candidate
                break
            }
        }
        return address
    }

    private func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.runModal()
    }
}

extension AppDelegate: NSToolbarDelegate {
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        return [.reloadPage, .shareReadOnly, .flexibleSpace]
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        return [.reloadPage, .flexibleSpace, .shareReadOnly]
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        switch itemIdentifier {
        case .reloadPage:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "刷新"
            item.paletteLabel = "刷新"
            item.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "刷新")
            item.target = self
            item.action = #selector(reloadPage)
            return item
        case .shareReadOnly:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "分享只读地址"
            item.paletteLabel = "分享只读地址"
            item.image = NSImage(systemSymbolName: "square.and.arrow.up", accessibilityDescription: "分享只读地址")
            item.target = self
            item.action = #selector(shareReadOnlyAddress(_:))
            return item
        default:
            return nil
        }
    }
}

private extension NSToolbarItem.Identifier {
    static let reloadPage = NSToolbarItem.Identifier("ReloadPage")
    static let shareReadOnly = NSToolbarItem.Identifier("ShareReadOnly")
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
app.run()
