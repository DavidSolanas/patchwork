import { describe, expect, it } from 'vitest';
import { renderDiff } from '../diffViewer.js';

const SIMPLE_DIFF = `diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;

const MULTI_FILE_DIFF = `diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,1 +1,1 @@
-old
+new
diff --git a/bar.ts b/bar.ts
index 111..222 100644
--- a/bar.ts
+++ b/bar.ts
@@ -1,1 +1,1 @@
-bar old
+bar new
`;

const BINARY_DIFF = `diff --git a/logo.png b/logo.png
index 123..456 100644
Binary files a/logo.png and b/logo.png differ
`;

describe('renderDiff', () => {
  it('renders a simple diff with file header and +/- markers', () => {
    const out = renderDiff(SIMPLE_DIFF);
    expect(out).toContain('foo.ts');
    expect(out).toContain('-const b = 2;');
    expect(out).toContain('+const b = 3;');
  });

  it('shows both files in a multi-file diff', () => {
    const out = renderDiff(MULTI_FILE_DIFF);
    expect(out).toContain('foo.ts');
    expect(out).toContain('bar.ts');
    expect(out).toContain('+new');
    expect(out).toContain('+bar new');
  });

  it('marks binary files instead of dumping bytes', () => {
    const out = renderDiff(BINARY_DIFF);
    expect(out).toContain('[binary file: logo.png]');
  });

  it('handles an empty diff gracefully', () => {
    const out = renderDiff('');
    expect(out).toContain('empty diff');
  });

  it('truncates per-file output past maxLinesPerFile', () => {
    // Build a diff with 50 added lines.
    const adds = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n');
    const longDiff = `diff --git a/big.ts b/big.ts
index aaa..bbb 100644
--- a/big.ts
+++ b/big.ts
@@ -0,0 +1,50 @@
${adds}
`;
    const out = renderDiff(longDiff, { maxLinesPerFile: 10 });
    expect(out).toMatch(/<\d+ more lines>/);
  });

  it('does not truncate when under the limit', () => {
    const out = renderDiff(SIMPLE_DIFF, { maxLinesPerFile: 200 });
    expect(out).not.toMatch(/more lines/);
  });
});
