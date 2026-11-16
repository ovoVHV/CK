from pathlib import Path
import hashlib,json,tarfile,sys
root=Path(__file__).resolve().parent
dist=root/'dist'
rows=[]
for p in sorted(dist.rglob('*')):
    if p.is_file() and p.name!='site-sha256.json':
        rows.append({'path':p.relative_to(dist).as_posix(),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(dist/'site-sha256.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
output_dir=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else root.parent/'local/alpha30-evidence'
output_dir.mkdir(parents=True,exist_ok=True)
out=output_dir/'ck-lab-site.tar.gz'
with tarfile.open(out,'w:gz') as tar:
    for p in sorted(dist.rglob('*')):
        if p.is_file():tar.add(p,arcname=p.relative_to(dist).as_posix(),recursive=False)
record={'archive':str(out),'bytes':out.stat().st_size,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'files':len(rows)}
(out.parent/'site-package.json').write_text(json.dumps(record,indent=2),encoding='utf-8')
print(json.dumps(record))
