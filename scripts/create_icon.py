from PIL import Image, ImageDraw
from pathlib import Path
out = Path(__file__).resolve().parents[1] / 'assets'
out.mkdir(exist_ok=True)
im = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((8, 8, 248, 248), radius=56, fill='#122735')
d.arc((45, 44, 211, 210), 185, 350, fill='#66d5b6', width=19)
d.arc((45, 44, 211, 210), 5, 170, fill='#66d5b6', width=19)
d.line([(56, 160), (87, 126), (114, 143), (156, 96), (198, 96)], fill='#e5d39d', width=12, joint='curve')
d.ellipse((184, 87, 202, 105), fill='#e5d39d')
im.save(out / 'icon.png')
im.save(out / 'icon.ico', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
