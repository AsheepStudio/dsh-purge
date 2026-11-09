# Offline fixture provenance

The `system-prompt-*.fragment.txt` files are literal excerpts from the official
`@deepseek-ai/dsh-system-prompt` npm packages. They contain only the tail of
`SystemPrompt.assemble`, beginning with the waterfall call and ending with its
return statement. The tests wrap these fragments in an async function and invoke
the real exported patcher; they do not reproduce the replacement algorithm.

Retrieved on 2026-10-18 from the following versioned tarballs:

| Version | Source | Original `package/lib/index.js` lines |
| --- | --- | --- |
| 0.2.0-rc.2 | https://registry.npmjs.org/@deepseek-ai/dsh-system-prompt/-/dsh-system-prompt-0.2.0-rc.2.tgz | 355–361 |
| 0.2.1-rc.2 | https://registry.npmjs.org/@deepseek-ai/dsh-system-prompt/-/dsh-system-prompt-0.2.1-rc.2.tgz | 398–405 |
| 0.2.2-rc.1 | https://registry.npmjs.org/@deepseek-ai/dsh-system-prompt/-/dsh-system-prompt-0.2.2-rc.1.tgz | 401–412 |

SHA-256 of the original tarballs:

```text
0.2.0-rc.2 a15ae0a27f767554cd140032dc4b1c6b87d42e7f44319789d740ddcc5059c79d
0.2.1-rc.2 d186153582b801c3f16a84d1a0651910957be7498929381a48ae6fe49666206d
0.2.2-rc.1 5ecb3f2ff2f0c037287c22c1ef917f1ce5cdd4c8055d51da6646ed5a39fe02a9
```

SHA-256 of the original `package/lib/index.js` files:

```text
0.2.0-rc.2 ff422afac6ba85f89afa985d921aed0b603feb354a05a549c48eae04cf0d2f57
0.2.1-rc.2 7be9f7aafbf345d01ddcc12fd297b16e9a1d41283a6a04073b867becca0bf020
0.2.2-rc.1 18b692b03bbb717589085f63b126cbcf22963763c5a0565bb3a7a5d254e8e4a7
```

The official package's MIT license is retained in
`dsh-system-prompt-LICENSE`.

The 0.2.2-rc.1 tarball was retrieved on 2026-11-09. Its SHA-512 integrity
matched npm metadata, and the full module matched the installed desktop module
byte for byte (desktop build `c59d10aff167ad7eefead4b3a9082fb57c8fbfe8`).
Its fragment includes both provider-owned `tools` returns. Tests verify those
tools remain authoritative even if a waterfall listener replaces or omits them.

`system-prompt-0.2.1-rc.2-renderer.mjs` adds literal excerpts from the same
**unpatched** 0.2.1-rc.2 tarball: `package/lib/index.js` lines 62–65 (the two
interpolation regular expressions) and lines 108–182 (`renderPrompt`, the
context renderers, and `interpolate`, including their original comments).
Only a provenance comment, a separating blank line, and a final ES module
export statement are added. It does not copy the plugin's renderer patches or
reimplement interpolation. Its LF-normalized SHA-256 is
`579f2a84a64f6d3ce86faaffc2c7c32ec904c5e31c4074a3914fb1dbb4a4b4b5`.
`cwd-prompt-compat.test.mjs` invokes these official renderers after the real
plugin assembly rewrite, so unknown custom variables must still throw and
literal runtime contexts must remain literal.

`system-prompt-legacy.json` freezes the five literal prior-patch fragments from
patch #40's string replacements in upstream `dsh-purge` 1.1.71 `lib/core.js`
(MIT, YuJunZhiXue). These fixtures exercise upgrades from previously emitted
patches, including a current emitted form that must remain unchanged. They are
fixed test inputs; the tests do not obtain inputs from the current replacement
definitions.

Run from the repository root with Node.js 18 or newer:

```sh
node --test tests/complete-prompt-compat.test.mjs
```

No network, dependency install, actual Harness installation, host discovery,
application patching, or restart is used by these tests. Only fixture reads and
pure exported text functions are used.
