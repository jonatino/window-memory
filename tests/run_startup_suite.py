"""Run unit regressions and isolated compositor probes, preserving evidence.

Usage: python3 tests/run_startup_suite.py --output /absolute/path/to/new/directory
This never restarts the host Shell or writes the host's GNOME settings.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SCENARIOS = ('exact', 'delayed', 'timeout', 'disable', 'workspace', 'monitor',
             'ignored', 'splash', 'no-animation', 'maximized', 'xwayland', 'vesktop')


def source_hashes():
    paths = [*ROOT.glob('*.js'), *ROOT.glob('lib/*.js'), ROOT / 'metadata.json',
             *ROOT.glob('schemas/*.xml')]
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error('Output directory must be new or empty to avoid stale test results')
    output.mkdir(parents=True, exist_ok=True)
    summary = {'source_sha256': source_hashes(), 'checks': [], 'status': 'running'}
    commands = [(name, ['gjs', '-m', f'tests/{name}.js'])
                for name in ('startup_test', 'matcher_test', 'common_test')]
    commands += [(name, [sys.executable, 'tests/startup_probe.py', '--app', name,
                        '--output', str(output / name)]) for name in SCENARIOS]
    for name, command in commands:
        log_path = output / f'{name}.log'
        try:
            with log_path.open('w') as log:
                result = subprocess.run(command, cwd=ROOT, stdout=log,
                                        stderr=subprocess.STDOUT, timeout=45)
            passed = result.returncode == 0
        except subprocess.TimeoutExpired:
            passed = False
        summary['checks'].append({'name': name, 'passed': passed, 'log': str(log_path)})
        (output / 'summary.json').write_text(json.dumps(summary, indent=2))
        print(f'{"PASS" if passed else "FAIL"}: {name}', flush=True)
        if not passed:
            print(log_path.read_text(errors='replace')[-3000:], flush=True)
    unchanged = summary['source_sha256'] == source_hashes()
    success = unchanged and all(check['passed'] for check in summary['checks'])
    summary.update(status='passed' if success else 'failed', sources_unchanged=unchanged)
    (output / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(f'Evidence: {output / "summary.json"}', flush=True)
    return 0 if success else 1


if __name__ == '__main__':
    sys.exit(main())
