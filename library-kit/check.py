"""Offline, structural checks for the batch kit. Never builds or flashes firmware."""
import argparse
import json
import re
import zipfile
from pathlib import Path


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def require(test, message):
    if not test:
        raise ValueError(message)


def all_blocks(node):
    if not isinstance(node, dict):
        return
    yield node
    for item in node.get("inputs", {}).values():
        yield from all_blocks(item.get("block") or item.get("shadow"))
    yield from all_blocks(node.get("next", {}).get("block"))


def check(root):
    types, ids = set(), set()
    dirs = sorted(p for p in (root/"packages").iterdir() if p.is_dir())
    require(dirs, "packages/ is empty")
    for p in dirs:
        lib, spec = read(p/"library.json"), read(p/"ck-blocks.json")
        ident = lib["id"]
        require(ident == p.name == spec["id"] and ident not in ids, "duplicate or inconsistent id: "+ident)
        ids.add(ident)
        entries = spec["entrypoints"]
        for v in [*entries.values(), spec["license"]["file"]]:
            require((p/v).resolve().is_relative_to(p.resolve()) and (p/v).is_file(), "invalid entrypoint/license: "+v)
        definitions = read(p/entries["blocks"])
        rules = read(p/entries["generator"])["rules"]
        keys = {b["type"] for b in definitions}
        require(len(keys) == len(definitions) and not keys.intersection(types), "duplicate type")
        require(all(k.startswith(ident+"_") for k in keys), "type must use the package prefix")
        types.update(keys)
        for group in [rules, spec["blocks"], read(p/entries["toolbox"])["contents"]]:
            require(len(group)==len(keys) and {b["type"] for b in group}==keys, "inconsistent blocks/rules/toolbox")
        for d in (p/"libraries").iterdir():
            require(d.is_dir() and (d/"library.properties").is_file(), "Arduino library folder missing: "+str(d))
            require(any(f.is_file() and f.suffix.lower() in [".h",".hpp"] for f in d.rglob("*")), "missing headers")
        x = read(p/"examples/expected.json")
        require(bool(re.fullmatch(r"[A-Z][A-Z0-9_]*",x["errorCode"])), "invalid error code")
        for label, value in [("positive", x["repair"]),("negative", x["invalid"])]:
            f=(p/"examples"/x[label]).resolve()
            require(f.is_relative_to((p/"examples").resolve()) and f.suffix==".ck", "invalid example path")
            proj=read(f)
            require(proj["board"]==x["board"],"example FQBN mismatch")
            top=json.loads(proj["xml"])["blocks"]["blocks"]
            hits=[b for h in top for b in all_blocks(h) if b.get("id")==x["blockId"]]
            require(len(hits)==1 and hits[0]["type"] in keys, "expected diagnostic block missing")
            slot=hits[0]["inputs"][x["input"]]
            require((slot.get("block") or slot["shadow"])["fields"]["NUM"]==value, "unexpected fixture value")
        files={f.relative_to(p).as_posix(): f for f in p.rglob("*") if f.is_file()}
        require(not any(Path(f).name==".ck-quality-report.json" for f in files),"authors must not supply desktop quality reports")
        with zipfile.ZipFile(root/f"{ident}-{lib['version']}.zip") as z:
            names=z.namelist()
            require(len(names)==len(set(names)) and set(names)==set(files), "ZIP contents or ZIP root differ")
            require(all(z.read(k)==v.read_bytes() for k,v in files.items()),"ZIP does not match sources")
        print(f"OK {ident}: {len(keys)} blocks, ZIP and positive/negative fixtures match")
    print("Structure only. Compile normal, incorrect and repaired builds in CK separately.")


if __name__=="__main__":
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("output",type=Path)
    check(ap.parse_args().output.resolve())
