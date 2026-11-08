import Cocoa
let image = NSImage(size: NSSize(width: 1024, height: 1024))
image.lockFocus()
let bg = NSBezierPath(roundedRect: NSRect(x: 64,y: 64,width: 896,height: 896), xRadius: 200,yRadius: 200)
NSColor(calibratedRed: 0.13,green: 0.32,blue: 0.78,alpha: 1).setFill();bg.fill()
NSColor.white.withAlphaComponent(0.25).setStroke()
let back = NSBezierPath(roundedRect: NSRect(x: 220,y: 350,width: 540,height: 400),xRadius: 55,yRadius: 55);back.lineWidth=24;back.stroke()
NSColor.white.setFill()
NSBezierPath(roundedRect: NSRect(x: 170,y: 250,width: 540,height: 400),xRadius: 55,yRadius: 55).fill()
NSColor(calibratedRed: 0.13,green: 0.32,blue: 0.78,alpha: 1).setFill()
let play = NSBezierPath();play.move(to: NSPoint(x: 380,y: 350));play.line(to:NSPoint(x: 380,y: 550));play.line(to:NSPoint(x: 540,y: 450));play.close();play.fill()
NSColor(calibratedRed: 0.2,green: 0.83,blue: 0.64,alpha: 1).setFill()
NSBezierPath(ovalIn: NSRect(x: 620,y: 190,width: 220,height: 220)).fill()
NSColor.white.setStroke();let check=NSBezierPath();check.lineWidth=22;check.lineCapStyle = .round;check.lineJoinStyle = .round
check.move(to:NSPoint(x: 678,y: 302));check.line(to:NSPoint(x: 715,y: 265));check.line(to:NSPoint(x: 784,y: 340));check.stroke()
image.unlockFocus()
let bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!
try bitmap.representation(using:.png,properties:[:])!.write(to: URL(fileURLWithPath:CommandLine.arguments[1]))
