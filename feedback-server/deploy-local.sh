#!/bin/sh
# Run on the authorized server after uploading this directory to /opt/ck-feedback.
set -eu
cd /opt/ck-feedback
python3 -m unittest -q test_server
id ck-feedback >/dev/null 2>&1 || useradd --system --home-dir /var/lib/ck-feedback --shell /usr/sbin/nologin ck-feedback
install -d -m 0700 -o ck-feedback -g ck-feedback /var/lib/ck-feedback
install -m 0644 ck-feedback.service /etc/systemd/system/ck-feedback.service
install -m 0644 ck-feedback-maintain.service /etc/systemd/system/ck-feedback-maintain.service
install -m 0644 ck-feedback-maintain.timer /etc/systemd/system/ck-feedback-maintain.timer
systemctl daemon-reload
systemctl enable --now ck-feedback.service ck-feedback-maintain.timer
systemctl restart ck-feedback.service
python3 - <<'PY'
from pathlib import Path
import subprocess, time, urllib.request
for attempt in range(20):
    try:
        urllib.request.urlopen('http://127.0.0.1:8793/ck-feedback/v1/health', timeout=2).read()
        break
    except Exception:
        time.sleep(.25)
else:
    raise RuntimeError('Feedback service did not start')
path = Path('/etc/ck-updates/Caddyfile')
old = path.read_text()
route = '''\n\thandle /ck-feedback/v1/* {
        request_body {
            max_size 512KiB
        }
        header Cache-Control "no-store"
        reverse_proxy 127.0.0.1:8793 {
            header_up X-CK-Peer {remote_host}
            transport http {
                dial_timeout 3s
                response_header_timeout 20s
            }
        }
    }
'''
if 'handle /ck-feedback/v1/*' not in old:
    updated = old.replace('ckswitch.site {', 'ckswitch.site {' + route, 1)
    if updated == old: raise RuntimeError('Expected site block missing')
    backup = path.with_name('Caddyfile.before-feedback-' + time.strftime('%Y%m%d%H%M%S'))
    backup.write_text(old)
    candidate = path.with_name('Caddyfile.feedback-candidate')
    candidate.write_text(updated)
    subprocess.run(['/opt/ck-updates/bin/caddy', 'validate', '--config', str(candidate), '--adapter', 'caddyfile'], check=True)
    path.write_text(updated)
    try:
        subprocess.run(['systemctl', 'reload', 'ck-updates'], check=True)
    except Exception:
        path.write_text(old)
        subprocess.run(['systemctl', 'reload', 'ck-updates'], check=True)
        raise
print('Feedback deployed; existing website and update routes preserved')
PY
