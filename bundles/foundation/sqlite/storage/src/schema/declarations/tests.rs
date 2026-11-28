//! S77a2: the pool of a descriptor set and the types it declares (T4.24).

use super::*;
use crate::{
    layout::IndexDeclaration,
    testing::{code_of, compile, detail_str, storage_set},
};

/// The declarations of `set` for `owner`.
fn declared(set: &[u8], owner: &str) -> Result<BTreeMap<String, TypeDeclaration>, ContractError> {
    declarations(&pool(set).expect("the set decodes"), owner)
}

/// A message `Note` of the type `type_id` with `indexes`, the text inside
/// `StorageTypeOption`'s braces, and `fields`, the text of its fields.
fn note(type_id: &str, indexes: &str, fields: &str) -> Vec<u8> {
    storage_set(&format!(
        "message Note {{\n\
           option (doric.platform.v1.storage_type) = {{ type: \"{type_id}\" {indexes} }};\n\
           {fields}\n\
         }}"
    ))
}

/// `indexes: { … }` of `name` over `fields`.
fn index(name: &str, fields: &[&str]) -> String {
    let fields: String = fields
        .iter()
        .map(|field| format!(" fields: \"{field}\""))
        .collect();
    format!("indexes: {{ name: \"{name}\"{fields} }}")
}

/// The fields of a note with every kind the tests index.
const FIELDS: &str = "\
    enum Kind { KIND_UNSPECIFIED = 0; KIND_A = 1; }\n\
    message Inner { string label = 1; }\n\
    int32 count = 1;\n\
    int64 total = 2;\n\
    string slug = 3;\n\
    bool done = 4;\n\
    bytes raw = 5;\n\
    Kind kind = 6;\n\
    google.protobuf.Timestamp at = 7;\n\
    google.protobuf.Duration took = 8;\n\
    google.protobuf.StringValue title = 9;\n\
    optional string maybe = 10;\n\
    Inner nested = 11;\n\
    repeated string tags = 12;\n\
    map<string, string> labels = 13;\n\
    google.protobuf.Struct meta = 14;\n\
    string project_id = 15;";

#[test]
fn a_set_over_the_limit_is_limit_exceeded_before_any_decoding() {
    let error = pool(&vec![0xFF; DESCRIPTOR_SET_BYTES + 1]).expect_err("over the limit");

    assert_eq!(error.code, "limit_exceeded");
    assert_eq!(
        detail_str(&error, "limit").as_deref(),
        Some("descriptorSet")
    );
}

#[test]
fn bytes_that_are_not_a_descriptor_set_are_invalid_input() {
    assert_eq!(
        code_of(pool(&vec![0xFF; DESCRIPTOR_SET_BYTES])),
        "invalid_input"
    );
    assert_eq!(code_of(pool(b"not a descriptor set")), "invalid_input");
}

#[test]
fn a_type_declares_its_message_and_indexes_in_order_with_an_empty_schema() {
    let set = note(
        "a.note/v1",
        "indexes: { name: \"byProject\" fields: \"projectId\" } \
         indexes: { name: \"bySlug\" fields: \"slug\" unique: true }",
        "string project_id = 1; string slug = 2;",
    );

    let declared = declared(&set, "a").expect("the set declares its type");

    let expected = TypeDeclaration {
        message_type: "fixture.v1.Note".to_owned(),
        indexes: vec![
            IndexDeclaration {
                name: "byProject".to_owned(),
                fields: vec!["projectId".to_owned()],
                unique: false,
            },
            IndexDeclaration {
                name: "bySlug".to_owned(),
                fields: vec!["slug".to_owned()],
                unique: true,
            },
        ],
        schema: String::new(),
    };
    assert_eq!(
        declared,
        BTreeMap::from([("a.note/v1".to_owned(), expected)])
    );
}

#[test]
fn a_type_of_another_namespace_is_not_owner_and_the_namespace_ends_at_a_slash() {
    let error =
        declared(&note("b.note/v1", "", "string slug = 1;"), "a").expect_err("another namespace");
    assert_eq!(error.code, "not_owner");
    assert_eq!(detail_str(&error, "type").as_deref(), Some("b.note/v1"));

    assert_eq!(
        code_of(declared(&note("ab.note/v1", "", "string slug = 1;"), "a")),
        "not_owner"
    );
    let declared = declared(&note("a/note", "", "string slug = 1;"), "a")
        .expect("the namespace of a/note is a");
    assert!(declared.contains_key("a/note"));
}

#[test]
fn a_stream_prefix_of_another_owner_is_not_owner_and_a_stream_declares_no_type() {
    let entry = |prefix: &str| {
        storage_set(&format!(
            "message Event {{\n\
               option (doric.platform.v1.stream_entry) = {{ prefix: \"{prefix}\" }};\n\
               string text = 1;\n\
             }}"
        ))
    };

    let error = declared(&entry("b.events/"), "a").expect_err("another owner");
    assert_eq!(error.code, "not_owner");
    assert_eq!(detail_str(&error, "prefix").as_deref(), Some("b.events/"));

    assert_eq!(declared(&entry("a.events/"), "a"), Ok(BTreeMap::new()));
}

