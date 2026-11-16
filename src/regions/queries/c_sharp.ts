// cowork's tree-sitter query for C# (R4-11): a string constant compiled into dist/worker.js and hashed into regionSpec on the
// main thread. It marks the candidates of 04 §3.3's C# units with the fixed capture names; src/regions/worker/tables.ts
// descends namespaces (block or file-scoped) and #if branches and recurses into nested types. Captures: @unit.type (class,
// struct, interface, enum, record), @unit.method, @unit.ctor, @unit.dtor, @unit.property, @unit.indexer, @unit.event (with
// accessors or field-like), @unit.field, @unit.operator (operators and conversion operators), @name, @attribute, @import
// (using directives, extern alias), @comment (`///` included), @branch (a preprocessor #if).
export const C_SHARP_QUERY = [
  '(class_declaration name: (identifier) @name) @unit.type',
  '(struct_declaration name: (identifier) @name) @unit.type',
  '(interface_declaration name: (identifier) @name) @unit.type',
  '(enum_declaration name: (identifier) @name) @unit.type',
  '(record_declaration name: (identifier) @name) @unit.type',
  '(method_declaration name: (identifier) @name) @unit.method',
  '(constructor_declaration name: (identifier) @name) @unit.ctor',
  '(destructor_declaration name: (identifier) @name) @unit.dtor',
  '(property_declaration name: (identifier) @name) @unit.property',
  '(indexer_declaration) @unit.indexer',
  '(event_declaration name: (identifier) @name) @unit.event',
  '(event_field_declaration (variable_declaration (variable_declarator name: (identifier) @name))) @unit.event',
  '(field_declaration (variable_declaration (variable_declarator name: (identifier) @name))) @unit.field',
  '(operator_declaration) @unit.operator',
  '(conversion_operator_declaration) @unit.operator',
  '(attribute_list) @attribute',
  '(using_directive) @import',
  '(extern_alias_directive) @import',
  '(comment) @comment',
  '(preproc_if) @branch',
  '',
].join('\n');
