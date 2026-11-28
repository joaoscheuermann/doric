//! Support shared by the unit tests: descriptor sets compiled from proto
//! source text, a temporary store, a caller, the details of an error, and the
//! documents fixture (`a.note/v1`, `a.plain/v1` and `a.pair/v1` registered
//! for `a`).
//! `src/main.rs`'s tests include this file too, so it names of the library
//! only `crate::register`, which `src/main.rs` imports at its root.

use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

use doric_bundle::{Caller, ContractError};

use prost_types::value::Kind;
use protox::{
    Compiler, Error,
    file::{ChainFileResolver, File, FileResolver, GoogleFileResolver, IncludeFileResolver},
};

/// The name of the file a test writes.
const NAME: &str = "fixture/v1/test.proto";

/// The one file of a test, by its source text.
struct Source(String);

impl FileResolver for Source {
    fn open_file(&self, name: &str) -> Result<File, Error> {
        if name == NAME {
            File::from_source(name, &self.0)
        } else {
            Err(Error::file_not_found(name))
        }
    }
}

/// The binary `FileDescriptorSet` of the one file `source`, with every file it
/// imports: `doric/platform/v1/options.proto` from `packages/bundle/proto` and
/// the well-known types from `protox`.
pub(crate) fn compile(source: &str) -> Vec<u8> {
    let mut resolver = ChainFileResolver::new();
    resolver.add(Source(source.to_owned()));
    resolver.add(IncludeFileResolver::new(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../packages/bundle/proto"),
    ));
    resolver.add(GoogleFileResolver::new());
    let mut compiler = Compiler::with_file_resolver(resolver);
    compiler.include_imports(true);
    compiler.open_file(NAME).expect("the test proto compiles");
    compiler.encode_file_descriptor_set()
}

/// [`compile`] of `body` in a proto3 file of the package `fixture.v1` that
/// imports `options.proto` and the well-known types the tests index.
pub(crate) fn storage_set(body: &str) -> Vec<u8> {
    compile(&format!(
        "syntax = \"proto3\";\n\
         package fixture.v1;\n\
         import \"doric/platform/v1/options.proto\";\n\
         import \"google/protobuf/duration.proto\";\n\
         import \"google/protobuf/struct.proto\";\n\
         import \"google/protobuf/timestamp.proto\";\n\
         import \"google/protobuf/wrappers.proto\";\n\
         {body}\n"
    ))
}

/// A caller of `bundle_id` at `generation`.
pub(crate) fn caller(bundle_id: &str, generation: u32) -> Caller {
    Caller {
        bundle_id: bundle_id.to_owned(),
        version: "1.0.0".to_owned(),
        generation,
        incarnation: 1,
    }
}

/// The string detail `field` of `error`.
pub(crate) fn detail_str(error: &ContractError, field: &str) -> Option<String> {
    match error.details.as_ref()?.fields.get(field)?.kind.as_ref()? {
        Kind::StringValue(value) => Some(value.clone()),
        _ => None,
    }
}

/// The number detail `field` of `error`.
pub(crate) fn detail_num(error: &ContractError, field: &str) -> Option<f64> {
    match error.details.as_ref()?.fields.get(field)?.kind.as_ref()? {
        Kind::NumberValue(value) => Some(*value),
        _ => None,
    }
}

/// The code of the error of `result`, which must fail.
pub(crate) fn code_of<T: std::fmt::Debug>(result: Result<T, ContractError>) -> String {
    result.expect_err("the call is refused").code
}

/// A unique directory, removed on drop.
pub(crate) struct TempDir {
    path: PathBuf,
}