#[test]
fn an_index_field_that_is_not_a_singular_scalar_path_is_invalid_input() {
    for path in ["tags", "labels", "nested", "meta", "missing", "project_id"] {
        let set = note("a.note/v1", &index("byField", &[path]), FIELDS);

        assert_eq!(code_of(declared(&set, "a")), "invalid_input", "{path}");
    }
}

#[test]
fn an_index_field_may_be_any_singular_scalar_enum_or_well_known_value() {
    let paths = [
        "count",
        "total",
        "slug",
        "done",
        "raw",
        "kind",
        "at",
        "took",
        "title",
        "maybe",
        "nested.label",
        "projectId",
    ];
    let indexes: String = paths
        .iter()
        .enumerate()
        .map(|(n, path)| index(&format!("i{n}"), &[path]))
        .collect::<Vec<_>>()
        .join(" ");

    let declared = declared(&note("a.note/v1", &indexes, FIELDS), "a")
        .expect("every path is a singular scalar");

    let fields: Vec<Vec<String>> = declared["a.note/v1"]
        .indexes
        .iter()
        .map(|index| index.fields.clone())
        .collect();
    let expected: Vec<Vec<String>> = paths.iter().map(|path| vec![(*path).to_owned()]).collect();
    assert_eq!(fields, expected);
}

#[test]
fn a_type_holds_at_most_16_indexes_of_at_most_8_fields() {
    let fields: String = (1..=9).map(|n| format!("string f{n} = {n};\n")).collect();
    let indexes = |count: usize| -> String {
        (0..count)
            .map(|n| index(&format!("i{n}"), &["f1"]))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let wide = |count: usize| -> String {
        let paths: Vec<String> = (1..=count).map(|n| format!("f{n}")).collect();
        let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
        index("wide", &paths)
    };

    assert!(declared(&note("a.note/v1", &indexes(MAX_INDEXES), &fields), "a").is_ok());
    assert_eq!(
        code_of(declared(
            &note("a.note/v1", &indexes(MAX_INDEXES + 1), &fields),
            "a"
        )),
        "invalid_input"
    );
    assert!(declared(&note("a.note/v1", &wide(MAX_INDEX_FIELDS), &fields), "a").is_ok());
    assert_eq!(
        code_of(declared(
            &note("a.note/v1", &wide(MAX_INDEX_FIELDS + 1), &fields),
            "a"
        )),
        "invalid_input"
    );
}

#[test]
fn two_indexes_of_one_name_are_invalid_input() {
    let indexes = format!(
        "{} {}",
        index("bySlug", &["slug"]),
        index("bySlug", &["count"])
    );

    assert_eq!(
        code_of(declared(&note("a.note/v1", &indexes, FIELDS), "a")),
        "invalid_input"
    );
}

#[test]
fn a_type_declared_by_two_messages_is_invalid_input() {
    let set = storage_set(
        "message One {\n\
           option (doric.platform.v1.storage_type) = { type: \"a.note/v1\" };\n\
           string slug = 1;\n\
         }\n\
         message Two {\n\
           option (doric.platform.v1.storage_type) = { type: \"a.note/v1\" };\n\
           string slug = 1;\n\
         }",
    );

    assert_eq!(code_of(declared(&set, "a")), "invalid_input");
}

#[test]
fn a_type_id_is_1_to_128_bytes() {
    let longest = format!("a.{}", "n".repeat(TYPE_ID_BYTES - 2));
    let too_long = format!("a.{}", "n".repeat(TYPE_ID_BYTES - 1));
    assert_eq!(too_long.len(), 129);

    assert!(declared(&note(&longest, "", "string slug = 1;"), "a").is_ok());
    assert_eq!(
        code_of(declared(&note(&too_long, "", "string slug = 1;"), "a")),
        "invalid_input"
    );
    assert_eq!(
        code_of(declared(&note("", "", "string slug = 1;"), "a")),
        "invalid_input"
    );
}

#[test]
fn a_set_without_the_options_declares_nothing() {
    let set =
        compile("syntax = \"proto3\";\npackage fixture.v1;\nmessage Plain { string text = 1; }\n");

    assert_eq!(declared(&set, "a"), Ok(BTreeMap::new()));
}

#[test]
fn an_index_with_no_fields_is_declared() {
    let set = note(
        "a.note/v1",
        "indexes: { name: \"all\" }",
        "string slug = 1;",
    );

    let declared = declared(&set, "a").expect("an index may have no fields");

    assert_eq!(
        declared["a.note/v1"].indexes,
        vec![IndexDeclaration {
            name: "all".to_owned(),
            fields: Vec::new(),
            unique: false,
        }]
    );
}
