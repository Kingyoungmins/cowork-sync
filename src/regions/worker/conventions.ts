// The two region conventions every regionSpec names (04-regions §3.3; REG-16, R4-18, R4-19), and the label-convention/1
// spellings that are tables rather than structure: C#'s CLR metadata names for operators and the parameter-type
// normalization of C# discriminators. src/regions/worker/tables.ts applies both conventions.
//
// extent-convention/1 (04 §3.3):
//   1. Start row: the first row of the outermost of a Python decorated_definition, the first C# attribute_list of the member
//      (inside the member node), the first TS overload function_signature with the same name immediately preceding the
//      implementation, a JS/TS export_statement wrapping the declaration; otherwise the declaration node.
//   2. Extend upward over contiguous comment rows (a comment node alone on its rows, C# `///` included) with no blank row in
//      between; a comment row inside the unit above stays in that unit.
//   3. End row: the end position's row, minus 1 when its column is 0 (lineTable.endRow).
//   4. Residue of a class/type = its extent minus the extents of its members (multi-range; blank rows between members stay
//      in the residue, R4-18). Gap blocks are maximal runs of non-blank rows outside every unit and <imports>.
//
// label-convention/1 (04 §3.3, R4-19):
//   kind per language; qualname = dotted enclosing names (C# includes the namespace); simple = the declared name (C#: the CLR
//   metadata name of operators, conversion operators, indexers and destructors; a constructor's type name); type = the
//   enclosing type's qualname or ''; disc = get/set (JS/TS accessors), setter/deleter (Python), the normalized parameter type
//   list of every C# method, constructor, destructor, operator, conversion operator and indexer ('(int,string)'), 'overload'
//   for a TS signature set, plus the branch ordinal '#<n>' of a definition whose label key repeats in sibling branches of one
//   top-level Python `if` or C# `#if` (the branch's index: if = 0, then each elif/#elif, else last). Block and file labels
//   have four empty fields. No label field contains whitespace.
//   SEC-35: every non-empty field matches validLabel's pattern (VALID_LABEL_FIELD). A symbol unit with a field outside it
//   (a C# pointer type in its disc, a JS computed key, a Unicode escape in a name) is unlabeled: its label keeps its kind
//   and has four empty fields — the table's form of SEC-35's "rendered as ?" — and labelCounts does not count it.

export const EXTENT_CONVENTION = 'extent-convention/1';
export const LABEL_CONVENTION = 'label-convention/1';

/** 09-security SEC-35 `validLabel`, per non-empty label field (R4-24); Task 8's src/sec validLabel uses the same pattern. */
export const VALID_LABEL_FIELD = /^[\p{L}\p{M}\p{N}_.:#<>,$@[\]()-]{1,200}$/u;

/** CLR metadata names of C# operators by token and parameter count (ECMA-335 II.10.3; C# 11 `checked` variants). */
const BINARY: Readonly<Record<string, string>> = Object.freeze({
  '+': 'op_Addition', '-': 'op_Subtraction', '*': 'op_Multiply', '/': 'op_Division', '%': 'op_Modulus',
  '&': 'op_BitwiseAnd', '|': 'op_BitwiseOr', '^': 'op_ExclusiveOr', '<<': 'op_LeftShift', '>>': 'op_RightShift',
  '>>>': 'op_UnsignedRightShift', '==': 'op_Equality', '!=': 'op_Inequality', '<': 'op_LessThan', '>': 'op_GreaterThan',
  '<=': 'op_LessThanOrEqual', '>=': 'op_GreaterThanOrEqual',
});
const UNARY: Readonly<Record<string, string>> = Object.freeze({
  '+': 'op_UnaryPlus', '-': 'op_UnaryNegation', '!': 'op_LogicalNot', '~': 'op_OnesComplement', '++': 'op_Increment',
  '--': 'op_Decrement', 'true': 'op_True', 'false': 'op_False',
});

/** The CLR name of `operator <token>` with `arity` parameters (`checked` prefixes Checked); an unknown token keeps a safe spelling. */
export function csharpOperatorName(token: string, arity: number, checked: boolean): string {
  const name = (arity === 1 ? UNARY[token] : BINARY[token]) ?? BINARY[token] ?? UNARY[token] ?? 'op_Unknown';
  return checked ? name.replace(/^op_/, 'op_Checked') : name;
}

/** op_Implicit / op_Explicit for a conversion operator. */
export function csharpConversionName(kind: 'implicit' | 'explicit'): string {
  return kind === 'implicit' ? 'op_Implicit' : 'op_Explicit';
}
