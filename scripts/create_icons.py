from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1] / "src-tauri" / "icons"
ROOT.mkdir(parents=True, exist_ok=True)

size = 512
background = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(background)
draw.rounded_rectangle((20, 20, size - 20, size - 20), radius=112, fill="#11121a")

# The V uses a quiet purple-to-lavender gradient matching the interface accent.
mask = Image.new("L", (size, size), 0)
ImageDraw.Draw(mask).polygon(
    [(104, 96), (179, 96), (256, 294), (333, 96), (408, 96), (294, 416), (218, 416)],
    fill=255,
)
gradient = Image.new("RGBA", (size, size))
pixels = gradient.load()
start = (137, 112, 215)
end = (219, 204, 255)
for y in range(size):
    blend = y / (size - 1)
    color = tuple(round(start[i] + (end[i] - start[i]) * blend) for i in range(3)) + (255,)
    for x in range(size):
        pixels[x, y] = color
background.alpha_composite(Image.composite(gradient, Image.new("RGBA", (size, size)), mask))

background.save(ROOT / "icon.png", optimize=True)
for name, dimension in (("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)):
    background.resize((dimension, dimension), Image.Resampling.LANCZOS).save(ROOT / name, optimize=True)
background.save(ROOT / "icon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
