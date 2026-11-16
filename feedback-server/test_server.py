import concurrent.futures
import hashlib
import http.client
import json
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch
from server import Store, Server, Rejected, decode_json, MAX_BODY, RETENTION, PREFIX


class FeedbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.now = 1800000000
        self.store = Store(self.temp.name, difficulty=12, clock=lambda: self.now)
        self.install = str(uuid.uuid4())
        self.peer = '203.0.113.1'
    def tearDown(self):
        self.temp.cleanup()
    def payload(self, **updates):
        report = dict(schema=1, reportId=str(uuid.uuid4()), appVersion='9.1.0-alpha.47',
                      createdAt='2026-11-16T00:00:00Z', fqbn='esp32:esp32:esp32s3',
                      outcome='success', elapsedMs=32001, logicalCpus=16, os='windows',
                      arch='x86_64', omittedLines=3, log='[V9] Compile GCC=1\n[Timing] link=7.5s')
        report.update(updates)
        return json.dumps(report, ensure_ascii=False, separators=(',', ':'))
    def challenge(self, payload, install=None):
        return self.store.challenge(dict(reportId=json.loads(payload)['reportId'],
            digest=hashlib.sha256(payload.encode()).hexdigest(), installationId=install or self.install), self.peer)
    def request(self, payload=None):
        payload = payload or self.payload()
        ticket = self.challenge(payload)['ticket']
        nonce = 0
        while int.from_bytes(hashlib.sha256(f'{ticket}:{nonce}'.encode()).digest()[:4], 'big') >> 20:
            nonce += 1
        return dict(ticket=ticket, nonce=nonce, payload=payload)
    def rejected(self, status, action):
        with self.assertRaises(Rejected) as raised:
            action()
        self.assertEqual(raised.exception.status, status)
    def test_success_duplicate_retry_and_restart_return_same_receipt(self):
        request = self.request()
        result = self.store.submit(request, self.peer)
        self.assertEqual(self.store.submit(request, self.peer), result)
        self.assertEqual(self.challenge(request['payload']), result)
        restarted = Store(self.temp.name, 12, lambda: self.now)
        self.assertEqual(restarted.submit(request, self.peer), result)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM reports').fetchone()[0], 1)
    def test_concurrent_submission_is_atomic(self):
        request = self.request()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.store.submit(request, self.peer), range(8)))
        self.assertTrue(all(r == results[0] for r in results))
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM reports').fetchone()[0], 1)
    def test_different_payload_or_installation_cannot_reuse_report(self):
        request = self.request()
        self.store.submit(request, self.peer)
        changed = json.loads(request['payload']); changed['elapsedMs'] += 1
        self.rejected(409, lambda: self.challenge(json.dumps(changed)))
        self.rejected(409, lambda: self.challenge(request['payload'], str(uuid.uuid4())))
    def test_ticket_tampering_and_changed_ip_rejected(self):
        request = self.request()
        bad = dict(request, ticket=request['ticket'][:-1] + ('0' if request['ticket'][-1] != '0' else '1'))
        self.rejected(403, lambda: self.store.submit(bad, self.peer))
        self.rejected(403, lambda: self.store.submit(request, '203.0.113.2'))
    def test_expiry(self):
        request = self.request(); self.now += 601
        self.rejected(403, lambda: self.store.submit(request, self.peer))
    def test_proof_required_and_payload_bound(self):
        request = self.request()
        bad = dict(request, payload=request['payload'] + ' ')
        self.rejected(403, lambda: self.store.submit(bad, self.peer))
        self.rejected(400, lambda: self.store.submit(dict(request, nonce=-1), self.peer))
        nonce = request['nonce'] + 1
        while int.from_bytes(hashlib.sha256(f"{request['ticket']}:{nonce}".encode()).digest()[:4], 'big') >> 20 == 0:
            nonce += 1
        self.rejected(403, lambda: self.store.submit(dict(request, nonce=nonce), self.peer))
    def test_six_reports_per_installation_per_hour(self):
        for _ in range(6):
            self.store.submit(self.request(), self.peer)
        self.rejected(429, lambda: self.store.submit(self.request(), self.peer))
        self.now += 3600
        self.store.submit(self.request(), self.peer)
    def test_retention_keeps_tombstone(self):
        request = self.request(); receipt = self.store.submit(request, self.peer)
        self.now += RETENTION + 1
        self.assertEqual(self.challenge(request['payload']), receipt)
        with self.store.connect() as db:
            self.assertIsNone(db.execute('SELECT payload FROM reports').fetchone()[0])
    def test_storage_cap_fails_closed(self):
        request = self.request()
        with patch('server.MAX_STORAGE', 1):
            self.rejected(503, lambda: self.store.submit(request, self.peer))
        self.store.submit(request, self.peer)
    def test_raw_source_unknown_fields_and_bad_types_rejected(self):
        for updates in [dict(log='void setup() {}'), dict(source='private'), dict(elapsedMs=True), dict(fqbn='../etc/passwd')]:
            request = self.request(self.payload(**updates))
            self.rejected(400, lambda: self.store.submit(request, self.peer))
    def test_json_duplicates_and_nan_rejected(self):
        self.rejected(400, lambda: decode_json('{"a":1,"a":2}'))
        self.rejected(400, lambda: decode_json('{"a":NaN}'))
    def test_ingress_rate_limits_even_malformed_retries(self):
        for _ in range(30): self.store.ingress(self.peer)
        self.rejected(429, lambda: self.store.ingress(self.peer))
    def test_ipv6_networks_share_quota(self):
        self.assertEqual(self.store.peer('2001:db8:1:2::1'), self.store.peer('2001:db8:1:2::aabb'))
    def test_http_limits_and_no_public_read(self):
        server = Server(('127.0.0.1', 0), self.store)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            def request(method, path, body=None, headers=None):
                client = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=5)
                client.request(method, path, body, headers or {})
                response = client.getresponse(); status, data = response.status, response.read(); client.close()
                return status, data
            self.assertEqual(request('GET', PREFIX + 'health')[0], 200)
            self.assertEqual(request('GET', PREFIX + 'reports')[0], 404)
            headers = {'X-CK-Peer': self.peer, 'Content-Type': 'application/json'}
            self.assertEqual(request('POST', PREFIX + 'challenge', '{}', headers)[0], 400)
            self.assertEqual(request('POST', PREFIX + 'reports', 'x', {**headers, 'Content-Length': str(MAX_BODY + 1)})[0], 413)
            self.assertEqual(request('POST', PREFIX + 'challenge', '{}', {'Content-Type': 'application/json'})[0], 400)
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__': unittest.main(verbosity=2)
