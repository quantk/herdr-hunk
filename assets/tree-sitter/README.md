# Bundled Tree-sitter assets

The JavaScript, TypeScript, and Markdown grammars and queries are copied from
the exactly pinned `@opentui/core` package; its MIT license is retained as
`opentui.LICENSE`. The other grammar WASM files are
copied from the exactly pinned `tree-sitter-wasms` development package. Its
Unlicense text is retained as `tree-sitter-wasms.LICENSE`. The YAML grammar is
the MIT-licensed WASM artifact from
`@plurnk/plurnk-mimetypes-grammar-yaml@1.3.1`; its license is retained beside
the YAML asset.

The Java and Kotlin WASM files come from that same pinned
`tree-sitter-wasms@0.1.13` package. Their highlight queries match the
`tree-sitter-java@0.20.2` and `tree-sitter-kotlin@0.3.1` grammar versions used
to build those files. The grammar licenses are retained beside each asset.
The Kotlin query credits nvim-treesitter and its Apache-2.0 license is retained
as `kotlin/nvim-treesitter.LICENSE`.

Runtime startup uses only this directory. It never downloads grammar, query, or
worker assets.
