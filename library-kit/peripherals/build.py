"""Rebuild three importable CK packages offline with Python 3.9+ and Node.js."""
import argparse
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build import zip_tree
from check import check


def pack(output):
    output.mkdir(parents=True, exist_ok=False)
    subprocess.run(['node', str(HERE/'manifests.mjs'), str(output)], check=True)
    pins = json.loads((output/'upstream.json').read_text(encoding='utf-8'))
    for ident, drivers in pins.items():
        pkg = output/'packages'/ident
        for d in drivers:
            archive = HERE/'upstream'/d['archive']
            if hashlib.sha256(archive.read_bytes()).hexdigest() != d['sha256']:
                raise ValueError('Upstream archive hash mismatch: '+archive.name)
            with zipfile.ZipFile(archive) as z:
                for entry in z.infolist():
                    rel = PurePosixPath(entry.filename).relative_to(d['folder'])
                    if '..' in rel.parts or '\\' in entry.filename or ':' in entry.filename:
                        raise ValueError(entry.filename)
                    if not entry.is_dir():
                        dest = pkg/'libraries'/d['name']/rel
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        dest.write_bytes(z.read(entry))
            assert (pkg/'libraries'/d['name']/d['licenseFile']).is_file()
        version = json.loads((pkg/'library.json').read_text(encoding='utf-8'))['version']
        zip_tree(pkg, output/f'{ident}-{version}.zip')
    check(output)


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('output', type=Path, help='new directory')
    pack(cli.parse_args().output.resolve())
