"""Run on the existing CK server after uploading the checked static archive.

Preserves the updater route and prior site/configuration for rollback.
"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, sys, tarfile

archive=Path(sys.argv[1])
expected=sys.argv[2]
assert hashlib.sha256(archive.read_bytes()).hexdigest()==expected
site=Path('/srv/ck-lab')
generation='site-'+expected[:16]
target=site/'releases'/generation
target.mkdir(parents=True,exist_ok=True)
with tarfile.open(archive) as tar:
    for member in tar.getmembers():
        path=Path(member.name)
        assert not path.is_absolute() and '..' not in path.parts
        assert member.isfile() or member.isdir()
    for member in tar.getmembers():
        path=target/member.name
        if member.isdir():path.mkdir(parents=True,exist_ok=True)
        else:
            path.parent.mkdir(parents=True,exist_ok=True)
            with tar.extractfile(member) as source, path.open('wb') as output:
                shutil.copyfileobj(source,output)
manifest=json.loads((target/'site-sha256.json').read_text())
for row in manifest:
    path=target/row['path']
    assert path.is_file() and path.stat().st_size==row['bytes']
    assert hashlib.sha256(path.read_bytes()).hexdigest()==row['sha256']
for path in [target,*target.rglob('*')]:os.chmod(path,0o755 if path.is_dir() else 0o644)
config=Path('/etc/ck-updates/Caddyfile')
prior=config.read_text()
before=hashlib.sha256(Path('/srv/ck-updates/preview/windows-x86_64/latest.json').read_bytes()).hexdigest()
backup=config.with_name('Caddyfile.before-'+generation)
if not backup.exists():shutil.copyfile(config,backup)
old='\thandle {\n\t\trespond "CK update service" 200\n\t}'
new='''\thandle {
        root * /srv/ck-lab/current
        encode zstd gzip
        header X-Content-Type-Options nosniff
        header Referrer-Policy strict-origin-when-cross-origin
        header X-Frame-Options SAMEORIGIN
        header Cache-Control "no-cache"
        file_server
    }'''
if old in prior:updated=prior.replace(old,new,1)
else:
    assert 'root * /srv/ck-lab/current' in prior, 'Unknown existing website routing; inspect before replacing'
    updated=prior
if '@driverArchive path /downloads/drivers/*.zip /downloads/drivers/*.ZIP' not in updated:
    marker='        header Cache-Control "no-cache"\n        file_server'
    assert marker in updated, 'Unknown website header block; inspect before updating'
    updated=updated.replace(marker, '        header Cache-Control "no-cache"\n        @driverArchive path /downloads/drivers/*.zip /downloads/drivers/*.ZIP\n        header @driverArchive Content-Disposition "attachment"\n        file_server', 1)
pending=config.with_name('Caddyfile.'+generation)
pending.write_text(updated)
subprocess.run(['/opt/ck-updates/bin/caddy','validate','--config',str(pending),'--adapter','caddyfile'],check=True)
current=site/'current';previous=os.readlink(current) if current.is_symlink() else None
assert not current.exists() or current.is_symlink(), 'Refuse replacing an unmanaged site directory'
switch=site/('current-'+generation)
if switch.is_symlink():switch.unlink()
switch.symlink_to(target,target_is_directory=True)
os.replace(switch,current)
try:
    os.replace(pending,config)
    subprocess.run(['systemctl','reload','ck-updates'],check=True)
    subprocess.run(['systemctl','is-active','--quiet','ck-updates'],check=True)
except Exception:
    shutil.copyfile(backup,config)
    if previous:
        switch.symlink_to(previous,target_is_directory=True);os.replace(switch,current)
    subprocess.run(['systemctl','reload','ck-updates'])
    raise
after=hashlib.sha256(Path('/srv/ck-updates/preview/windows-x86_64/latest.json').read_bytes()).hexdigest()
assert before==after,'Updater manifest unexpectedly changed'
record={'site':str(target),'files':len(manifest),'updaterUnchanged':True,'previous':previous,'configBackup':str(backup)}
(site/(generation+'.json')).write_text(json.dumps(record,indent=2))
print(json.dumps(record))
