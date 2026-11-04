# Provenance of the vendored icons

## LobeHub icons

`src/lib/icons/lobehub.ts` holds eight mono icons from
`@lobehub/icons-static-svg` 1.102.0 (MIT, https://github.com/lobehub/lobe-icons):

- tarball:
  `https://registry.npmjs.org/@lobehub/icons-static-svg/-/icons-static-svg-1.102.0.tgz`;
- integrity:
  `sha512-3Na6S2kdslmsfnBjuL0PQWQClrmuWe/pWThRN/3J2VzPg5MhVghy8knVu7kd1/lqA9ydZBvwmnKLzuBo0Wm6Qw==`;
- `gitHead`: `989535d6c13da2dec5a2937fe2789d4af4fdd8e0`.

Each value is the file `icons/<key>.svg` of the tarball, read as UTF-8, after
these three replacements, in order:

```js
svg
  .replace(/<title>[^<]*<\/title>/, '')
  .replace(/\s(height|width)="1em"/g, '')
  .replace(/\sstyle="[^"]*"/, '');
```

No source file has leading or trailing whitespace, a line break, a backslash or
a single quote, so each value is written between single quotes with no escape,
and the module's literal is the value byte for byte.

| Key          | Source                 | Source SHA-256                                                     | Bytes | Stored SHA-256                                                     | Length |
| ------------ | ---------------------- | ------------------------------------------------------------------ | ----- | ------------------------------------------------------------------ | ------ |
| `claude`     | `icons/claude.svg`     | `365a70a7eb3956d9b9a96086058ebe04e1dbd8e291a756ad964e8a283fbd6d38` | 1701  | `31b0c68dec9e9886c4aa34e1a5c7fa9443f1a8cef915f2c00bc3b4ef175f0939` | 1623   |
| `deepseek`   | `icons/deepseek.svg`   | `8f9443e351b6dacce71871790201b799d92e8bf96a45ef79aeb5e9bf4db423e2` | 2189  | `9d56e83c9f27247203261f51fd6328bd68116e6a8834fbfb1ef98b4b99023709` | 2109   |
| `gemini`     | `icons/gemini.svg`     | `87d5b3c4be75a66f54c1936482a263df68185545b741129badd1b7c2449c18d3` | 651   | `b5a5c2da1e6738e028b9ec351c58806b055da614e9163060826b5d755cca11db` | 573    |
| `gemma`      | `icons/gemma.svg`      | `8f9b74f6bbbf17203da8d81c3a4bb8750dbf13afe3ab4c1d482e84be62cd03a6` | 2078  | `e086675c1aab725e1034d4094c195a4bccecb5f2c9bd246171432a95fbd10c00` | 2001   |
| `meta`       | `icons/meta.svg`       | `805ef9a35305393eb5a89be46b0708c9b119b3308ca44aaedd1457ff04857060` | 1735  | `ab40fb1b971a22242cb9a2c8e41c62d6be56f96ef9bd4505c297b82799ef00a6` | 1659   |
| `openai`     | `icons/openai.svg`     | `a595df6b423920c67a7f8f73c063e4bfb72d415948097b6cac063a2366bb5186` | 1687  | `e8825f28f5e762f7005b90e5d10301d0a61606aed3eebf1715c485702d160023` | 1609   |
| `openrouter` | `icons/openrouter.svg` | `ae671cc83de9bd45db97a47ed5e38a4e1bd9f93a12be495ba4b4f8b284026bca` | 382   | `d7ab11810a3596cd8e82a1bd74b831c71b0762a0e43550793ccdfaa87db0df5f` | 300    |
| `qwen`       | `icons/qwen.svg`       | `b2c16efc3bd32b88a941842d41222e1e1e0e40441222218b725afc0aef6d9a36` | 1041  | `ed914b0a1de0d9df60f3c47db508e01a6d49270b5ac890d6f97192ced320ec7c` | 965    |

To check the module, run `npm pack @lobehub/icons-static-svg@1.102.0`,
`tar -xzf` the tarball, hash each source file (`sha256sum package/icons/<key>.svg`)
against the source column, and hash each value of `lobehub.ts`, the text between
the single quotes after `<key>: `, against the stored column:

```sh
node -e "const s=require('fs').readFileSync('packages/llms/src/lib/icons/lobehub.ts','utf8');for(const m of s.matchAll(/(\w+):\s*\x27([^\x27]*)\x27/g))console.log(m[1],require('crypto').createHash('sha256').update(m[2]).digest('hex'),m[2].length)"
```

To upgrade, pack the new version, repeat the replacements for every key,
replace each value, and replace the table, the version, the URL, the integrity
and the `gitHead` in one change. No generation path exists for the module: a
change to it comes with a change to this file that names the new source and its
hashes.

The tarball holds `README.md`, `package.json` and `icons/` only; it has no
LICENSE file. The text below is the repository's `LICENSE` at `gitHead`
`989535d6c13da2dec5a2937fe2789d4af4fdd8e0`:

```text
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The marks are the trademarks of their owners, used here only to name the vendor
of a model.
