#!/usr/bin/env python3
"""Package the existing 3D bundle and Windows reader; never include WoW data."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
NODE = '24.14.1'
NODE_SHA256 = '58e74bf02fc5bbacc41dcb8bef089961cd5bddd37830b87784e4fc624d145d1f'
OUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / 'target/windows-package'
OUT.mkdir(parents=True, exist_ok=True)


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def digest(data):
    return hashlib.sha256(data).hexdigest()


binary = ROOT / 'target/x86_64-pc-windows-gnu/release/wenilla-host.exe'
for required in [binary, ROOT / 'web/dist/wenilla_bg.wasm',
                 ROOT / 'web/dist/coop/pkg/azeroth_coop_bg.wasm',
                 ROOT / 'scripts/coop/node_modules/ws/index.js']:
    if not required.is_file():
        raise SystemExit(f'Missing build input: {required}')
node = fetch(f'https://nodejs.org/dist/v{NODE}/win-x64/node.exe')
if digest(node) != NODE_SHA256:
    raise SystemExit('Node runtime checksum mismatch')
license_text = fetch(f'https://raw.githubusercontent.com/nodejs/node/v{NODE}/LICENSE')

with tempfile.TemporaryDirectory(prefix='azeroth-windows-') as scratch:
    archive = Path(scratch) / 'windows.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for folder in ['web/dist', 'web/coop', 'scripts/coop']:
            for p in sorted((ROOT / folder).rglob('*')):
                if p.is_file() and p.suffix not in ['.gz', '.br', '.opt', '.pyc'] and '__pycache__' not in p.parts:
                    z.write(p, p.relative_to(ROOT).as_posix())
        z.write(binary, 'bin/win32-x64/wenilla-host.exe')
        z.writestr('runtime/node.exe', node)
        z.writestr('runtime/LICENSE-node.txt', license_text)
        for name in ['Host', 'Join', 'Configure']:
            z.write(ROOT / f'scripts/coop/windows/{name}.cmd', f'{name}.cmd')
        for p in ['docs/COOP.md', 'docs/WINDOWS-COOP.md', 'LICENSE-MIT', 'LICENSE-APACHE', 'Cargo.lock']:
            z.write(ROOT / p, p)
        z.write(ROOT / 'docs/WINDOWS-COOP.md', 'README.md')
        if (OUT / 'windows-test-results.md').is_file():
            z.write(OUT / 'windows-test-results.md', 'windows-test-results.md')
    # Outputs serves files up to 25 MB. The installer reconstructs this exact ZIP.
    parts = []
    with archive.open('rb') as stream:
        while block := stream.read(24_000_000):
            name = f'azeroth-windows.part{len(parts)+1:02d}'
            (OUT / name).write_bytes(block)
            parts.append((name, digest(block)))
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
    full_hash = digest(archive.read_bytes())
    checks = ','.join("@{name='%s';hash='%s'}" % pair for pair in parts)
    # No interpolated user text, credentials or network commands in this installer.
    ps = ("$ErrorActionPreference='Stop'; $dest=Join-Path (Get-Location) 'Azeroth-Coop-Windows'; "
          "if(Test-Path -LiteralPath $dest){throw 'Azeroth-Coop-Windows already exists. Use a fresh folder.'}; "
          f"$parts=@({checks}); "
          "foreach($part in $parts){if((Get-FileHash -LiteralPath $part.name -Algorithm SHA256).Hash -ne $part.hash){throw ('Checksum mismatch: '+$part.name)}}; "
          "$zip=Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString()+'.zip'); "
          "try {$zipStream=[IO.File]::Create($zip); try {foreach($part in $parts){$sourceStream=[IO.File]::OpenRead((Join-Path (Get-Location) $part.name)); try{$sourceStream.CopyTo($zipStream)}finally{$sourceStream.Dispose()}}}finally{$zipStream.Dispose()}; "
          f"if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne '{full_hash}'){{throw 'Combined ZIP checksum mismatch'}}; "
          "Expand-Archive -LiteralPath $zip -DestinationPath $dest; Write-Host 'Installed. Open Azeroth-Coop-Windows and double-click Host.cmd or Join.cmd.' "
          "}finally{if(Test-Path -LiteralPath $zip){Remove-Item -LiteralPath $zip}}")
    (OUT / 'Install-Azeroth.cmd').write_bytes((
        '@echo off\r\ncd /d "%~dp0"\r\npowershell.exe -NoLogo -NoProfile -Command "& { '+ps+' }"\r\n'
        'if errorlevel 1 echo Installation failed. Read the error above.\r\npause\r\n').encode('ascii'))

files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT).split(b'\0')
with zipfile.ZipFile(OUT / 'azeroth-coop-source.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name in sorted(set(files)):
        if name and (ROOT / os.fsdecode(name)).is_file():
            z.write(ROOT / os.fsdecode(name), 'azeroth-survivors-re/' + os.fsdecode(name))
(OUT / 'windows-readme.md').write_text((ROOT / 'docs/WINDOWS-COOP.md').read_text())
import json
manifest = {name: {'sha256': h, 'bytes': (OUT/name).stat().st_size} for name, h in parts}
manifest['combined_zip_sha256'] = full_hash
manifest['node_version'] = NODE
manifest['node_sha256'] = NODE_SHA256
(OUT / 'windows-checksums.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps(manifest, indent=2))
