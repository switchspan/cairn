import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


CLI = Path(__file__).resolve().parents[1] / 'handoff.py'
spec = importlib.util.spec_from_file_location('handoff', CLI)
handoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.repo = self.base / 'repo'
        self.repo.mkdir()
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Handoff Test')
        self.git('config', 'user.email', 'test@example.invalid')
        (self.repo / 'code.txt').write_text('original\n')
        self.git('add', '.')
        self.git('commit', '-m', 'baseline')
        self.draft = self.base / 'draft.md'
        self.draft.write_text('Objective: fix retries.\nNext: run regression test.\n')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], check=True,
                              capture_output=True).stdout

    def run_cli(self, *args, cwd=None):
        return subprocess.run([sys.executable, str(CLI), '--cwd', str(cwd or self.repo), *args],
                              capture_output=True, text=True)

    def save_args(self, revision=0):
        return ['checkpoint', '--ticket', 'https://example.invalid/PAY-142',
                '--file', str(self.draft), '--expected-revision', str(revision)]

    def save(self, revision=0, cwd=None):
        result = self.run_cli(*self.save_args(revision), cwd=cwd)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_round_trip_from_subdirectory_and_local_ignore(self):
        self.save()
        nested = self.repo / 'nested'
        nested.mkdir()
        result = self.run_cli('resume', cwd=nested)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, self.draft.read_text())
        self.assertEqual(self.git('status', '--porcelain'), b'')
        self.assertFalse((self.repo / '.gitignore').exists())

    def test_dirty_file_content_drift_with_same_status(self):
        p = self.repo / 'code.txt'
        p.write_text('first edit\n')
        self.save()
        p.write_text('second edit\n')
        result = self.run_cli('resume')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn('fingerprint', result.stderr)
        self.assertEqual(self.run_cli('resume', '--allow-stale').returncode, 0)

    def test_untracked_content_drift(self):
        p = self.repo / 'new.txt'
        p.write_text('one')
        self.save()
        p.write_text('two')
        self.assertNotEqual(self.run_cli('resume').returncode, 0)

    def test_staging_drift(self):
        (self.repo / 'code.txt').write_text('changed')
        self.save()
        self.git('add', 'code.txt')
        self.assertNotEqual(self.run_cli('resume').returncode, 0)

    def test_head_drift(self):
        self.save()
        self.git('commit', '--allow-empty', '-m', 'new head')
        self.assertIn('head', self.run_cli('status').stdout)
        self.assertNotEqual(self.run_cli('resume').returncode, 0)

    def test_worktree_isolation(self):
        self.save()
        other = self.base / 'ticket-two'
        self.git('worktree', 'add', '-b', 'ticket-two', str(other))
        result = self.run_cli('resume', cwd=other)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('No checkpoint', result.stderr)
        self.draft.write_text('Objective: another ticket.\nNext: inspect parser.\n')
        self.save(cwd=other)
        self.assertIn('fix retries', self.run_cli('resume').stdout)
        self.assertIn('another ticket', self.run_cli('resume', cwd=other).stdout)

    def test_revision_and_ticket_conflicts_preserve_checkpoint(self):
        self.save()
        original = (self.repo / '.handoff/current.md').read_bytes()
        result = self.run_cli(*self.save_args())
        self.assertIn('Revision conflict', result.stderr)
        args = self.save_args(1)
        args[2] = 'https://example.invalid/other'
        self.assertIn('Ticket mismatch', self.run_cli(*args).stderr)
        self.assertEqual((self.repo / '.handoff/current.md').read_bytes(), original)
        self.save(1)
        self.assertIn('"revision": 2', self.run_cli('status').stdout)

    def test_concurrent_checkpoints_one_winner(self):
        command = [sys.executable, str(CLI), '--cwd', str(self.repo), *self.save_args()]
        processes = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                     for _ in range(2)]
        for process in processes:
            process.communicate(timeout=15)
        self.assertEqual(sorted(p.returncode for p in processes), [0, 1])
        self.assertEqual(self.run_cli('resume').returncode, 0)

    def test_failed_replace_preserves_old_checkpoint(self):
        self.save()
        current = self.repo / '.handoff/current.md'
        original = current.read_bytes()
        with patch.object(handoff.os, 'replace', side_effect=OSError('simulated interruption')):
            with self.assertRaises(OSError):
                handoff.atomic_write(current, 'replacement')
        self.assertEqual(current.read_bytes(), original)
        self.assertEqual(list(current.parent.glob('.checkpoint-*')), [])

    def test_rejects_symlink_directory(self):
        outside = self.base / 'outside'
        outside.mkdir()
        (self.repo / '.handoff').symlink_to(outside, target_is_directory=True)
        self.assertNotEqual(self.run_cli(*self.save_args()).returncode, 0)
        self.assertEqual(list(outside.iterdir()), [])

    def test_rejects_tracked_checkpoint_directory(self):
        directory = self.repo / '.handoff'
        directory.mkdir()
        (directory / 'old.md').write_text('old')
        self.git('add', '.handoff/old.md')
        self.assertIn('tracked files', self.run_cli(*self.save_args()).stderr)

    def test_rejects_oversize_and_manual_body_edits(self):
        self.draft.write_text('x' * 12001)
        self.assertNotEqual(self.run_cli(*self.save_args()).returncode, 0)
        self.draft.write_text('Objective: test.\nNext: verify.\n')
        self.save()
        current = self.repo / '.handoff/current.md'
        current.write_text(current.read_text() + 'changed')
        self.assertIn('changed outside', self.run_cli('resume').stderr)

    def test_export_contains_identity_and_drift(self):
        self.save()
        (self.repo / 'code.txt').write_text('changed')
        result = self.run_cli('export')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('fingerprint', result.stdout)
        self.assertIn('https://example.invalid/PAY-142', result.stdout)
        self.assertIn('code and permissions are not transferred', result.stdout)

    def test_status_does_not_create_checkpoint(self):
        self.assertNotEqual(self.run_cli('status').returncode, 0)
        self.assertFalse((self.repo / '.handoff').exists())

    def test_ignored_evidence_does_not_create_drift(self):
        self.save()
        (self.repo / '.handoff/evidence.log').write_text('test output')
        self.assertEqual(self.run_cli('resume').returncode, 0)


if __name__ == '__main__':
    unittest.main()
