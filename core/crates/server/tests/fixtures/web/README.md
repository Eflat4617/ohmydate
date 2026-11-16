# Web fixture

A stand-in for `apps/web/dist`, shaped like the output of `vite build`:
a document, content-hashed files under `assets/`, files with fixed names
next to the document, a file without an extension and a hidden file (which
must never be served). Used by `core/crates/server/tests/web.rs` and
`tests-core/web.test.ts`. The real web app is not built in tests.
