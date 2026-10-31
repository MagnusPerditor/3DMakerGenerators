#!/usr/bin/env python3
"""Build every form of 3D Maker Generators from src/.

    python3 tools/build.py            # all targets
    python3 tools/build.py web plugin # only some

Targets
  web      dist/maker-generators.html             single file; loads three.js and fonts from CDNs
  plugin   dist/maker_generators_orca_plugin.py   OrcaSlicer 2.5 plugin, everything inlined (works offline)
  desktop  desktop/app/                           Neutralino project, ready for `neu build` (see README)
"""
import base64, os, re, shutil, sys, zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC, VENDOR, DIST = (os.path.join(ROOT, d) for d in ('src', 'vendor', 'dist'))
THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js'
ORBIT_CDN = 'https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/OrbitControls.js'


def read(*p, mode='r'):
    with open(os.path.join(*p), mode, **({} if 'b' in mode else {'encoding': 'utf-8'})) as f:
        return f.read()


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb' if isinstance(data, bytes) else 'w', **({} if isinstance(data, bytes) else {'encoding': 'utf-8', 'newline': '\n'})) as f:
        f.write(data)


def replace_once(src, old, new):
    assert src.count(old) == 1, f'expected exactly one {old[:60]!r}, found {src.count(old)}'
    return src.replace(old, new)


def web_page():
    page = read(SRC, 'app.html')
    db = read(SRC, 'spoolmandb.json').replace('</', '<\\/')
    return page.replace('/*CORE*/', read(SRC, 'core.js')).replace('/*SPOOLMANDB*/', db)


def without_cdn_fonts(page, replacement):
    page = re.sub(r'<link rel="preconnect"[^>]*>\s*', '', page)
    links = re.findall(r'<link href="https://fonts\.googleapis\.com/[^"]*" rel="stylesheet">', page)
    assert len(links) == 1
    return replace_once(page, links[0], replacement)


def build_web():
    out = os.path.join(DIST, 'maker-generators.html')
    write(out, web_page())
    print('web     ', os.path.relpath(out, ROOT))


def build_plugin():
    css = read(VENDOR, 'fonts', 'fonts.css')
    faces = []
    for face in re.findall(r'@font-face\{[^}]*\}', css):
        m = re.search(r'url\(([^)]+)\)', face)
        if '-ext-' in m.group(1):
            continue  # Latin subsets only: keeps the plugin small
        b64 = base64.b64encode(read(VENDOR, 'fonts', m.group(1), mode='rb')).decode()
        faces.append(face.replace(m.group(0), 'url(data:font/woff2;base64,' + b64 + ')'))
    page = without_cdn_fonts(web_page(), '<style>' + ''.join(faces) + '</style>')
    for url, name in ((THREE_CDN, 'three.min.js'), (ORBIT_CDN, 'OrbitControls.js')):
        js = read(VENDOR, name)
        assert '</script' not in js.lower()
        page = replace_once(page, f'<script src="{url}"></script>', '<script>' + js + '</script>')
    packed = base64.b64encode(zlib.compress(page.encode('utf-8'), 9)).decode()
    lines = '\n'.join('    "%s"' % packed[i:i + 100] for i in range(0, len(packed), 100))
    out = os.path.join(DIST, 'maker_generators_orca_plugin.py')
    write(out, read(ROOT, 'plugin', 'plugin_template.py').replace('__PAGE_DATA__', lines))
    print('plugin  ', os.path.relpath(out, ROOT))


def build_desktop():
    app = os.path.join(ROOT, 'desktop', 'app')
    res = os.path.join(app, 'resources')
    shutil.rmtree(res, ignore_errors=True)
    page = without_cdn_fonts(web_page(), '<link href="fonts/fonts.css" rel="stylesheet">')
    page = replace_once(page, f'<script src="{ORBIT_CDN}"></script>', '<script src="lib/OrbitControls.js"></script>')
    # The Neutralino runtime prepends its globals (with the one-time token) to js/neutralino.js itself,
    # so the client must be loaded from there and never from /__neutralino_globals.js as well.
    page = replace_once(page, f'<script src="{THREE_CDN}"></script>',
                        '<script src="js/neutralino.js"></script>\n'
                        '<script>Neutralino.init(); Neutralino.events.on("windowClose", () => Neutralino.app.exit());</script>\n'
                        '<script src="lib/three.min.js"></script>')
    assert 'googleapis' not in page and 'jsdelivr' not in page
    write(os.path.join(res, 'index.html'), page)
    shutil.copytree(os.path.join(VENDOR, 'fonts'), os.path.join(res, 'fonts'))
    for sub in ('lib', 'js', 'icons'):
        os.makedirs(os.path.join(res, sub), exist_ok=True)
    for name in ('three.min.js', 'OrbitControls.js'):
        shutil.copy(os.path.join(VENDOR, name), os.path.join(res, 'lib', name))
    shutil.copy(os.path.join(VENDOR, 'neutralino.js'), os.path.join(res, 'js', 'neutralino.js'))
    shutil.copy(os.path.join(ROOT, 'desktop', 'icons', 'appIcon.png'), os.path.join(res, 'icons', 'appIcon.png'))
    shutil.copy(os.path.join(ROOT, 'desktop', 'neutralino.config.json'), os.path.join(app, 'neutralino.config.json'))
    print('desktop ', os.path.relpath(app, ROOT), '(now run neu build there, see README)')


TARGETS = {'web': build_web, 'plugin': build_plugin, 'desktop': build_desktop}

if __name__ == '__main__':
    wanted = sys.argv[1:] or list(TARGETS)
    for t in wanted:
        if t not in TARGETS:
            sys.exit(f'unknown target {t!r}; choose from {", ".join(TARGETS)}')
        TARGETS[t]()
