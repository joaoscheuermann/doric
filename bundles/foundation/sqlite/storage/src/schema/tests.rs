use prost::{Message as _, bytes::Bytes};
use prost_reflect::{DescriptorPool, DynamicMessage, Value};
use serde_json::{Value as Json, json};

use super::*;
use crate::keys;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

/// The fixture's descriptors, compiled by `protox`, and their descriptor set's bytes.
fn fixture() -> (DescriptorPool, Vec<u8>) {
    let set = protox::compile([format!("{FIXTURES}/index_keys.proto")], [FIXTURES])
        .expect("the fixture compiles");
    let bytes = set.encode_to_vec();
    let pool = DescriptorPool::from_file_descriptor_set(set).expect("a descriptor pool");
    (pool, bytes)
}

fn sample() -> MessageDescriptor {
    fixture()
        .0
        .get_message_by_name("fixture.v1.Sample")
        .expect("fixture.v1.Sample")
}

fn message(desc: &MessageDescriptor, fields: Vec<(&str, Value)>) -> DynamicMessage {
    let mut message = DynamicMessage::new(desc.clone());
    for (name, value) in fields {
        message.set_field_by_name(name, value);
    }
    message
}

/// The message of `desc`'s field `field`, with `fields` set.
fn inner(desc: &MessageDescriptor, field: &str, fields: Vec<(&str, Value)>) -> Value {
    let kind = desc.get_field_by_name(field).expect(field).kind();
    Value::Message(message(kind.as_message().expect("a message field"), fields))
}

fn encoded(desc: &MessageDescriptor, fields: Vec<(&str, Value)>) -> Vec<u8> {
    message(desc, fields).encode_to_vec()
}

fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn names(fields: &[&str]) -> Vec<String> {
    fields.iter().map(|&field| field.to_owned()).collect()
}

fn s(value: &str) -> Element {
    Element::String(value.to_owned())
}

#[test]
fn fields_without_presence_appear_at_their_defaults() {
    let json = json_form(&sample(), &[]).expect("the empty value has a JSON form");

    for field in [
        "aDouble",
        "aFloat",
        "anInt32",
        "aUint32",
        "aSint32",
        "aFixed32",
        "anSfixed32",
    ] {
        assert_eq!(json[field].as_f64(), Some(0.0), "{field}");
    }
    for field in ["anInt64", "aUint64", "aSint64", "aFixed64", "anSfixed64"] {
        assert_eq!(json[field], json!("0"), "{field}");
    }
    assert_eq!(json["aBool"], json!(false));
    assert_eq!(json["aString"], json!(""));
    assert_eq!(json["someBytes"], json!(""));
    assert_eq!(json["kind"], json!("KIND_UNSPECIFIED"));
    assert_eq!(json["tags"], json!([]));
    for field in ["maybe", "nested", "at", "took", "wrapped"] {
        assert_eq!(json.get(field), None, "{field} is absent");
    }
}

#[test]
fn values_take_protobufs_json_form() {
    let sample = sample();
    let second_and_a_half = || {
        vec![
            ("seconds", Value::I64(1)),
            ("nanos", Value::I32(500_000_000)),
        ]
    };
    let value = encoded(
        &sample,
        vec![
            ("an_int64", Value::I64(-5)),
            ("a_uint64", Value::U64(7)),
            ("some_bytes", Value::Bytes(Bytes::from_static(&[1, 2, 3]))),
            ("kind", Value::EnumNumber(2)),
            ("at", inner(&sample, "at", second_and_a_half())),
            ("took", inner(&sample, "took", second_and_a_half())),
            (
                "wrapped",
                inner(&sample, "wrapped", vec![("value", text("w"))]),
            ),
            ("maybe", text("m")),
        ],
    );
    let json = json_form(&sample, &value).expect("a JSON form");

    assert_eq!(json["anInt64"], json!("-5"));
    assert_eq!(json["aUint64"], json!("7"));
    assert_eq!(json["someBytes"], json!("AQID"));
    assert_eq!(json["kind"], json!("KIND_TASK"));
    assert_eq!(json["at"], json!("1970-01-01T00:00:01.500Z"));
    // protobuf-es writes 0, 3, 6 or 9 fractional digits, as the proto3 JSON mapping says.
    assert_eq!(json["took"], json!("1.500s"));
    assert_eq!(json["wrapped"], json!("w"));
    assert_eq!(json["maybe"], json!("m"));
}

