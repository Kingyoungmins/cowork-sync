// cowork's tree-sitter query for Python (R4-11): a string constant compiled into dist/worker.js and hashed into regionSpec on
// the main thread. It marks the candidates of 04 §3.3's Python units with the fixed capture names; src/regions/worker/tables.ts
// decides structure from where each capture sits (module level, a class body, a branch of a top-level `if`; anything nested
// in a function folds into it). Captures: @unit.function (def / async def; a method inside a class body), @unit.class,
// @unit.const (a single identifier target with a value; tables.ts drops chained targets), @name, @decorator
// (decorated_definition), @import, @comment, @branch (a module-level `if`).
export const PYTHON_QUERY = [
  '(function_definition name: (identifier) @name) @unit.function',
  '(class_definition name: (identifier) @name) @unit.class',
  '(expression_statement (assignment left: (identifier) @name right: (_))) @unit.const',
  '(decorated_definition) @decorator',
  '(import_statement) @import',
  '(import_from_statement) @import',
  '(future_import_statement) @import',
  '(comment) @comment',
  '(module (if_statement) @branch)',
  '',
].join('\n');
