import AppKit

guard CommandLine.arguments.count == 2,
      let data = try? Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])),
      let bitmap = NSBitmapImageRep(data: data),
      bitmap.pixelsWide == 1024, bitmap.pixelsHigh == 1024 else {
    fputs("App icon must be a readable 1024 by 1024 PNG.\n", stderr)
    exit(1)
}
var light = 0
var transparent = 0
var pink = 0
var plum = 0
for y in stride(from: 0, to: 1024, by: 4) {
    for x in stride(from: 0, to: 1024, by: 4) {
        guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { exit(1) }
        if color.alphaComponent < 1 { transparent += 1 }
        let brightness = (color.redComponent + color.greenComponent + color.blueComponent) / 3
        if brightness > 0.9 { light += 1 }
        let red = Int((color.redComponent * 255).rounded())
        let green = Int((color.greenComponent * 255).rounded())
        let blue = Int((color.blueComponent * 255).rounded())
        if red > 190 && green < 155 && blue > 110 && red > blue + 20 { pink += 1 }
        if red < 110 && green < 65 && blue < 100 && red > green { plum += 1 }
    }
}
guard !bitmap.hasAlpha, transparent == 0, light > 18000, pink > 6000, plum > 300 else {
    fputs("App icon must be opaque and contain the visible Cialai pink and plum mark.\n", stderr)
    exit(1)
}
print("App icon validated: 1024 by 1024, opaque, with Cialai pink and plum artwork.")
