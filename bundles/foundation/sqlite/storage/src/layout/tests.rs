//! S77a2: the schema, current and declaration keys; S77a3a: the document,
//! chunk and index keys, and the checks of an address (L5–L9).

use super::*;
use crate::keys::{self, Element};

/// `bundle/` followed by the tuple of `strings`.
fn key(bundle: &str, strings: &[&str]) -> Vec<u8> {
    let tuple: Vec<Element> = strings
        .iter()
        .map(|&string| Element::String(string.to_owned()))
        .collect();
    keys::key(bundle, &tuple).expect("a tuple of strings encodes")
}

fn contains(range: &doric_sqlite::KeyRange, key: &[u8]) -> bool {
    range.start.as_slice() <= key && key < range.end.as_slice()
}

#[test]
fn the_schema_current_and_declaration_keys_are_their_tuples_under_the_prefix() {
    assert_eq!(schema("a", "0f"), key("a", &["schema", "0f"]));
    assert_eq!(current("a"), key("a", &["schema.current"]));
    assert_eq!(declaration("a", "a.x/v1"), key("a", &["type", "a.x/v1"]));
}

#[test]
fn end_is_the_start_followed_by_0xff() {
    assert_eq!(end(b"a/x"), b"a/x\xff".to_vec());
    assert_eq!(end(b""), vec![0xFF]);
}

#[test]
fn under_schema_holds_the_schemas_and_not_current_or_another_bundle() {
    let range = under("a", &["schema"]);

    let start = key("a", &["schema"]);
    assert_eq!(range.end, end(&start));
    assert_eq!(range.start, start);
    assert!(!range.reverse && !range.keys_only);
    assert!(contains(&range, &key("a", &["schema", "0f"])));
    assert!(!contains(&range, &key("a", &["schema.current"])));
    assert!(!contains(&range, &key("ab", &["schema", "0f"])));
    assert!(!contains(&range, &key("b", &["schema", "0f"])));
}

#[test]
fn under_a_types_documents_holds_them_and_not_a_type_whose_id_extends_it() {
    let range = under("a", &["doc", "a.x/v1"]);

    assert!(contains(&range, &key("a", &["doc", "a.x/v1", "1"])));
    assert!(!contains(&range, &key("a", &["doc", "a.x/v10", "1"])));
}

const NOTE: &str = "a.note/v1";

fn string(text: &str) -> Element {
    Element::String(text.to_owned())
}

/// A type id of `bytes` bytes in the namespace `namespace`.
fn type_of(namespace: &str, bytes: usize) -> String {
    let id = format!("{namespace}.");
    let fill = bytes - id.len();
    format!("{id}{}", "x".repeat(fill))
}

fn detail(error: &ContractError, field: &str) -> Option<String> {
    crate::testing::detail_str(error, field)
}

#[test]
fn the_document_and_chunk_keys_are_their_tuples_under_the_prefix() {
    assert_eq!(
        document("a", NOTE, "n1"),
        keys::key("a", &[string("doc"), string(NOTE), string("n1")]).expect("a key")
    );
    assert_eq!(
        chunk("a", NOTE, "n1", 2),
        keys::key(
            "a",
            &[
                string("doc.chunk"),
                string(NOTE),
                string("n1"),
                Element::Number(2.0)
            ]
        )
        .expect("a key")
    );
}

#[test]
fn chunk_2_sorts_before_chunk_10() {
    assert!(chunk("a", NOTE, "n1", 2) < chunk("a", NOTE, "n1", 10));
}

#[test]
fn a_unique_index_key_has_no_id_and_no_prefix() {
    let key = index(NOTE, "byTitle", &[string("T1")], None).expect("the key encodes");

    let expected = keys::encode(&[string("idx"), string(NOTE), string("byTitle"), string("T1")])
        .expect("a tuple");
    assert_eq!(key, expected);
}

#[test]
fn a_non_unique_index_key_ends_with_the_id_and_has_no_prefix() {
    let key = index(NOTE, "byTag", &[string("x")], Some("n1")).expect("the key encodes");

    let expected = keys::encode(&[
        string("idx"),
        string(NOTE),
        string("byTag"),
        string("x"),
        string("n1"),
    ])
    .expect("a tuple");
    assert_eq!(key, expected);
}

#[test]
fn prefixed_puts_the_bundles_prefix_before_the_key() {
    let key = index(NOTE, "byTag", &[string("x")], Some("n1")).expect("the key encodes");

    assert_eq!(prefixed("a", &key), [b"a/".as_slice(), &key].concat());
}

#[test]
fn under_a_documents_chunks_holds_them_and_not_those_of_an_id_extending_it() {
    let range = under("a", &["doc.chunk", NOTE, "x"]);

    assert!(contains(&range, &chunk("a", NOTE, "x", 1)));
    assert!(contains(&range, &chunk("a", NOTE, "x", 10)));
    assert!(!contains(&range, &chunk("a", NOTE, "x1", 1)));
    assert!(!contains(&range, &document("a", NOTE, "x")));
}

#[test]
fn a_type_of_129_bytes_is_invalid_input() {
    let error = checked("a", &type_of("a", 129), "n1").expect_err("too long");

    assert_eq!(error.code, "invalid_input");
}

#[test]
fn a_type_of_another_namespace_is_not_owner_with_its_type() {
    let error = checked("a", "b.x/v1", "n1").expect_err("not the bundle's");

    assert_eq!(error.code, "not_owner");
    assert_eq!(detail(&error, "type").as_deref(), Some("b.x/v1"));
}

#[test]
fn an_id_of_513_bytes_is_invalid_input_with_its_id() {
    let id = "i".repeat(ID_BYTES + 1);

    let error = checked("a", NOTE, &id).expect_err("too long");

    assert_eq!(error.code, "invalid_input");
    assert_eq!(detail(&error, "id"), Some(id));
}

#[test]
fn an_id_of_512_bytes_and_an_empty_id_pass() {
    checked("a", NOTE, &"i".repeat(ID_BYTES)).expect("512 bytes pass");
    checked("a", NOTE, "").expect("an empty id passes");
}

#[test]
fn a_long_type_of_another_namespace_is_refused_for_its_length_first() {
    let error = checked("a", &type_of("b", 129), "n1").expect_err("too long");

    assert_eq!(error.code, "invalid_input");
}

/// An index key of `bytes` bytes: the unique `byTitle` of `NOTE` with one
/// string value. Each string element takes its tag, its bytes and a 2-byte
/// end (`keys::encode`).
fn index_key_of(bytes: usize) -> Result<Vec<u8>, ContractError> {
    let overhead = 4 * 3 + "idx".len() + NOTE.len() + "byTitle".len();
    let value = "v".repeat(bytes - overhead);
    index(NOTE, "byTitle", &[Element::String(value)], None)
}

#[test]
fn an_index_key_of_2049_bytes_is_limit_exceeded_and_2048_pass() {
    let key = index_key_of(INDEX_KEY_BYTES).expect("2,048 bytes pass");
    assert_eq!(key.len(), INDEX_KEY_BYTES);

    let error = index_key_of(INDEX_KEY_BYTES + 1).expect_err("2,049 bytes are refused");
    assert_eq!(error.code, "limit_exceeded");
    assert_eq!(detail(&error, "limit").as_deref(), Some("indexKey"));
}