#[test]
fn a_value_that_does_not_decode_is_invalid_input() {
    let error = json_form(&sample(), &[0xFF]).expect_err("refused");
    assert_eq!(error.code, "invalid_input");
}

#[test]
fn index_values_follow_their_paths() {
    let sample = sample();
    let value = encoded(
        &sample,
        vec![
            (
                "nested",
                inner(&sample, "nested", vec![("label", text("x"))]),
            ),
            ("tags", Value::List(vec![text("t0"), text("t1")])),
            ("a_bool", Value::Bool(true)),
            ("an_int32", Value::I32(3)),
        ],
    );
    let json = json_form(&sample, &value).expect("a JSON form");
    let fields = names(&[
        "nested.label",
        "tags.0",
        "tags.1",
        "tags.01",
        "tags.2",
        "nested.none",
        "at.seconds",
        "maybe",
        "aBool",
        "anInt32",
    ]);

    assert_eq!(
        index_values(&json, &fields),
        Ok(vec![
            s("x"),
            s("t0"),
            s("t1"),
            Element::Null,
            Element::Null,
            Element::Null,
            Element::Null,
            Element::Null,
            Element::Bool(true),
            Element::Number(3.0),
        ])
    );
    assert_eq!(
        index_values(&json!({ "a": null }), &names(&["a"])),
        Ok(vec![Element::Null])
    );
    for field in ["nested", "tags"] {
        let error = index_values(&json, &names(&[field])).expect_err(field);
        assert_eq!(error.code, "invalid_index_value", "{field}");
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let word = chunk.iter().enumerate().fold(0u32, |word, (index, &byte)| {
            word | u32::from(byte) << (16 - 8 * index)
        });
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(char::from(
                    ALPHABET[(word >> (18 - 6 * index)) as usize & 63],
                ));
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn element_json(element: &Element) -> Json {
    match element {
        Element::Null => Json::Null,
        Element::Bool(value) => json!(value),
        Element::Number(value) => json!(value),
        Element::String(value) => json!(value),
    }
}

/// An index case of the golden file: its name, the fields of its value
/// (by proto name) and the index's fields (by JSON name).
type IndexCase = (&'static str, Vec<(&'static str, Value)>, Vec<&'static str>);

/// The golden document: tuples, the platform's keys, the fixture's
/// descriptor set and the index keys of its values.
fn golden() -> String {
    let (pool, descriptor_set) = fixture();
    let sample = pool
        .get_message_by_name("fixture.v1.Sample")
        .expect("Sample");
    let n = Element::Number;

    let tuples: Vec<Vec<Element>> = vec![
        vec![],
        vec![Element::Null],
        vec![Element::Bool(false)],
        vec![Element::Bool(true)],
        vec![n(0.0)],
        vec![n(-1.5)],
        vec![n(-1e308)],
        vec![n(1e308)],
        vec![n(5e-324)],
        vec![n(9_007_199_254_740_991.0)],
        vec![s("")],
        vec![s("a\0b")],
        vec![s("é😀")],
        vec![n(1.0), s("x"), Element::Null, Element::Bool(true)],
        vec![s("meta"), s("layout")],
        vec![s("meta"), s("migration")],
        vec![s("meta"), s("identity")],
        vec![s("meta"), s("host")],
    ];
    let tuples: Vec<Json> = tuples
        .iter()
        .map(|tuple| {
            let bytes = keys::encode(tuple).expect("an encodable tuple");
            assert_eq!(keys::decode(&bytes).as_ref(), Ok(tuple), "{tuple:?}");
            json!({
                "tuple": tuple.iter().map(element_json).collect::<Vec<_>>(),
                "bytes": hex(&bytes),
            })
        })
        .collect();

    let platform_key =
        |name: &str| hex(&keys::key("doric", &[s("meta"), s(name)]).expect("a platform key"));

    let half = || {
        vec![
            ("seconds", Value::I64(1_700_000_000)),
            ("nanos", Value::I32(500_000_000)),
        ]
    };
    let cases: Vec<IndexCase> = vec![
        (
            "every scalar kind",
            vec![
                ("a_double", Value::F64(1.5)),
                ("a_float", Value::F32(0.25)),
                ("an_int32", Value::I32(-3)),
                ("an_int64", Value::I64(-4)),
                ("a_uint32", Value::U32(5)),
                ("a_uint64", Value::U64(6)),
                ("a_sint32", Value::I32(-7)),
                ("a_sint64", Value::I64(-8)),
                ("a_fixed32", Value::U32(9)),
                ("a_fixed64", Value::U64(10)),
                ("an_sfixed32", Value::I32(-11)),
                ("an_sfixed64", Value::I64(-12)),
                ("a_bool", Value::Bool(true)),
                ("a_string", text("text")),
                ("some_bytes", Value::Bytes(Bytes::from_static(&[0, 1, 2]))),
            ],
            vec![
                "aDouble",
                "aFloat",
                "anInt32",
                "anInt64",
                "aUint32",
                "aUint64",
                "aSint32",
                "aSint64",
                "aFixed32",
                "aFixed64",
                "anSfixed32",
                "anSfixed64",
                "aBool",
                "aString",
                "someBytes",
            ],
        ),
        (
            "an enum",
            vec![("kind", Value::EnumNumber(1))],
            vec!["kind"],
        ),
        (
            "64-bit integers beyond 2^53",
            vec![
                ("an_int64", Value::I64(9_007_199_254_740_993)),
                ("a_uint64", Value::U64(u64::MAX)),
            ],
            vec!["anInt64", "aUint64"],
        ),
        (
            "bytes",
            vec![(
                "some_bytes",
                Value::Bytes(Bytes::from_static(&[0xFB, 0xFF, 0x00])),
            )],
            vec!["someBytes"],
        ),
        (
            "a timestamp",
            vec![("at", inner(&sample, "at", half()))],
            vec!["at"],
        ),
        (
            "a duration",
            vec![("took", inner(&sample, "took", half()))],
            vec!["took"],
        ),
        (
            "a wrapper",
            vec![(
                "wrapped",
                inner(&sample, "wrapped", vec![("value", text("w"))]),
            )],
            vec!["wrapped"],
        ),
        (
            "fields at their defaults",
            vec![],
            vec![
                "aDouble",
                "anInt32",
                "anInt64",
                "aBool",
                "aString",
                "someBytes",
                "kind",
            ],
        ),
        (
            "a missing nested path",
            vec![],
            vec!["nested.label", "maybe", "at"],
        ),
        (
            "a nested field and an array element",
            vec![
                (
                    "nested",
                    inner(&sample, "nested", vec![("label", text("x"))]),
                ),
                ("tags", Value::List(vec![text("t0"), text("t1")])),
            ],
            vec!["nested.label", "tags.1"],
        ),
        (
            "a set optional field",
            vec![("maybe", text("m"))],
            vec!["maybe"],
        ),
        (
            "a double at -0",
            vec![("a_double", Value::F64(-0.0))],
            vec!["aDouble"],
        ),
    ];
    let index_keys: Vec<Json> = cases
        .into_iter()
        .map(|(name, fields, index)| {
            let value = encoded(&sample, fields);
            let index = names(&index);
            let json = json_form(&sample, &value).expect(name);
            let values = index_values(&json, &index).expect(name);
            let key = keys::encode(&values).expect(name);
            assert_eq!(keys::decode(&key), Ok(values), "{name} decodes back");
            json!({
                "name": name,
                "messageType": "fixture.v1.Sample",
                "value": base64(&value),
                "fields": index,
                "key": hex(&key),
            })
        })
        .collect();

    let document = json!({
        "tuples": tuples,
        "platformKeys": {
            "layout": platform_key("layout"),
            "migration": platform_key("migration"),
            "identity": platform_key("identity"),
            "host": platform_key("host"),
        },
        "descriptorSet": base64(&descriptor_set),
        "indexKeys": index_keys,
    });
    let mut text = serde_json::to_string_pretty(&document).expect("JSON");
    text.push('\n');
    text
}

/// The one golden test (spec, "The golden file"): with
/// `DORIC_WRITE_GOLDEN=1` it writes `tests/fixtures/index-keys.json`;
/// otherwise the file must hold exactly what the engine produces.
#[test]
fn the_golden_file_holds_what_the_engine_produces() {
    let path = format!("{FIXTURES}/index-keys.json");
    let generated = golden();

    if std::env::var("DORIC_WRITE_GOLDEN").as_deref() == Ok("1") {
        std::fs::write(&path, &generated).expect("the golden file is written");
    } else {
        let on_disk = std::fs::read(&path).unwrap_or_default();
        assert!(
            on_disk == generated.as_bytes(),
            "{path} differs from what the engine produces; run with DORIC_WRITE_GOLDEN=1 to rewrite it"
        );
    }
}

mod pools;
