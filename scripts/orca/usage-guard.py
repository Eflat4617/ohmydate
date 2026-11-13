#!/usr/bin/env python3
"""Orchestrator-only. The user's rule (2026-11-13): when the Fable allowance is about to run out
(about 3% left), stop the running work safely and do NOT continue on another model.

  usage-guard.py read        print the current Claude usage meters (exit 1 when any is >= THRESHOLD)
  usage-guard.py watch       poll every INTERVAL seconds; exit 1 with one line when the threshold is reached
  usage-guard.py safe-stop   stop every live worker of this Run and commit its uncommitted work as a WIP commit

Reads `orca account list --json` (rateLimits.claude). Prints percentages only, never account data.
"""
import json, subprocess, sys, time

THRESHOLD = 97          # percent used, i.e. about 3% left
INTERVAL = 240          # seconds between polls in watch mode
REPO = 'dde48ef6-62e6-4539-9044-749943edc800::'


def orca(*args, timeout=60):
    out = subprocess.run(['orca', *args, '--json'], capture_output=True, text=True, timeout=timeout).stdout
    return json.loads(out)


def read():
    c = orca('account', 'list')['result']['rateLimits']['claude']
    def pct(key):
        value = c.get(key)
        return value.get('usedPercent') if isinstance(value, dict) else None
    meters = {'fable': pct('fableWeekly'), 'weekly': pct('weekly'), 'session': pct('session')}
    age = int(time.time() - (c.get('updatedAt') or 0) / 1000)
    reset = (c.get('fableWeekly') or {}).get('resetDescription')
    worst = max([v for v in meters.values() if isinstance(v, (int, float))] or [0])
    line = f"fable={meters['fable']} weekly={meters['weekly']} session={meters['session']} age_s={age} status={c.get('status')} reset={reset}"
    return worst, line


def safe_stop():
    workers = orca('orchestration', 'worker-list')['result']['workers']
    live = [w for w in workers if w.get('liveness') == 'live']
    print(f'live workers: {len(live)}')
    for w in live:
        dispatch, workspace = w['dispatchId'], w.get('workspace', '')
        path = workspace.split('::', 1)[1] if '::' in workspace else None
        try:
            stopped = orca('orchestration', 'worker-stop', '--dispatch', dispatch)
            print(dispatch, 'stop ok' if stopped.get('ok') else f"stop failed: {stopped.get('error')}")
        except Exception as error:  # keep going: the WIP commit below still protects the work
            print(dispatch, 'stop error', type(error).__name__)
        if path is None:
            continue
        dirty = subprocess.run(['git', '-C', path, 'status', '--porcelain'], capture_output=True, text=True).stdout.strip()
        if dirty == '':
            print(path, 'clean')
            continue
        subprocess.run(['git', '-C', path, 'add', '-A'], check=False)
        message = ('wip: stopped before the Fable usage limit (usage-guard)\n\n'
                   f'Dispatch {dispatch} was stopped by the coordinator on the user\'s standing rule.\n'
                   'Uncommitted work is kept here as-is; it may not compile or pass tests.\n'
                   'Resume: start a worker on this worktree with the same packet and tell it to continue from this commit.')
        done = subprocess.run(['git', '-C', path, 'commit', '-q', '-m', message], capture_output=True, text=True)
        head = subprocess.run(['git', '-C', path, 'log', '--oneline', '-1'], capture_output=True, text=True).stdout.strip()
        print(path, 'wip committed' if done.returncode == 0 else f'commit failed: {done.stderr.strip()[:200]}', head)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'read'
    if mode == 'safe-stop':
        safe_stop()
        return 0
    if mode == 'read':
        worst, line = read()
        print(line)
        return 1 if worst >= THRESHOLD else 0
    if mode == 'watch':
        failures = 0
        while True:
            try:
                worst, line = read()
                failures = 0
                if worst >= THRESHOLD:
                    print(f'USAGE THRESHOLD REACHED ({THRESHOLD}% used): {line}', flush=True)
                    return 1
            except Exception as error:
                failures += 1
                if failures >= 5:
                    print(f'USAGE READ FAILING ({type(error).__name__}) five times in a row', flush=True)
                    return 2
            time.sleep(INTERVAL)
    print(__doc__)
    return 64


if __name__ == '__main__':
    sys.exit(main())
