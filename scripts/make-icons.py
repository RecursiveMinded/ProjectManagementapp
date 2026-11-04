"""Draws the app icon (build/icon.png and build/icon.ico). Run: npm run icons"""
from PIL import Image, ImageDraw
import os

S = 1024
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
# Violet-to-amber diagonal gradient in a rounded square.
grad = Image.new('RGBA', (S, S))
px = grad.load()
a, b = (76, 63, 214), (255, 159, 67)
for y in range(S):
    for x in range(S):
        t = max(0.0, min(1.0, (x + y) / (2 * S) * 1.25 - 0.15))
        px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=255)
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)
# Three board columns of cards, offset like a kanban at a glance.
W = (255, 255, 255, 255)
cols = [(230, [(250, 360), (400, 470)]), (440, [(250, 330), (370, 560), (600, 680)]), (650, [(250, 420)])]
for x, cards in cols:
    for y0, y1 in cards:
        d.rounded_rectangle([x, y0, x + 150, y1], radius=34, fill=W)
# A check on the finished card.
d.line([(680, 335), (715, 370), (770, 305)], fill=(76, 63, 214, 255), width=26, joint='curve')
# Timeline bar along the bottom.
d.rounded_rectangle([230, 740, 800, 790], radius=25, fill=(255, 255, 255, 120))
d.rounded_rectangle([230, 740, 560, 790], radius=25, fill=W)
os.makedirs('build', exist_ok=True)
img.resize((512, 512), Image.LANCZOS).save('build/icon.png')
img.save('build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('wrote build/icon.png and build/icon.ico')