impl TempDir {
    /// A new, empty, unique directory.
    pub(crate) fn new() -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let count = COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = format!("doric-storage-{}-{count}", std::process::id());
        let path = std::env::temp_dir().join(name);
        std::fs::create_dir_all(&path).expect("create the temporary directory");
        Self { path }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// A store opened in a new temporary directory, with the directory.
pub(crate) fn open_temp() -> (TempDir, doric_sqlite::SqliteEngine) {
    let dir = TempDir::new();
    let store = doric_sqlite::open(dir.path()).expect("open the store");
    (dir, store)
}

/// The documents fixture's type with indexes: `byTag[tag]`, and the unique
/// `byTitle[title]`.
pub(crate) const NOTE: &str = "a.note/v1";
/// The documents fixture's type without indexes.
pub(crate) const PLAIN: &str = "a.plain/v1";
/// The documents fixture's type with a two-field index: the non-unique
/// `byTagTitle[tag, title]`, and an unindexed `body`.
pub(crate) const PAIR: &str = "a.pair/v1";
/// `NOTE`'s indexes, the text inside `StorageTypeOption`'s braces.
pub(crate) const NOTE_INDEXES: &str = "indexes: { name: \"byTag\" fields: \"tag\" } \
     indexes: { name: \"byTitle\" fields: \"title\" unique: true }";
/// [`NOTE_INDEXES`] without `byTitle`: `byTag[tag]` only.
pub(crate) const NOTE_BY_TAG: &str = "indexes: { name: \"byTag\" fields: \"tag\" }";
/// [`NOTE_INDEXES`] without `byTag`: the unique `byTitle[title]` only.
pub(crate) const NOTE_BY_TITLE: &str =
    "indexes: { name: \"byTitle\" fields: \"title\" unique: true }";
/// [`NOTE_INDEXES`] with `byTag` on `[title]` instead of `[tag]`.
pub(crate) const NOTE_BY_TAG_ON_TITLE: &str = "indexes: { name: \"byTag\" fields: \"title\" } \
     indexes: { name: \"byTitle\" fields: \"title\" unique: true }";
/// [`NOTE_INDEXES`] in the other order: `byTitle`, then `byTag`.
pub(crate) const NOTE_REORDERED: &str = "indexes: { name: \"byTitle\" fields: \"title\" unique: true } \
     indexes: { name: \"byTag\" fields: \"tag\" }";

/// The documents fixture's set: `fixture.v1.Note` declares [`NOTE`] with
/// `note_indexes` and the fields `title` (1) and `tag` (2);
/// `fixture.v1.Plain` declares [`PLAIN`] with no index; `fixture.v1.Pair`
/// declares [`PAIR`] with `byTagTitle[tag, title]` and the fields `title`
/// (1), `tag` (2) and `body` (3).
pub(crate) fn documents_set(note_indexes: &str) -> Vec<u8> {
    documents_set_with_title(note_indexes, "string")
}

/// [`documents_set`] with `fixture.v1.Note`'s `title` (1) of the proto type
/// `title_type`.
pub(crate) fn documents_set_with_title(note_indexes: &str, title_type: &str) -> Vec<u8> {
    storage_set(&format!(
        "message Note {{\n\
           option (doric.platform.v1.storage_type) = {{ type: \"{NOTE}\" {note_indexes} }};\n\
           {title_type} title = 1;\n\
           string tag = 2;\n\
         }}\n\
         message Plain {{\n\
           option (doric.platform.v1.storage_type) = {{ type: \"{PLAIN}\" }};\n\
           string text = 1;\n\
         }}\n\
         message Pair {{\n\
           option (doric.platform.v1.storage_type) = {{ type: \"{PAIR}\" \
             indexes: {{ name: \"byTagTitle\" fields: \"tag\" fields: \"title\" }} }};\n\
           string title = 1;\n\
           string tag = 2;\n\
           string body = 3;\n\
         }}"
    ))
}

/// Registers `set` for the bundle `a` at generation 1 on `engine`.
pub(crate) async fn register_documents(engine: &doric_sqlite::SqliteEngine, set: Vec<u8>) {
    let registration =
        crate::register::prepare(&caller("a", 1), set).expect("the fixture's set is valid");
    crate::register::Registrations::default()
        .apply(engine, &Default::default(), registration)
        .await
        .expect("the fixture's set registers");
}

/// A store in a new temporary directory where the bundle `a` registered
/// [`documents_set`]`(`[`NOTE_INDEXES`]`)`, with the directory.
pub(crate) async fn documents_store() -> (TempDir, doric_sqlite::SqliteEngine) {
    let (dir, engine) = open_temp();
    register_documents(&engine, documents_set(NOTE_INDEXES)).await;
    (dir, engine)
}

/// The protobuf bytes of a `fixture.v1.Note` with `title` and `tag`.
pub(crate) fn note(title: &str, tag: &str) -> Vec<u8> {
    strings(&[(1, title), (2, tag)])
}

/// The protobuf bytes of a `fixture.v1.Pair` with `title`, `tag` and `body`.
pub(crate) fn pair(title: &str, tag: &str, body: &str) -> Vec<u8> {
    strings(&[(1, title), (2, tag), (3, body)])
}

/// The protobuf bytes of the string fields `fields`, by field number.
fn strings(fields: &[(u8, &str)]) -> Vec<u8> {
    let mut out = Vec::new();
    for &(number, text) in fields {
        out.push((number << 3) | 2);
        let mut length = text.len();
        while length >= 0x80 {
            out.push(u8::try_from(length & 0x7F).expect("seven bits") | 0x80);
            length >>= 7;
        }
        out.push(u8::try_from(length).expect("seven bits"));
        out.extend_from_slice(text.as_bytes());
    }
    out
}
