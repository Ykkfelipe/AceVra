// Deterministic local AppKit target for CUA-3. No network, files, or user data.
import AppKit

private final class KeyTarget: NSView {
    var status: NSTextField!
    override var acceptsFirstResponder: Bool { true }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        needsDisplay = true
    }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 49 {
            status.stringValue = "space pressed"
            setAccessibilityValue("space pressed")
        } else {
            status.stringValue = "key \(event.keyCode) pressed"
            setAccessibilityValue("key \(event.keyCode) pressed")
        }
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemBlue.withAlphaComponent(0.2).setFill()
        dirtyRect.fill()
        let title = "Click here, then press Space"
        title.draw(at: NSPoint(x: 12, y: 20), withAttributes: [
            .font: NSFont.systemFont(ofSize: 15), .foregroundColor: NSColor.labelColor,
        ])
    }
}

private final class FixtureController: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private var window: NSWindow!
    private var clickButton: NSButton!
    private var clickStatus: NSTextField!
    private var textStatus: NSTextField!
    private var keyStatus: NSTextField!
    private var scrollStatus: NSTextField!
    private var dragStatus: NSTextField!
    private var textField: NSTextField!
    private var scrollView: NSScrollView!
    private var scrollObserver: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        window = NSWindow(contentRect: NSRect(x: 240, y: 180, width: 600, height: 565),
                          styleMask: [.titled, .closable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "AceVra CUA-3 Fixture"
        window.isReleasedWhenClosed = false
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 565))
        window.contentView = content

        let button = NSButton(frame: NSRect(x: 30, y: 500, width: 150, height: 32))
        clickButton = button
        button.title = "Click target"
        button.target = self
        button.action = #selector(clicked)
        button.setAccessibilityIdentifier("cua.click.button")
        button.setAccessibilityValue("idle")
        content.addSubview(button)
        clickStatus = label("click idle", x: 205, y: 505, width: 350,
                            identifier: "cua.click.status", parent: content)

        textField = NSTextField(frame: NSRect(x: 30, y: 440, width: 270, height: 28))
        textField.placeholderString = "Type deterministic text"
        textField.delegate = self
        textField.setAccessibilityIdentifier("cua.text.field")
        content.addSubview(textField)
        textStatus = label("text idle", x: 320, y: 445, width: 250,
                           identifier: "cua.text.status", parent: content)

    let keyTarget = KeyTarget(frame: NSRect(x: 30, y: 345, width: 270, height: 60))
    keyTarget.setAccessibilityElement(true)
    keyTarget.setAccessibilityRole(.group)
    keyTarget.setAccessibilityLabel("CUA key target")
    keyTarget.setAccessibilityIdentifier("cua.key.target")
    content.addSubview(keyTarget)
        keyStatus = label("key idle", x: 320, y: 360, width: 250,
                          identifier: "cua.key.status", parent: content)
        keyTarget.status = keyStatus

        scrollView = NSScrollView(frame: NSRect(x: 30, y: 185, width: 270, height: 125))
        scrollView.hasVerticalScroller = true
        scrollView.contentView.postsBoundsChangedNotifications = true
        let document = NSView(frame: NSRect(x: 0, y: 0, width: 250, height: 650))
        for index in 0..<24 {
            let row = NSTextField(labelWithString: "Fixture row \(index)")
            row.frame = NSRect(x: 10, y: 625 - index * 26, width: 210, height: 20)
            document.addSubview(row)
        }
        scrollView.documentView = document
        content.addSubview(scrollView)
        scrollStatus = label("scroll 0", x: 320, y: 245, width: 250,
                             identifier: "cua.scroll.status", parent: content)
        scrollObserver = NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification, object: scrollView.contentView,
            queue: .main) { [weak self] _ in
                guard let self else { return }
                let offset = Int(self.scrollView.contentView.bounds.origin.y)
                self.scrollStatus.stringValue = "scroll \(offset)"
                self.scrollView.setAccessibilityValue(String(offset))
            }

        let slider = NSSlider(frame: NSRect(x: 30, y: 105, width: 270, height: 30))
        slider.minValue = 0
        slider.maxValue = 100
        slider.doubleValue = 0
        slider.target = self
        slider.action = #selector(sliderChanged(_:))
        slider.setAccessibilityIdentifier("cua.drag.slider")
        slider.setAccessibilityValue("0")
        content.addSubview(slider)
        dragStatus = label("drag 0", x: 320, y: 110, width: 250,
                           identifier: "cua.drag.status", parent: content)

        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func label(_ value: String, x: Int, y: Int, width: Int,
                       identifier: String, parent: NSView) -> NSTextField {
        let field = NSTextField(labelWithString: value)
        field.frame = NSRect(x: x, y: y, width: width, height: 24)
        field.setAccessibilityIdentifier(identifier)
        parent.addSubview(field)
        return field
    }

    @objc private func clicked() {
        clickButton.setAccessibilityValue("clicked")
        clickStatus.stringValue = "clicked"
    }
    @objc private func sliderChanged(_ sender: NSSlider) {
        let value = Int(sender.doubleValue)
        sender.setAccessibilityValue(String(value))
        dragStatus.stringValue = "drag \(value)"
    }
    func controlTextDidChange(_ notification: Notification) {
        textStatus.stringValue = "text length \(textField.stringValue.count)"
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct ForegroundFixture {
    static func main() {
        let app = NSApplication.shared
        let controller = FixtureController()
        app.delegate = controller
        app.run()
    }
}
