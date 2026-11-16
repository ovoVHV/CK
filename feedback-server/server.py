"""CK anonymous compilation diagnostics; loopback only, behind Caddy HTTPS.

No client secret exists. Tickets bind the payload, installation and network;
proof of work and persistent quotas bound abuse. They do not attest a real build.
Only SSH administrators can list/export reports. No public read/delete endpoint.
"""
import argparse
import base64
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 512 * 1024
MAX_PAYLOAD = 280 * 1024
MAX_STORAGE = 256 * 1024 * 1024
RETENTION = 30 * 86400
MAX_RECEIPTS = 100000
PREFIX = '/ck-feedback/v1/'


class Rejected(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def canonical_id(value):
    if not isinstance(value, str) or len(value) != 36:
        raise Rejected(400, 'invalid_id')
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        raise Rejected(400, 'invalid_id')
    if parsed.version != 4 or str(parsed) != value:
        raise Rejected(400, 'invalid_id')
    return value


def exact_keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise Rejected(400, 'invalid_fields')


def decode_json(data):
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                raise Rejected(400, 'duplicate_key')
            out[key] = value
        return out
    try:
        return json.loads(data, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(Rejected(400, 'invalid_number')))
    except (ValueError, UnicodeError, RecursionError):
        raise Rejected(400, 'invalid_json')


class Store:
    def __init__(self, root, difficulty=18, clock=time.time):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        keyfile = self.root / 'ticket.key'
        try:
            fd = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, 'wb') as file:
                file.write(secrets.token_bytes(32))
        self.key = keyfile.read_bytes()
        if len(self.key) != 32:
            raise RuntimeError('Invalid feedback signing key')
        self.path = self.root / 'feedback.sqlite3'
        self.difficulty, self.clock = difficulty, clock
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS reports(
                  id TEXT PRIMARY KEY, digest TEXT NOT NULL, installation TEXT NOT NULL,
                  received INTEGER NOT NULL, payload BLOB);
                CREATE INDEX IF NOT EXISTS received_idx ON reports(received);
                CREATE TABLE IF NOT EXISTS quotas(
                  key TEXT NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL,
                  PRIMARY KEY(key, bucket));
            ''')
        if os.name != 'nt':
            os.chmod(self.path, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            db.execute('PRAGMA busy_timeout=5000')
            db.execute('PRAGMA secure_delete=ON')
            with db:
                yield db
        finally:
            db.close()

    def identity(self, text):
        return hmac.new(self.key, text.encode(), hashlib.sha256).hexdigest()

    def peer(self, text):
        try:
            address = ipaddress.ip_address(text)
        except ValueError:
            raise Rejected(400, 'invalid_peer')
        if isinstance(address, ipaddress.IPv6Address):
            address = ipaddress.ip_network(f'{address}/64', strict=False).network_address
        return self.identity('ip:' + str(address))

    def cleanup(self, db, now):
        # Keep small receipt tombstones: expired payloads must never be re-created.
        db.execute('UPDATE reports SET payload=NULL WHERE received<? AND payload IS NOT NULL', (now - RETENTION,))
        db.execute('DELETE FROM quotas WHERE bucket<?', (now - 2 * 86400,))

    def consume(self, db, rules, now):
        for key, period, limit in rules:
            bucket = now // period * period
            row = db.execute('SELECT count FROM quotas WHERE key=? AND bucket=?', (key, bucket)).fetchone()
            if row and row[0] >= limit:
                raise Rejected(429, 'rate_limit')
            db.execute('INSERT INTO quotas VALUES(?,?,1) ON CONFLICT(key,bucket) DO UPDATE SET count=count+1', (key, bucket))

    @staticmethod
    def receipt(report_id, received):
        stamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(received))
        return {'reportId': report_id, 'receivedAt': stamp}

    def prior(self, db, report_id, digest, install):
        row = db.execute('SELECT digest,installation,received FROM reports WHERE id=?', (report_id,)).fetchone()
        if not row:
            return None
        if not hmac.compare_digest(row[0], digest) or not hmac.compare_digest(row[1], install):
            raise Rejected(409, 'report_already_exists')
        return self.receipt(report_id, row[2])

    def ingress(self, peer):
        """Bound every HTTP attempt, including malformed payloads and duplicate retries."""
        ip, now = self.peer(peer), int(self.clock())
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self.cleanup(db, now)
            self.consume(db, [('ingress:global', 60, 180), ('ingress:' + ip, 60, 30)], now)

    def challenge(self, request, peer):
        exact_keys(request, ['reportId', 'digest', 'installationId'])
        report_id = canonical_id(request['reportId'])
        installation = self.identity('install:' + canonical_id(request['installationId']))
        digest = request['digest']
        if not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest):
            raise Rejected(400, 'invalid_digest')
        ip, now = self.peer(peer), int(self.clock())
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self.cleanup(db, now)
            prior = self.prior(db, report_id, digest, installation)
            if prior:
                return {'receipt': prior}
            self.consume(db, [('challenge:global', 3600, 600), ('challenge:ip:' + ip, 3600, 30),
                              ('challenge:install:' + installation, 3600, 15)], now)
        ticket = {'id': report_id, 'digest': digest, 'install': installation,
                  'ip': ip, 'exp': now + 600, 'difficulty': self.difficulty, 'nonce': secrets.token_hex(12)}
        encoded = base64.urlsafe_b64encode(json.dumps(ticket, separators=(',', ':')).encode()).decode().rstrip('=')
        signature = hmac.new(self.key, encoded.encode(), hashlib.sha256).hexdigest()
        return {'ticket': encoded + '.' + signature, 'difficulty': self.difficulty, 'expiresIn': 600}

    def validate_ticket(self, ticket, nonce, peer):
        if not isinstance(ticket, str) or len(ticket) > 2048 or ticket.count('.') != 1:
            raise Rejected(400, 'invalid_ticket')
        encoded, signature = ticket.split('.')
        expected = hmac.new(self.key, encoded.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise Rejected(403, 'invalid_ticket')
        try:
            claims = decode_json(base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True))
        except (ValueError, UnicodeError):
            raise Rejected(403, 'invalid_ticket')
        if claims['exp'] < int(self.clock()) or not hmac.compare_digest(claims['ip'], self.peer(peer)):
            raise Rejected(403, 'expired_or_changed_network')
        if type(nonce) is not int or not 0 <= nonce < 2 ** 53:
            raise Rejected(400, 'invalid_work')
        work = hashlib.sha256(f'{ticket}:{nonce}'.encode()).digest()
        if int.from_bytes(work[:4], 'big') >> (32 - claims['difficulty']) != 0:
            raise Rejected(403, 'invalid_work')
        return claims

    def validate_payload(self, payload, claims):
        if not isinstance(payload, str) or len(payload.encode()) > MAX_PAYLOAD:
            raise Rejected(413, 'payload_too_large')
        if not hmac.compare_digest(hashlib.sha256(payload.encode()).hexdigest(), claims['digest']):
            raise Rejected(403, 'payload_digest_mismatch')
        report = decode_json(payload)
        exact_keys(report, ['schema', 'reportId', 'appVersion', 'createdAt', 'fqbn', 'outcome',
                            'elapsedMs', 'logicalCpus', 'os', 'arch', 'omittedLines', 'log'])
        if type(report['schema']) is not int or report['schema'] != 1 or canonical_id(report['reportId']) != claims['id']:
            raise Rejected(400, 'invalid_schema')
        for key, maximum in [('appVersion', 64), ('createdAt', 40), ('fqbn', 512), ('os', 24), ('arch', 24), ('log', 240 * 1024)]:
            if not isinstance(report[key], str) or len(report[key].encode()) > maximum:
                raise Rejected(400, 'invalid_' + key)
        if not re.fullmatch(r'[0-9A-Za-z_.+-]+', report['appVersion']) or not re.fullmatch(r'[0-9A-Za-z_:,=.+-]+', report['fqbn']):
            raise Rejected(400, 'invalid_metadata')
        if report['outcome'] not in ('success', 'failed-or-cancelled'):
            raise Rejected(400, 'invalid_outcome')
        for key, maximum in [('elapsedMs', 7 * 86400 * 1000), ('logicalCpus', 4096), ('omittedLines', 100000000)]:
            if type(report[key]) is not int or not 0 <= report[key] <= maximum:
                raise Rejected(400, 'invalid_' + key)
        # Recheck that no raw source/command/serial lines were sent by an old client.
        allowed = re.compile(r'^\[(?:Timing[^\]]*|V9|INFO|信息|DIAG|WARN|ERROR|NativeGraph[^\]]*)\]')
        if any(line and (not allowed.match(line) or len(line) > 4096) for line in report['log'].splitlines()):
            raise Rejected(400, 'non_diagnostic_log')
        return payload.encode()

    def submit(self, request, peer):
        exact_keys(request, ['ticket', 'nonce', 'payload'])
        claims = self.validate_ticket(request['ticket'], request['nonce'], peer)
        payload = self.validate_payload(request['payload'], claims)
        now = int(self.clock())
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self.cleanup(db, now)
            prior = self.prior(db, claims['id'], claims['digest'], claims['install'])
            if prior:
                return {'receipt': prior}
            self.consume(db, [('report:global', 3600, 60), ('report:global-day', 86400, 300),
                              ('report:ip:' + claims['ip'], 3600, 10), ('report:ip-day:' + claims['ip'], 86400, 40),
                              ('report:install:' + claims['install'], 3600, 6), ('report:install-day:' + claims['install'], 86400, 20)], now)
            used, count = db.execute('SELECT COALESCE(SUM(LENGTH(payload)),0), COUNT(*) FROM reports').fetchone()
            if used + len(payload) > MAX_STORAGE or count >= MAX_RECEIPTS:
                raise Rejected(503, 'storage_limit')
            db.execute('INSERT INTO reports VALUES(?,?,?,?,?)', (claims['id'], claims['digest'], claims['install'], now, payload))
        return {'receipt': self.receipt(claims['id'], now)}


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16
    def __init__(self, address, store):
        self.store = store
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(address, Handler)
    def process_request(self, request, address):
        if not self.slots.acquire(False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise
    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    server_version = 'CKFeedback/1'
    sys_version = ''
    def log_message(self, *_):
        pass  # Never log bodies, tickets, identifiers or IP addresses.
    def setup(self):
        super().setup()
        self.connection.settimeout(12)
    def reply(self, status, data):
        encoded = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Connection', 'close')
        if status == 429:
            self.send_header('Retry-After', '3600')
        self.end_headers()
        self.wfile.write(encoded)
    def do_GET(self):
        self.reply(200 if self.path == PREFIX + 'health' else 404,
                   {'service': 'ck-compile-feedback', 'schema': 1} if self.path == PREFIX + 'health' else {'error': 'not_found'})
    def do_POST(self):
        try:
            # Caddy overwrites this header from the actual remote peer. Loopback
            # listener prevents direct Internet clients spoofing it.
            peer = self.headers.get('X-CK-Peer', '')
            self.server.store.ingress(peer)
            if self.path not in (PREFIX + 'challenge', PREFIX + 'reports'):
                raise Rejected(404, 'not_found')
            if self.headers.get('Transfer-Encoding') or self.headers.get_content_type() != 'application/json':
                raise Rejected(415, 'json_required')
            lengths = self.headers.get_all('Content-Length', [])
            if len(lengths) != 1 or not lengths[0].isdigit():
                raise Rejected(411, 'length_required')
            length = int(lengths[0])
            if not 0 < length <= MAX_BODY or (self.path.endswith('/challenge') and length > 1024):
                raise Rejected(413, 'body_too_large')
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise Rejected(400, 'incomplete_body')
            request = decode_json(raw)
            action = self.server.store.challenge if self.path.endswith('/challenge') else self.server.store.submit
            self.reply(200, action(request, peer))
        except Rejected as error:
            self.reply(error.status, {'error': error.code})
        except (TimeoutError, ConnectionError):
            self.close_connection = True
        except Exception:
            self.reply(503, {'error': 'temporarily_unavailable'})


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', default='/var/lib/ck-feedback')
    parser.add_argument('--port', type=int, default=8793)
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--export', metavar='REPORT_ID')
    parser.add_argument('--maintain', action='store_true')
    args = parser.parse_args()
    store = Store(args.data)
    if args.list or args.export or args.maintain:
        with store.connect() as db:
            store.cleanup(db, int(time.time()))
            if args.export:
                row = db.execute('SELECT payload FROM reports WHERE id=?', (canonical_id(args.export),)).fetchone()
                if not row or row[0] is None:
                    raise SystemExit('Report not found or payload expired')
                print(json.dumps(decode_json(row[0]), ensure_ascii=False, indent=2))
            elif args.list:
                rows = db.execute('SELECT id,received,LENGTH(payload) FROM reports ORDER BY received DESC LIMIT 100').fetchall()
                print(json.dumps([{'reportId': r[0], 'receivedAt': store.receipt(r[0], r[1])['receivedAt'], 'bytes': r[2] or 0} for r in rows], indent=2))
        return
    Server(('127.0.0.1', args.port), store).serve_forever()


if __name__ == '__main__':
    main()
