import contextlib
import io
from pathlib import Path
import subprocess
import tempfile
import unittest

import check_glibc


class GlibcTests(unittest.TestCase):
    def test_version_needs_including_weak(self):
        output = """Version definition section '.gnu.version_d' contains 1 entry:
  Name: GLIBC_2.99
Version needs section '.gnu.version_r' contains 2 entries:
  Name: GLIBC_2.35 Flags: none
  Name: GLIBC_2.39 Flags: WEAK
"""
        self.assertEqual(list(check_glibc.requirements(output)), ["GLIBC_2.35", "GLIBC_2.39"])

    def test_numeric_versions_and_special_abis(self):
        for version in ["2.2.5", "2.9", "2.34", "2.35", "2.35.0"]:
            self.assertFalse(check_glibc.unsupported("GLIBC_" + version))
        for version in ["2.35.1", "2.38", "2.39", "2.43", "2.100", "PRIVATE", "ABI_DT_RELR"]:
            self.assertTrue(check_glibc.unsupported("GLIBC_" + version))

    def test_real_elf_tree(self):
        # A dependency exports a deliberately too-new version. Its consumer
        # must fail, while the exporting library alone must pass.
        with tempfile.TemporaryDirectory(prefix="glibc test ") as directory:
            root = Path(directory)
            (root / "provider.c").write_text("int future(void) { return 0; }\n")
            (root / "consumer.c").write_text("extern int future(void); int use(void) { return future(); }\n")
            (root / "versions").write_text("GLIBC_2.43 { global: future; };\n")
            subprocess.run(["cc", "-shared", "-fPIC", "provider.c", "-Wl,--version-script=versions", "-o", "libprovider.so"], cwd=root, check=True)
            subprocess.run(["cc", "-shared", "-fPIC", "consumer.c", "-L.", "-lprovider", "-o", "plugin.so"], cwd=root, check=True)
            (root / "readme").write_text("GLIBC_2.99 is just text")
            with contextlib.redirect_stdout(io.StringIO()):
                check_glibc.check_paths([root / "libprovider.so"])
            with self.assertRaisesRegex(ValueError, r"plugin.so: GLIBC_2.43"):
                check_glibc.check_paths([root])

    def test_missing_or_empty_artifacts_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "no ELF"):
                check_glibc.check_paths([directory])
            with self.assertRaisesRegex(ValueError, "missing artifact"):
                check_glibc.check_paths([Path(directory) / "missing.so"])


if __name__ == "__main__":
    unittest.main()
