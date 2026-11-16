// cowork's tree-sitter query for JavaScript (R4-11): a string constant compiled into dist/worker.js and hashed into regionSpec
// on the main thread. It marks the candidates of 04 §3.3's JS units with the fixed capture names; src/regions/worker/tables.ts
// decides structure (top level, a class body, an object literal bound at top level, the body of an IIFE/UMD wrapper; anything
// nested in a function folds into it). Captures: @unit.function (declarations, generators, and a variable_declarator bound to
// a function or arrow), @unit.class (declarations and a declarator bound to a class), @unit.method (method_definition, and an
// object pair whose value is a function), @name, @export, @import (import, export … from, and a require() call), @iife
// (a call whose callee or argument is a function), @comment.
export const JAVASCRIPT_QUERY = [
  '(function_declaration name: (identifier) @name) @unit.function',
  '(generator_function_declaration name: (identifier) @name) @unit.function',
  '(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)]) @unit.function',
  '(class_declaration name: (identifier) @name) @unit.class',
  '(variable_declarator name: (identifier) @name value: (class)) @unit.class',
  '(method_definition name: (_) @name) @unit.method',
  '(pair key: (_) @name value: [(arrow_function) (function_expression) (generator_function)]) @unit.method',
  '(export_statement) @export',
  '(import_statement) @import',
  '(export_statement source: (_)) @import',
  '((call_expression function: (identifier) @name) @import (#eq? @name "require"))',
  '(call_expression function: [(function_expression) (arrow_function) (parenthesized_expression [(function_expression) (arrow_function)])]) @iife',
  '(call_expression arguments: (arguments [(function_expression) (arrow_function)])) @iife',
  '(comment) @comment',
  '',
].join('\n');
