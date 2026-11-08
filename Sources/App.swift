import Cocoa
import WebKit

@main
final class VideoDedupeApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var worker: Process?
    var inputPipe: Pipe?
    var outputPipe: Pipe?
    var outputBuffer = Data()
    var servicePort: Int?
    var token = UUID().uuidString + UUID().uuidString
    var stopping = false
    var quitPending = false
    var selfTestDataDirectory: URL?
    var selfTestDirectoryIndex = 0
    let preferenceKeys = ["video-dedupe-settings-v2", "video-dedupe-active"]

    static func main() {
        let app = NSApplication.shared
        let delegate = VideoDedupeApp()
        app.delegate = delegate
        app.setActivationPolicy(ProcessInfo.processInfo.environment["VD_SELF_TEST_REPORT"] == nil ? .regular : .accessory)
        app.run()
        withExtendedLifetime(delegate) {}
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let root = NSMenuItem(); menu.addItem(root)
        let appMenu = NSMenu(); root.submenu = appMenu
        appMenu.addItem(withTitle: "关于视频去重", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出视频去重", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editRoot = NSMenuItem(); editRoot.title = "编辑"; menu.addItem(editRoot)
        let edit = NSMenu(title: "编辑"); editRoot.submenu = edit
        for (title, selector, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        NSApp.mainMenu = menu
        let controller = WKUserContentController()
        controller.addScriptMessageHandler(self, contentWorld: .page, name: "native")
        var saved: [String: String] = [:]
        for key in preferenceKeys { if let value = UserDefaults.standard.string(forKey: key) { saved[key] = value } }
        let savedJSON = String(data: try! JSONSerialization.data(withJSONObject: saved), encoding: .utf8)!
        let boot = """
        (()=>{
          const token='\(token)';
          window.__desktopErrors=[];window.addEventListener('error',e=>window.__desktopErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__desktopErrors.push(String(e.reason)));
          const original=window.fetch.bind(window);
          window.fetch=(input,options={})=>{
            const url=new URL(typeof input==='string'?input:input.url,location.href);
            if(url.origin===location.origin){const headers=new Headers(options.headers||(input instanceof Request?input.headers:undefined));headers.set('X-Desktop-Token',token);options={...options,headers};}
            return original(input,options);
          };
          const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open=function(method,url,...rest){this.desktopLocal=new URL(url,location.href).origin===location.origin;return open.call(this,method,url,...rest);};
          XMLHttpRequest.prototype.send=function(data){if(this.desktopLocal)this.setRequestHeader('X-Desktop-Token',token);return send.call(this,data);};
          try { if(localStorage.getItem('__desktopPrefsSeeded')!==token){for(const [key,value] of Object.entries(\(savedJSON)))localStorage.setItem(key,value);localStorage.setItem('__desktopPrefsSeeded',token);} } catch {}
        })();
        """
        controller.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let config = WKWebViewConfiguration(); config.userContentController = controller
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1160, height: 860), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.title = "视频去重 · Mac"
        window.minSize = NSSize(width: 760, height: 600)
        window.contentView = webView
        window.center()
        if ProcessInfo.processInfo.environment["VD_SELF_TEST_REPORT"] == nil {
            window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        }
        webView.loadHTMLString("<body style='font:18px system-ui;padding:70px;background:#eef2f7'><h1>视频去重 · Mac</h1><p>正在启动本地处理引擎…</p></body>", baseURL: nil)
        startWorker()
    }
    func startWorker() {
        guard let resources = Bundle.main.resourceURL else { return }
        do {
            let data: URL
            if ProcessInfo.processInfo.environment["VD_SELF_TEST_REPORT"] != nil {
                data = FileManager.default.temporaryDirectory.appendingPathComponent("VideoDedupeSelfTest-" + UUID().uuidString, isDirectory: true)
                selfTestDataDirectory = data
            } else {
                data = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("VideoDedupeMac", isDirectory: true)
            }
            try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
            let process = Process(), stdout = Pipe(), stdin = Pipe()
            var env = ProcessInfo.processInfo.environment
            env["VD_DATA_ROOT"] = data.path
            env["VD_TOKEN"] = token
            env["VD_TOOLS"] = resources.appendingPathComponent("bin").path
            process.environment = env
            process.executableURL = resources.appendingPathComponent("bin/node")
            process.arguments = [resources.appendingPathComponent("server.cjs").path]
            process.standardOutput = stdout; process.standardInput = stdin
            let log = data.appendingPathComponent("engine.log")
            if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
            let logHandle = try FileHandle(forWritingTo: log); try logHandle.seekToEnd()
            process.standardError = logHandle
            stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let chunk = handle.availableData
                guard !chunk.isEmpty else { handle.readabilityHandler = nil; return }
                DispatchQueue.main.async { self?.readWorkerOutput(chunk) }
            }
            process.terminationHandler = { [weak self] p in
                DispatchQueue.main.async {
                    guard let self = self, !self.stopping else { return }
                    self.showError("处理引擎已停止（\(p.terminationStatus)）。请重新打开应用。日志：\(log.path)")
                }
            }
            worker = process; inputPipe = stdin; outputPipe = stdout
            try process.run()
        } catch { showError("本地引擎启动失败：\(error.localizedDescription)") }
    }
    func readWorkerOutput(_ data: Data) {
        outputBuffer.append(data)
        guard servicePort == nil, let newline = outputBuffer.firstIndex(of: 10) else { return }
        let line = outputBuffer.prefix(upTo: newline)
        guard let info = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let port = info["port"] as? Int else { showError("本地引擎返回了无效的启动信息"); return }
        servicePort = port
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/video-dedupe.html?token=\(token)")!))
    }
    func showError(_ message: String) {
        let alert = NSAlert(); alert.messageText = "视频去重"; alert.informativeText = message; alert.runModal()
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == "127.0.0.1", message.frameInfo.securityOrigin.port == servicePort,
              let body = message.body as? [String: Any], let action = body["action"] as? String else { replyHandler(nil, "无效的桌面请求"); return }
        switch action {
        case "directory", "files":
            if action == "directory", let root = selfTestDataDirectory {
                let directory = root.appendingPathComponent("picker-\(selfTestDirectoryIndex)", isDirectory: true)
                selfTestDirectoryIndex += 1
                do {
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    if selfTestDirectoryIndex % 2 == 1 {
                        let fixture = Process()
                        fixture.executableURL = Bundle.main.resourceURL!.appendingPathComponent("bin/ffmpeg")
                        fixture.arguments = ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=1", "-c:v", "libx264", directory.appendingPathComponent("sample.mp4").path]
                        fixture.standardError = Pipe()
                        try fixture.run(); fixture.waitUntilExit()
                        if fixture.terminationStatus != 0 { throw NSError(domain: "SelfTest", code: 1, userInfo: [NSLocalizedDescriptionKey: "测试视频生成失败"]) }
                        try FileManager.default.copyItem(at: directory.appendingPathComponent("sample.mp4"), to: directory.appendingPathComponent("sample-2.mp4"))
                    }
                    replyHandler(directory.path, nil)
                }
                catch { replyHandler(nil, error.localizedDescription) }
                return
            }
            let panel = NSOpenPanel()
            let folder = action == "directory" || body["folder"] as? Bool == true
            panel.canChooseDirectories = folder; panel.canChooseFiles = !folder
            panel.allowsMultipleSelection = action == "files" && body["multiple"] as? Bool == true && !folder
            panel.prompt = body["prompt"] as? String ?? (action == "directory" ? "保存到此文件夹" : "导入视频")
            panel.message = body["message"] as? String ?? (action == "directory" ? "处理完成后自动保存；重名文件会自动编号。" : "选择需要处理的视频，原文件不会被修改。")
            panel.beginSheetModal(for: window) { response in
                guard response == .OK else { replyHandler(nil, nil); return }
                if action == "directory" { replyHandler(panel.url!.path, nil); return }
                let selected = panel.urls
                DispatchQueue.global(qos: .userInitiated).async {
                    let extensions: Set<String> = ["mp4","mov","m4v","webm","avi","mkv","ts","mts","m2ts","mpeg","mpg"]
                    var urls = selected
                    if folder, let directory = selected.first {
                        urls = (FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles, .skipsPackageDescendants])?.allObjects as? [URL] ?? []).sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
                    }
                    let files: [[String: Any]] = urls.compactMap { url in
                        guard extensions.contains(url.pathExtension.lowercased()), let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]), values.isRegularFile == true else { return nil }
                        return ["name": url.lastPathComponent, "nativePath": url.path, "size": values.fileSize ?? 0, "lastModified": (values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000]
                    }
                    DispatchQueue.main.async { replyHandler(files, nil) }
                }
            }
        case "persist":
            guard let key = body["key"] as? String, preferenceKeys.contains(key) else { replyHandler(nil, "无效设置"); return }
            if selfTestDataDirectory == nil {
                if let value = body["value"] as? String { UserDefaults.standard.set(value, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
            }
            replyHandler(true, nil)
        case "reveal":
            if let path = body["path"] as? String { NSWorkspace.shared.open(URL(fileURLWithPath: path, isDirectory: true)) }
            replyHandler(true, nil)
        default: replyHandler(nil, "不支持的桌面操作")
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        decisionHandler(url.scheme == "about" || (url.scheme == "http" && url.host == "127.0.0.1" && url.port == servicePort) ? .allow : .cancel)
    }
    // App-owned smoke test: verify the bundled WKWebView and authenticated bridge.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView.url?.host == "127.0.0.1", let report = ProcessInfo.processInfo.environment["VD_SELF_TEST_REPORT"] else { return }
        let check = """
        const capabilities = await api('/capabilities');
        const automatic = await api('/auto-queue');
        renderAutoQueue(automatic);
        if(!autoRows.size)createAutoRow();
        const first=[...autoRows.values()][0];
        await chooseAutoDirectory(first,'input');await chooseAutoDirectory(first,'output');
        document.getElementById('autoAddGroup').click();
        const second=[...autoRows.values()].find(r=>r!==first);
        await chooseAutoDirectory(second,'input');await chooseAutoDirectory(second,'output');
        first.settleSeconds=3;first.settle.value='3';first.dirty=true;await autoAction('save',first);second.settleSeconds=3;second.settle.value='3';second.dirty=true;await autoAction('save',second);
        const beforeStart=await api('/auto-queue');
        document.getElementById('mergeUnlimited').checked=true;document.getElementById('merge').checked=false;document.getElementById('compress').checked=true;compressionControls();
        await autoAction('startAll');
        const afterStart=await api('/auto-queue');
        const uiFlow={configured:beforeStart.groups.length,started:afterStart.groups.filter(g=>g.enabled).length,errors:[autoGlobalError,...[...autoRows.values()].map(r=>r.error)],manualMergePreserved:document.getElementById('mergeUnlimited').checked};
        async function waitForSaved(count){
          const until=Date.now()+45000;
          while(Date.now()<until){const state=await api('/auto-queue');if(state.counts.completed>=count&&!state.enabled&&!state.active)return state;await new Promise(r=>setTimeout(r,250));}
          throw Error('界面启动后实际视频保存超时：'+JSON.stringify(await api('/auto-queue')));
        }
        const completed=await waitForSaved(4);uiFlow.saved=completed.counts.completed;uiFlow.outputs=completed.counts.outputs;uiFlow.allStopped=!completed.enabled&&!completed.active;uiFlow.sourceNames=completed.groups.every(g=>g.name===g.config.inputDirectory.split('/').at(-1)&&g.config.options.mergeName===g.name);uiFlow.mergeAndCompression=completed.groups.every(g=>g.config.options.mergeUnlimited&&g.config.options.compress);
        uiFlow.routed=completed.groups.every(g=>g.entries[0]?.savedPaths[0]?.startsWith(g.config.outputDirectory+'/'));
        await autoAction('stopAll');
        await autoAction('start',first);
        await new Promise(r=>setTimeout(r,100));const resumed=(await api('/auto-queue')).groups.find(g=>g.id===first.id);uiFlow.singleStarted=resumed.counts.completed===2&&!resumed.active;
        await autoAction('stopAll');
        document.getElementById('autoAddGroup').click();
        const third=[...autoRows.values()].find(r=>r.draft);third.settleSeconds=3;third.settle.value='3';
        third.start.click();
        const wizardCompleted=await waitForSaved(6);
        uiFlow.guidedStart=wizardCompleted.groups.find(g=>g.id===third.id)?.counts.completed===2;
        await autoAction('stopAll');
        uiFlow.quitState=await desktopQuitState();uiFlow.vocalProgress=videoProgressText({progress:94,phase:{code:'vocals',label:'人声分离',completed:22,total:40,currentSegment:23,progress:55,startedAt:Date.now()-61000}});
        let bridge = '';
        try { await window.webkit.messageHandlers.native.postMessage({action:'persist',key:'invalid'}); }
        catch(e) { bridge = String(e); }
        return JSON.stringify({title:document.title, errors:window.__desktopErrors, native:typeof window.webkit.messageHandlers.native.postMessage, directory:typeof window.showDirectoryPicker, input:document.getElementById('filePicker').type, options:typeof options, save:typeof saveAll, capabilities, automaticEnabled:automatic.enabled, bridge, refreshButton:document.getElementById('refreshUI')?.textContent, refreshHandler:typeof refreshUI, autoAddButton:document.getElementById('autoAddGroup')?.textContent, autoTaskCount:document.querySelectorAll('.watch-task').length, autoHandler:typeof autoAction, removedControls:!document.getElementById('trim')&&!document.getElementById('mirror'), currentOptions:options(), uiFlow});
        """
        webView.callAsyncJavaScript(check, arguments: [:], in: nil, in: .page) { result in
            let text: String
            switch result {
            case .success(let value): text = value as? String ?? "Invalid report"
            case .failure(let error): text = "\(error.localizedDescription): \((error as NSError).userInfo)"
            }
            try? text.write(toFile: report, atomically: true, encoding: .utf8)
            NSApp.terminate(nil)
        }
    }
    func showMainWindow() {
        window.deminiaturize(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMainWindow()
        return true
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Keep the window alive until the user confirms termination.
        if !quitPending { NSApp.terminate(nil) }
        return false
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard servicePort != nil, selfTestDataDirectory == nil else { return .terminateNow }
        if quitPending { return .terminateCancel }
        quitPending = true
        webView.callAsyncJavaScript("return await desktopQuitState();", arguments: [:], in: nil, in: .page) { result in
            let title: String, message: String, continueTitle: String, quitTitle: String
            switch result {
            case .success(let value):
                guard let state = value as? [String: Any] else { self.quitPending = false; NSApp.reply(toApplicationShouldTerminate: false); self.showMainWindow(); return }
                if state["processing"] as? Bool == true {
                    title = "视频正在处理或保存"
                    message = "退出会中断当前处理。已保存文件会保留，未完成的视频可在重开后继续处理。"
                    continueTitle = "继续处理"; quitTitle = "退出并取消"
                } else if state["watching"] as? Bool == true {
                    let pending = state["pending"] as? Int ?? 0
                    title = pending > 0 ? "还有待处理的视频" : "文件夹监听仍开启"
                    message = pending > 0 ? "当前还有等待处理或等待稳定的视频，退出会停止接收。已保存文件会保留。" : "当前没有视频正在处理或保存，退出只会停止文件夹监听。已保存文件会保留。"
                    continueTitle = "继续监听"; quitTitle = "停止监听并退出"
                } else { NSApp.reply(toApplicationShouldTerminate: true); return }
            case .failure:
                title = "暂时无法确认任务状态"
                message = "退出将停止本地引擎；如果仍有视频正在处理，会中断当前处理。已保存文件会保留。"
                continueTitle = "返回应用"; quitTitle = "退出应用"
            }
            let alert = NSAlert(); alert.messageText = title; alert.informativeText = message
            alert.addButton(withTitle: continueTitle); alert.addButton(withTitle: quitTitle)
            self.showMainWindow()
            alert.beginSheetModal(for: self.window) { response in
                let quitting = response == .alertSecondButtonReturn
                self.quitPending = false
                NSApp.reply(toApplicationShouldTerminate: quitting)
                if !quitting { self.showMainWindow() }
            }
        }
        return .terminateLater
    }
    func applicationWillTerminate(_ notification: Notification) {
        stopping = true
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        try? inputPipe?.fileHandleForWriting.close()
        if worker?.isRunning == true { worker?.terminate(); worker?.waitUntilExit() }
        if let directory = selfTestDataDirectory { try? FileManager.default.removeItem(at: directory) }
    }
}
