# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

# PyInstaller supplies SPECPATH; resolve the bundled source independently of
# the build's working directory or a developer's private wrapper installation.
wrapper = Path(SPECPATH) / 'crates' / 'mycli-desktop' / 'resources' / 'whisper_wrapper.py'

a = Analysis(
    [str(wrapper)],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='faster-whisper',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
