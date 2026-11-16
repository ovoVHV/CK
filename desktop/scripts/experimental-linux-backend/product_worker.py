#!/usr/bin/env python3
"""Opt-in CK product transport, not a fixture runner or a board resolver.

Consumes the desktop's actual request and selected libraries. The installed Linux
SDK is verified before use; only official CLI recipes determine the build. No
network installation, provider substitution, or cross-host object reuse occurs.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time

from process_tree import enable_subreaper, terminate_children, cleanup_children

HELPER_SHA256 = 'e0274780fe1cc088e852c3df8c379ecede02d26422544384a470de761da47b21'


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def safe_relative(value):
    p = PurePosixPath(value)
    if not value or p.is_absolute() or '..' in p.parts or '\\' in value or ':' in value:
        raise ValueError('Unsafe request file path')
    return p


def properties(lines):
    return dict(line.split('=', 1) for line in lines if '=' in line)


def core_inventory(root):
    root = Path(root)
    files = []

    def visit(directory):
        with os.scandir(directory) as entries:
            for item in entries:
                if item.name in ('.git', '__pycache__', 'installed.json') or item.name.endswith('.pyc'):
                    continue
                if item.is_symlink():
                    raise ValueError('Linked Core/SDK input is not qualified: ' + item.path)
                if item.is_dir(follow_symlinks=False):
                    visit(item.path)
                elif item.is_file(follow_symlinks=False):
                    files.append(Path(item.path))
    visit(root)
    files.sort()
    # Keep hashing sequential on the Linux worker: the measured Python thread
    # pool regressed thousands of small files. The complete SHA256 boundary
    # remains unchanged; scandir only avoids redundant metadata queries.
    return {p.relative_to(root).as_posix(): digest(p) for p in files}


def validate_request(request):
    if request.get('protocol') != 1 or request.get('coreVersion') != '3.3.6':
        raise ValueError('Unsupported worker protocol/Core')
    if not isinstance(request.get('fqbn'), str) or not request['fqbn'].startswith('esp32:esp32:esp32:'):
        raise ValueError('This opt-in worker is qualified only for classic ESP32 exact targets')
    if not 1 <= request.get('jobs', 0) <= 8 or not 1 <= request.get('timeoutSeconds', 0) <= 600:
        raise ValueError('Invalid build limits')
    for key in ('requestId', 'cacheKey', 'sourceSha256'):
        if len(request.get(key, '')) != 64 or any(c not in '0123456789abcdef' for c in request[key]):
            raise ValueError('Invalid request identity')
    for name in request.get('files', {}):
        safe_relative(name)
    return request


def main(stage):
    started = time.monotonic()
    request = validate_request(json.loads((stage / 'request.json').read_text()))
    root = Path(request['workerRoot']).resolve()
    if not root.is_absolute() or not (root / 'bin/arduino-cli').is_file():
        raise ValueError('Installed worker runtime unavailable')
    receipt = dict(protocol=1, requestId=request['requestId'], fqbn=request['fqbn'],
                   sourceSha256=request['sourceSha256'], buildSignature=request['buildSignature'],
                   success=False, fallbackAllowed=True, compileStarted=False,
                   backend='linux-official-cli', coreVersion=request['coreVersion'])
    export = stage / 'export'
    export.mkdir()
    cancelled = False
    timed_out = False
    cleanup = None
    proc = None
    last_heartbeat = time.monotonic()
    phase_at = started
    phases = {}

    def phase(name):
        nonlocal phase_at
        now = time.monotonic()
        phases[name] = round((now - phase_at) * 1000)
        phase_at = now

    def watch_host():
        nonlocal cancelled, last_heartbeat
        # A daemon thread must not hold Python's buffered stdin lock while the
        # interpreter finalizes after a successful build.
        while os.read(sys.stdin.fileno(), 1):
            last_heartbeat = time.monotonic()
        cancelled = True
        terminate_children()

    def cancel(_signal, _frame):
        nonlocal cancelled
        cancelled = True
        terminate_children()

    def check_cancel():
        if cancelled or (stage / 'cancel').exists() or time.monotonic() - last_heartbeat > 15:
            raise InterruptedError('CK_BUILD_CANCELED: build cancelled by user')

    def event(message):
        print('[LinuxBackend] ' + message, flush=True)

    enable_subreaper()
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    threading.Thread(target=watch_host, daemon=True).start()
    try:
        check_cancel()
        platform = root / 'data/packages/esp32/hardware/esp32/3.3.6'
        if core_inventory(platform) != request['coreFiles']:
            raise ValueError('Installed Linux Core content differs from the requested host Core')
        sdk = root / 'data/packages/esp32/tools/esp32-libs/3.3.6'
        if core_inventory(sdk) != request['sdkFiles']:
            raise ValueError('Installed Linux SDK content differs from the requested host SDK')
        compiler = root / 'data/packages/esp32/tools/esp-x32/2511/bin/xtensa-esp32-elf-g++'
        version = subprocess.check_output([str(compiler), '--version'], text=True, timeout=5).splitlines()[0]
        if version.split(' ', 1)[1] != request['compilerVersion']:
            raise ValueError('Host and worker compiler releases differ')
        helper = root / 'bin/ck-compile-through'
        if digest(helper) != HELPER_SHA256:
            raise ValueError('Compile-through helper is not the qualified executable')
        # A Core recipe override could alter semantics; do not silently ignore it.
        if (platform / 'platform.local.txt').exists() or (platform / 'boards.local.txt').exists():
            raise ValueError('Local Core recipe overrides require separate qualification')
        phase('preflightMs')
        work = root / 'product-builds' / request['cacheKey']
        work.mkdir(parents=True, exist_ok=True)
        with (work / 'worker.lock').open('a') as lock:
            deadline = time.monotonic() + request['timeoutSeconds']
            while True:
                check_cancel()
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Worker build lock timed out')
                    time.sleep(0.1)
            phase('lockWaitMs')
            build = work / 'build'
            source = work / 'source/sketch'
            source.mkdir(parents=True, exist_ok=True)
            user = work / 'user'
            (user / 'libraries').mkdir(parents=True, exist_ok=True)
            # The archive carries only files hashed by the desktop. Extract
            # members individually; never trust tar links or filesystem paths.
            seen = set()
            with tarfile.open(stage / 'inputs.tar', 'r:') as archive:
                for member in archive:
                    name = safe_relative(member.name).as_posix()
                    if not member.isfile() or name not in request['files'] or name in seen:
                        raise ValueError('Unexpected or duplicate library/source archive member')
                    content = archive.extractfile(member).read()
                    if hashlib.sha256(content).hexdigest() != request['files'][name]:
                        raise ValueError('Source/library transport hash mismatch: ' + name)
                    destination = work / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if not destination.exists() or destination.read_bytes() != content:
                        destination.write_bytes(content)
                    seen.add(name)
            if seen != set(request['files']):
                raise ValueError('Incomplete request archive')
            sketch = source / 'sketch.ino'
            if digest(sketch) != request['sourceSha256']:
                raise ValueError('Sketch identity mismatch')
            cache = work / 'same-build-objects'
            # Reuse is limited to one discovery/compile transaction.
            if cache.exists():
                shutil.rmtree(cache)
            if request['clean'] or not (work / 'success.json').exists():
                if build.exists():
                    shutil.rmtree(build)
            (work / 'success.json').unlink(missing_ok=True)
            config = work / 'arduino-cli.yaml'
            config.write_text(json.dumps(dict(directories=dict(data=str(root / 'data'),
                downloads=str(root / 'downloads'), user=str(user)),
                build_cache=dict(compilations_before_purge=0, ttl='87600h'))))
            platform_props = properties((platform / 'platform.txt').read_text().splitlines())
            if 'build.library_discovery_phase' in platform_props:
                raise ValueError('Unsupported discovery-specific Core semantics')
            cpp = platform_props['recipe.cpp.o.pattern']
            scan = cpp.replace('{compiler.cpp.flags}', '{compiler.cpp.flags} {preproc.macros.flags}')
            scan = scan.replace('{object_file}', '{preprocessed_file_path}')
            argv = [str(root / 'bin/arduino-cli'), 'compile', '--config-file', str(config),
                    '--fqbn', request['fqbn'], '--build-path', str(build), '--jobs', str(request['jobs']),
                    '--verbose', '--json', '--discovery-timeout', '100ms']
            for key, value in [
                ('recipe.preproc.macros', f'"{helper}" scan "{cache}" -- {scan}'),
                ('recipe.cpp.o.pattern', f'"{helper}" compile "{cache}" -- {cpp}'),
                ('build.extra_flags', platform_props['build.extra_flags'].replace('{runtime.os}', 'windows')),
                ('tools.esptool_py.path', str(root / 'module-esptool')),
            ]:
                argv += ['--build-property', key + '=' + value]
            # Preserve explicit production resolver priority. Do not fall back
            # to the lab sketchbook (which contains unrelated test libraries).
            for library in request['libraries']:
                argv += ['--library', str(work / safe_relative(library))]
            argv.append(str(source))
            env = dict(os.environ, ARDUINO_BUILD_CACHE_PATH=str(work / 'cli-cache'))
            env.pop('SOURCE_DATE_EPOCH', None)
            if request.get('sourceDateEpoch') is not None:
                env['SOURCE_DATE_EPOCH'] = request['sourceDateEpoch']
            check_cancel()
            phase('synchronizeMs')
            receipt.update(compileStarted=True, fallbackAllowed=False, argv=argv,
                           remoteSource=str(sketch), remoteBuild=str(build))
            event('Compiling actual CK request; full debug information and official optimization retained')
            compile_at = time.monotonic()
            with (stage / 'cli.json').open('wb') as stdout, (stage / 'cli.stderr').open('wb') as stderr:
                proc = subprocess.Popen(argv, cwd=work, env=env, stdout=stdout, stderr=stderr,
                                        start_new_session=True)
                while proc.poll() is None:
                    if cancelled or (stage / 'cancel').exists() or time.monotonic() - last_heartbeat > 15:
                        cancelled = True
                        terminate_children()
                    if time.monotonic() - compile_at > request['timeoutSeconds']:
                        timed_out = True
                        terminate_children()
                    time.sleep(0.1)
                status = proc.wait()
            cleanup = cleanup_children()
            receipt.update(exitCode=status, compileMs=round((time.monotonic() - compile_at) * 1000),
                           processCleanup=cleanup, timedOut=timed_out, cancelled=cancelled)
            phase('compileAndCleanupMs')
            check_cancel()
            if timed_out or cleanup['remainingChildren']:
                raise RuntimeError('Build timeout or compiler cleanup failure')
            result = json.loads((stage / 'cli.json').read_text())
            raw_log = result.get('compiler_out', '') + result.get('compiler_err', '')
            (export / 'compile.log').write_text(raw_log)
            if status != 0 or result.get('success') is not True:
                raise RuntimeError(raw_log[-65536:] or str(result.get('error', 'Compiler failed')))
            props = properties(result['builder_result']['build_properties'])
            for key, expected in request['resolvedIdentity'].items():
                if props.get(key) != expected:
                    raise ValueError('Resolved identity differs after compilation: ' + key)
            receipt['resolvedProperties'] = {key: props[key] for key in request['resolvedIdentity']}
            receipt['backendCorePath'] = props.get('runtime.platform.path')
            if core_inventory(platform) != request['coreFiles'] or core_inventory(sdk) != request['sdkFiles']:
                raise ValueError('Core/SDK changed during compilation; output rejected')
            phase('postValidationMs')
            # Export only complete user-visible output and inspection evidence.
            # Objects remain exclusively on the Linux filesystem.
            artifacts = []
            for file in sorted(build.iterdir()):
                if file.is_file() and (file.suffix in ('.bin', '.elf', '.map', '.json', '.csv')
                                       or file.name in ('flash_args', 'sdkconfig')):
                    shutil.copy2(file, export / file.name)
                    artifacts.append(dict(name=file.name, bytes=file.stat().st_size, sha256=digest(file)))
            # The existing Windows uploader authenticates relative flash_args
            # against this directory. Carry the byte-verified Core boot image
            # rather than leaving an inaccessible Linux hardware-root path.
            boot_app = platform / 'tools/partitions/boot_app0.bin'
            shutil.copy2(boot_app, export / boot_app.name)
            artifacts.append(dict(name=boot_app.name, bytes=boot_app.stat().st_size, sha256=digest(boot_app)))
            if not (export / 'sketch.ino.bin').is_file() or not (export / 'sketch.ino.elf').is_file():
                raise RuntimeError('CLI success lacks required current firmware')
            receipt.update(success=True, artifacts=artifacts,
                           sameBuildAdoptions=len(list(cache.glob('*/adopted.json'))))
            (work / 'success.json').write_text(json.dumps(dict(requestId=request['requestId'])))
            event('Firmware and identity verified; exporting to existing Windows upload path')
            phase('exportMs')
    except Exception as error:
        receipt.update(success=False, error=str(error), cancelled=cancelled,
                       timedOut=timed_out, processCleanup=cleanup)
        if cancelled or isinstance(error, (InterruptedError, TimeoutError)):
            receipt['fallbackAllowed'] = False
    finally:
        receipt['phaseTimings'] = phases
        receipt['workerMs'] = round((time.monotonic() - started) * 1000)
        (export / 'backend-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return 0 if receipt['success'] or receipt['fallbackAllowed'] else 1


if __name__ == '__main__':
    sys.exit(main(Path(sys.argv[1]).resolve()))
