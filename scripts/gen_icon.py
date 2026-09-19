# 从 icon-source.jpeg 生成 macOS 图标全套
# 这张图本身就是完整图标:深色圆角块 = 图标主体(原生圆角),四角的白只是照片背景 → 转为透明
# 做法:角点泛洪选出「与四角连通的近白区域」,按亮度平滑过渡为透明;不加底、不缩放留白
import numpy as np
from PIL import Image
from scipy import ndimage
import os, subprocess, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "icon-source.jpeg")
ICONS = os.path.join(ROOT, "src-tauri", "icons")
MASTER_SIZE = 1024

def render(size: int) -> Image.Image:
    return master.resize((size, size), Image.LANCZOS)

# 1. 中心裁剪正方形 → 1024
src = Image.open(SRC).convert("RGB")
w, h = src.size
side = min(w, h)
img = src.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))
img = img.resize((MASTER_SIZE, MASTER_SIZE), Image.LANCZOS)

# 2. 四角泛洪:与角落连通、且近白的区域 = 照片背景 → 透明
arr = np.array(img).astype(np.float32)
whiteish = arr.min(axis=2) > 180
labels, _ = ndimage.label(whiteish)
corners = {labels[0, 0], labels[0, -1], labels[-1, 0], labels[-1, -1]}
corners.discard(0)
bg_region = np.isin(labels, list(corners))

# 3. 背景区 alpha 按(轻微模糊的)亮度平滑过渡:白→透明,深→不透明;块外主体全不透明
lum = arr.mean(axis=2)
lum_s = ndimage.gaussian_filter(lum, sigma=2)
alpha = np.clip((232 - lum_s) * 3, 0, 255)
alpha = np.where(bg_region, alpha, 255).astype(np.uint8)

rgba = np.dstack([arr.astype(np.uint8), alpha])
master = Image.fromarray(rgba, "RGBA")

# 4. macOS iconset(标准 5 档 @1x/@2x)
iconset = os.path.join(ICONS, "icon.iconset")
os.makedirs(iconset, exist_ok=True)
for pt, px in [(16, 16), (32, 32), (128, 128), (256, 256), (512, 512)]:
    render(px).save(os.path.join(iconset, f"icon_{pt}x{pt}.png"))
    render(px * 2).save(os.path.join(iconset, f"icon_{pt}x{pt}@2x.png"))

# 5. Tauri 图标文件
render(1024).save(os.path.join(ICONS, "icon.png"))
render(512).save(os.path.join(ICONS, "512x512.png"))
render(32).save(os.path.join(ICONS, "32x32.png"))
render(64).save(os.path.join(ICONS, "64x64.png"))
render(128).save(os.path.join(ICONS, "128x128.png"))
render(256).save(os.path.join(ICONS, "128x128@2x.png"))
for sq in [30, 44, 71, 89, 107, 142, 150, 284, 310]:
    render(sq).save(os.path.join(ICONS, f"Square{sq}x{sq}Logo.png"))
render(50).save(os.path.join(ICONS, "StoreLogo.png"))
render(256).save(os.path.join(ICONS, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

# 6. 重建 icon.icns
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(ICONS, "icon.icns")], check=True)
shutil.rmtree(iconset)

print("done")
