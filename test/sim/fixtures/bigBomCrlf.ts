// Generated BOM + CRLF Python source (11-testing §3.7 `big_bomcrlf.py` / `big26k.py`):
// classes, decorators, property getters/setters, @overload stubs, platform branches
// and Hangul comments. Deterministic for a given Random; never reads a real file.
import { randomInt, type Random } from '../../../src/ports/random.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const HEADER = [
  '# -*- coding: utf-8 -*-',
  '"""Generated fixture module for cowork-sync tests. Do not edit by hand."""',
  'from __future__ import annotations',
  '',
  'import os',
  'import sys',
  'from typing import Any, overload',
  '',
];

function classBlock(n: number, k: number): string[] {
  return [
    `class Widget${n}(object):`,
    `    """Generated widget ${n}: one integer value, a list of labels and a lookup table used by the fixture tests."""`,
    '',
    `    def __init__(self, value: int = ${k}, labels: list[str] | None = None, *, strict: bool = False) -> None:`,
    '        self._value = value',
    `        self._labels: list[str] = list(labels) if labels is not None else [f"label-{i}-${n}" for i in range(${k % 5})]`,
    '        self._strict = strict',
    '',
    '    @property',
    '    def value(self) -> int:',
    `        """Current value of widget ${n}; the setter rejects negative numbers when strict."""`,
    '        return self._value',
    '',
    '    @value.setter',
    '    def value(self, new_value: int) -> None:',
    '        if self._strict and new_value < 0:',
    `            raise ValueError(f"widget ${n}: negative value {new_value} is not allowed in strict mode")`,
    '        self._value = new_value',
    '',
    '    @staticmethod',
    `    def describe(label: str = "w${n}", *, verbose: bool = False) -> str:`,
    `        return f"{label}: widget ${n} of kind {${k} % 7} (verbose={verbose})" if verbose else f"{label}: widget ${n}"`,
    '',
    '    def as_dict(self) -> dict[str, Any]:',
    `        return {"id": ${n}, "value": self._value, "labels": list(self._labels), "strict": self._strict, "kind": "widget"}`,
    '',
    '',
  ];
}

function overloadBlock(n: number): string[] {
  return [
    '@overload',
    `def convert_${n}(value: int, *, strict: bool = False, default: int | None = None) -> int: ...`,
    '@overload',
    `def convert_${n}(value: str, *, strict: bool = False, default: str | None = None) -> str: ...`,
    `def convert_${n}(value: Any, *, strict: bool = False, default: Any = None) -> Any:`,
    `    """Identity conversion ${n} with an overload pair; returns the default when value is None."""`,
    '    return default if value is None else value',
    '',
    '',
  ];
}

function platformBlock(n: number): string[] {
  return [
    'if sys.platform == "win32":',
    `    DATA_DIR_${n} = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "cowork", "fixtures", "${n}")`,
    'else:',
    `    DATA_DIR_${n} = os.path.join(os.path.expanduser("~"), ".local", "share", "cowork", "fixtures", "${n}")`,
    '',
  ];
}

function commentBlock(n: number, k: number): string[] {
  return [
    `# 설정 블록 ${n}: 값 ${k} 를 확인합니다 (한글 주석) — generated configuration entry for the fixture tests`,
    `SETTING_${n} = {"name": "setting_${n}", "limit": ${k}, "enabled": ${k % 2 === 0 ? 'True' : 'False'}, "path": "config/settings/setting_${n}.json"}`,
    '',
  ];
}

/**
 * Returns UTF-8 BOM + exactly `lines` lines, each terminated by CRLF (no bare LF, no bare CR).
 * Blocks are never cut: when the next block does not fit, the rest is comment padding,
 * so the module stays valid Python. At 26,436 lines (the size of the pilot's largest
 * file) the result is about 1.3 MB.
 */
export function generateBigBomCrlf(lines: number, random: Random): Buffer {
  const target = Math.max(0, Math.floor(lines));
  const out: string[] = HEADER.slice(0, target);
  let n = 0;
  while (out.length < target) {
    const k = randomInt(random, 1000);
    let block: string[];
    switch (randomInt(random, 4)) {
      case 0: block = classBlock(n, k); break;
      case 1: block = overloadBlock(n); break;
      case 2: block = platformBlock(n); break;
      default: block = commentBlock(n, k); break;
    }
    if (out.length + block.length > target) break;
    out.push(...block);
    n++;
  }
  while (out.length < target) out.push(`# padding ${out.length + 1}`);
  const body = target === 0 ? '' : out.join('\r\n') + '\r\n';
  return Buffer.concat([BOM, Buffer.from(body, 'utf8')]);
}
