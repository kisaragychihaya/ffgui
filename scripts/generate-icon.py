#!/usr/bin/env python3
# 从 assets/imgs/icon.png 生成各平台所需图标
# - icon.ico：Windows 多尺寸图标（须与 packagerConfig.icon 同名才能被自动选用）
# - icon.icns：macOS 图标（需先 pip install icnsutil）

from PIL import Image
import os
import sys

try:
    from icnsutil import IcnsFile
except ImportError:
    IcnsFile = None


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(script_dir)
    src_png = os.path.join(root_dir, 'assets', 'imgs', 'icon.png')
    out_dir = os.path.join(root_dir, 'assets', 'imgs')

    if not os.path.exists(src_png):
        print(f'Error: source not found: {src_png}', file=sys.stderr)
        return 1

    img = Image.open(src_png)

    # Windows ICO：包含常见尺寸
    ico_path = os.path.join(out_dir, 'icon.ico')
    ico_sizes = [(16, 16), (32, 32), (48, 48), (256, 256)]
    img.save(ico_path, format='ICO', sizes=ico_sizes)
    print(f'Saved {ico_path}')

    # macOS ICNS
    if IcnsFile is not None:
        import tempfile
        icns_path = os.path.join(out_dir, 'icon.icns')
        icns = IcnsFile()
        with tempfile.TemporaryDirectory() as tmpdir:
            # 按 Apple 规范命名：icon_{WxH}.png / icon_{WxH}@2x.png
            mapping = {
                'icon_16x16.png': 16,
                'icon_16x16@2x.png': 32,
                'icon_32x32.png': 32,
                'icon_32x32@2x.png': 64,
                'icon_128x128.png': 128,
                'icon_128x128@2x.png': 256,
                'icon_256x256.png': 256,
                'icon_256x256@2x.png': 512,
                'icon_512x512.png': 512,
                'icon_512x512@2x.png': 1024,
            }
            for name, size in mapping.items():
                resized = img.resize((size, size), Image.LANCZOS)
                path = os.path.join(tmpdir, name)
                resized.save(path, 'PNG')
                icns.add_media(file=path)
            icns.write(icns_path)
        print(f'Saved {icns_path}')
    else:
        print('Skipped icon.icns: pip install icnsutil to enable', file=sys.stderr)

    return 0


if __name__ == '__main__':
    sys.exit(main())
