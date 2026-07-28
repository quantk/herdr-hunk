# Bundled Tree-sitter assets

The JavaScript, TypeScript, and Markdown grammars and queries are copied from
the exactly pinned `@opentui/core` package; its MIT license is retained as
`opentui.LICENSE`. The other grammar WASM files are
copied from the exactly pinned `tree-sitter-wasms` development package. Its
Unlicense text is retained as `tree-sitter-wasms.LICENSE`. The YAML grammar is
the MIT-licensed WASM artifact from
`@plurnk/plurnk-mimetypes-grammar-yaml@1.3.1`; its license is retained beside
the YAML asset.

Runtime startup uses only this directory. It never downloads grammar, query, or
worker assets.
