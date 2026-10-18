#!/usr/bin/env python3
"""Package the production website and complete source, never user-owned game data."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys
import zipfile

root = Path(__file__).resolve().parents[2]
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / 'target/browser-package'
out.mkdir(parents=True, exist_ok=True)
for name in ['web/dist/wenilla_bg.wasm', 'web/dist/local-data-xhr.js', 'web/dist/local-data-sw.js',
             'web/dist/coop/pkg/azeroth_coop_bg.wasm', 'web/dist/coop/data-pkg/azeroth_data_bg.wasm',
             'scripts/coop/node_modules/ws/index.js']:
    if not (root / name).is_file():
        raise SystemExit(f'Missing {name}; build the website first')
with zipfile.ZipFile(out / 'azeroth-browser.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for folder in ['web/dist', 'scripts/coop']:
        for p in sorted((root / folder).rglob('*')):
            if not p.is_file() or p.suffix in ['.br', '.gz', '.pyc'] or '__pycache__' in p.parts:
                continue
            # Browser package excludes unrelated platform launchers and development tests.
            if folder == 'scripts/coop' and 'node_modules' not in p.parts and p.name not in ['website.mjs', 'server.mjs', 'package.json', 'package-lock.json']:
                continue
            z.write(p, 'azeroth-browser/' + p.relative_to(root).as_posix())
    for p in ['docs/BROWSER-COOP.md', 'LICENSE-MIT', 'LICENSE-APACHE', 'Cargo.lock']:
        z.write(root / p, 'azeroth-browser/' + p)
    z.write(root / 'docs/BROWSER-COOP.md', 'azeroth-browser/README.md')
    if (out / 'browser-test-results.md').exists():
        z.write(out / 'browser-test-results.md', 'azeroth-browser/browser-test-results.md')
files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root).split(b'\0')
with zipfile.ZipFile(out / 'azeroth-browser-source.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name in sorted(set(files)):
        if name and (root / os.fsdecode(name)).is_file():
            z.write(root / os.fsdecode(name), 'azeroth-survivors-re/' + os.fsdecode(name))
manifest = {}
for name in ['azeroth-browser.zip', 'azeroth-browser-source.zip']:
    p = out / name
    with zipfile.ZipFile(p) as z:
        assert z.testzip() is None
        assert not any(n.lower().endswith('.mpq') for n in z.namelist())
    manifest[name] = {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
    if p.stat().st_size > 25_000_000:
        raise SystemExit(f'{name} exceeds the 25 MB Outputs limit')
(out / 'browser-checksums.json').write_text(json.dumps(manifest, indent=2) + '\n')
(out / 'browser-readme.md').write_text((root / 'docs/BROWSER-COOP.md').read_text())
print(json.dumps(manifest, indent=2))
