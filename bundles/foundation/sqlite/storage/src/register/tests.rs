//! S77a2: `Register`'s checks, its writes and the generation rule (T4.24);
//! in [`backfill`], S77a4a's rebuild of changed indexes.

mod backfill;

use std::ops::ControlFlow;

use doric_sqlite::{KeyRange, SqliteEngine};
use prost::Message as _;
use sha2::{Digest as _, Sha256};

use super::*;
use crate::{
    layout::{self, DocumentHeader, IndexDeclaration},
    testing::{TempDir, caller, open_temp, storage_set},
};

const NOTE: &str = "a.note/v1";

/// The lowercase SHA-256 hex of `bytes`.
fn sha256hex(bytes: &[u8]) -> String {
    doric_sqlite::hex(&Sha256::digest(bytes))
}

/// A set whose message `message` declares the type `type_id` with
/// `indexes`, the text inside `StorageTypeOption`'s braces, and `fields`.
fn set_of(message: &str, type_id: &str, indexes: &str, fields: &str) -> Vec<u8> {
    storage_set(&format!(
        "message {message} {{\n\
           option (doric.platform.v1.storage_type) = {{ type: \"{type_id}\" {indexes} }};\n\
           {fields}\n\
         }}"
    ))
}

const BY_PROJECT: &str = "indexes: { name: \"byProject\" fields: \"projectId\" }";
const BY_SLUG: &str = "indexes: { name: \"bySlug\" fields: \"slug\" unique: true }";
const NOTE_FIELDS: &str = "string project_id = 1; string slug = 2;";

/// A: `Note` declares `a.note/v1` with the index `byProject`.
fn set_a() -> Vec<u8> {
    set_of("Note", NOTE, BY_PROJECT, NOTE_FIELDS)
}

/// A′: A with the message renamed `Memo`.
fn set_a_renamed() -> Vec<u8> {
    set_of("Memo", NOTE, BY_PROJECT, NOTE_FIELDS)
}

/// A″: A with an unrelated field added.
fn set_a_extended() -> Vec<u8> {
    set_of(
        "Note",
        NOTE,
        BY_PROJECT,
        "string project_id = 1; string slug = 2; string extra = 3;",
    )
}

/// B: A with the index `bySlug` added.
fn set_b() -> Vec<u8> {
    set_of(
        "Note",
        NOTE,
        &format!("{BY_PROJECT} {BY_SLUG}"),
        NOTE_FIELDS,
    )
}

/// C: A with only the index `bySlug`.
fn set_c() -> Vec<u8> {
    set_of("Note", NOTE, BY_SLUG, NOTE_FIELDS)
}

fn by_project() -> IndexDeclaration {
    IndexDeclaration {
        name: "byProject".to_owned(),
        fields: vec!["projectId".to_owned()],
        unique: false,
    }
}

fn by_slug() -> IndexDeclaration {
    IndexDeclaration {
        name: "bySlug".to_owned(),
        fields: vec!["slug".to_owned()],
        unique: true,
    }
}

fn note_declaration(message: &str, indexes: Vec<IndexDeclaration>, set: &[u8]) -> TypeDeclaration {
    TypeDeclaration {
        message_type: format!("fixture.v1.{message}"),
        indexes,
        schema: sha256hex(set),
    }
}

/// `prepare`, then `apply`, for `bundle` at `generation`.
async fn register(
    registrations: &Registrations,
    engine: &SqliteEngine,
    bundle: &str,
    generation: u32,
    set: &[u8],
) -> Result<(), ContractError> {
    let registration = prepare(&caller(bundle, generation), set.to_vec())?;
    registrations
        .apply(engine, &crate::cache::Headers::default(), registration)
        .await
        .map(drop)
}

/// The value of `key`, or `None`.
async fn value(engine: &SqliteEngine, key: Vec<u8>) -> Option<Vec<u8>> {
    engine
        .read(move |txn| txn.get(&key))
        .await
        .expect("the read succeeds")
        .map(|(value, _)| value)
}

/// The stored declaration of `type_id` under `bundle`.
async fn declaration(
    engine: &SqliteEngine,
    bundle: &str,
    type_id: &str,
) -> Option<TypeDeclaration> {
    let bytes = value(engine, layout::declaration(bundle, type_id)).await?;
    Some(TypeDeclaration::decode(bytes.as_slice()).expect("a declaration"))
}

/// The hash `("schema.current")` of `bundle` holds.
async fn current(engine: &SqliteEngine, bundle: &str) -> Option<String> {
    let bytes = value(engine, layout::current(bundle)).await?;
    Some(String::from_utf8(bytes).expect("a UTF-8 hash"))
}

async fn schema(engine: &SqliteEngine, bundle: &str, set: &[u8]) -> Option<Vec<u8>> {
    value(engine, layout::schema(bundle, &sha256hex(set))).await
}

/// Every entry of `range`: key, value and version.
async fn entries(engine: &SqliteEngine, range: KeyRange) -> Vec<(Vec<u8>, Vec<u8>, f64)> {
    engine
        .read(move |txn| {
            let mut found = Vec::new();
            txn.range(&range, &mut |entry| {
                found.push((entry.key.to_vec(), entry.value.to_vec(), entry.version));
                ControlFlow::Continue(())
            })?;
            Ok(found)
        })
        .await
        .expect("the read succeeds")
}

/// The position of a write of its own: one more than the last write's.
async fn probe(engine: &SqliteEngine) -> f64 {
    engine
        .write(|txn| txn.put(b"z/p", b""))
        .await
        .expect("the probe is written")
        .1
}

fn fresh() -> (TempDir, SqliteEngine, Registrations) {
    let (dir, engine) = open_temp();
    (dir, engine, Registrations::default())
}

#[test]
fn the_platform_has_no_prefix_to_register() {
    let error = prepare(&caller("doric", 1), set_a()).expect_err("doric registers nothing");

    assert_eq!(error.code, "not_owner");
    assert_eq!(
        error.message,
        "storage/v2 has no prefix for the caller doric; it may call only Import, Inspect and Check."
    );
}

#[tokio::test]
async fn a_first_registration_stores_the_schema_current_and_the_declaration() {
    let (_dir, engine, registrations) = fresh();
    let a = set_a();

    register(&registrations, &engine, "a", 1, &a)
        .await
        .expect("A registers");

    assert_eq!(schema(&engine, "a", &a).await, Some(a.clone()));
    assert_eq!(current(&engine, "a").await, Some(sha256hex(&a)));
    assert_eq!(
        declaration(&engine, "a", NOTE).await,
        Some(note_declaration("Note", vec![by_project()], &a))
    );
}

#[tokio::test]
async fn registering_the_same_set_again_writes_nothing() {
    let (_dir, engine, registrations) = fresh();
    register(&registrations, &engine, "a", 1, &set_a())
        .await
        .expect("A registers");

    let before = probe(&engine).await;
    register(&registrations, &engine, "a", 1, &set_a())
        .await
        .expect("A registers again");
    let after = probe(&engine).await;

    assert_eq!(after, before + 1.0);
}

#[tokio::test]
async fn another_message_type_with_the_same_indexes_rewrites_the_declaration() {
    let (_dir, engine, registrations) = fresh();
    let (a, renamed) = (set_a(), set_a_renamed());
    register(&registrations, &engine, "a", 1, &a)
        .await
        .expect("A registers");

    register(&registrations, &engine, "a", 1, &renamed)
        .await
        .expect("A′ registers");

    assert_eq!(
        declaration(&engine, "a", NOTE).await,
        Some(note_declaration("Memo", vec![by_project()], &renamed))
    );
    assert_eq!(schema(&engine, "a", &a).await, None);
    assert_eq!(schema(&engine, "a", &renamed).await, Some(renamed.clone()));
    assert_eq!(current(&engine, "a").await, Some(sha256hex(&renamed)));
}

#[tokio::test]
async fn another_schema_with_the_same_indexes_rewrites_the_declaration() {
    let (_dir, engine, registrations) = fresh();
    let extended = set_a_extended();
    register(&registrations, &engine, "a", 1, &set_a())
        .await
        .expect("A registers");

    register(&registrations, &engine, "a", 1, &extended)
        .await
        .expect("A″ registers");

    assert_eq!(
        declaration(&engine, "a", NOTE).await,
        Some(note_declaration("Note", vec![by_project()], &extended))
    );
}

#[tokio::test]
async fn new_indexes_on_a_type_without_documents_are_declared_with_no_index_key() {
    let (_dir, engine, registrations) = fresh();
    let b = set_b();
    register(&registrations, &engine, "a", 1, &set_a())
        .await
        .expect("A registers");

    register(&registrations, &engine, "a", 1, &b)
        .await
        .expect("B registers");

    assert_eq!(
        declaration(&engine, "a", NOTE).await,
        Some(note_declaration("Note", vec![by_project(), by_slug()], &b))
    );
    assert_eq!(
        entries(&engine, layout::under("a", &["idx"])).await,
        Vec::new()
    );
}

#[tokio::test]
async fn a_lower_generation_changes_nothing_and_the_higher_one_still_registers() {
    let (_dir, engine, registrations) = fresh();
    let (b, c) = (set_b(), set_c());
    register(&registrations, &engine, "a", 1, &set_a())
        .await
        .expect("A registers");
    register(&registrations, &engine, "a", 2, &b)
        .await
        .expect("B registers");

    let before = probe(&engine).await;
    register(&registrations, &engine, "a", 1, &set_a())
        .await
        .expect("generation 1 answers Ok");
    let after = probe(&engine).await;

    assert_eq!(after, before + 1.0);
    assert_eq!(
        declaration(&engine, "a", NOTE).await,
        Some(note_declaration("Note", vec![by_project(), by_slug()], &b))
    );
    assert_eq!(current(&engine, "a").await, Some(sha256hex(&b)));

    register(&registrations, &engine, "a", 2, &c)
        .await
        .expect("C registers");

    assert_eq!(
        declaration(&engine, "a", NOTE).await,
        Some(note_declaration("Note", vec![by_slug()], &c))
    );
    assert_eq!(current(&engine, "a").await, Some(sha256hex(&c)));
}

#[tokio::test]
async fn the_generation_is_remembered_only_by_the_process() {
    let (_dir, engine, registrations) = fresh();
    let a = set_a();
    register(&registrations, &engine, "a", 1, &a)
        .await
        .expect("A registers");
    register(&registrations, &engine, "a", 2, &set_b())
        .await
        .expect("B registers");

    let restarted = Registrations::default();
    register(&restarted, &engine, "a", 1, &a)
        .await
        .expect("A registers again");

    assert_eq!(
        declaration(&engine, "a", NOTE).await,
        Some(note_declaration("Note", vec![by_project()], &a))
    );
    assert_eq!(current(&engine, "a").await, Some(sha256hex(&a)));
}

#[tokio::test]
async fn a_type_the_new_set_leaves_out_keeps_its_declaration_and_schema() {
    let (_dir, engine, registrations) = fresh();
    let task = |fields: &str| {
        format!(
            "message Task {{\n\
               option (doric.platform.v1.storage_type) = {{ type: \"a.task/v1\" }};\n\
               {fields}\n\
             }}"
        )
    };
    let both = storage_set(&format!(
        "message Note {{\n\
           option (doric.platform.v1.storage_type) = {{ type: \"{NOTE}\" {BY_PROJECT} }};\n\
           {NOTE_FIELDS}\n\
         }}\n{}",
        task("string title = 1;")
    ));
    let only_task = storage_set(&task("string title = 1; string extra = 2;"));
    register(&registrations, &engine, "a", 1, &both)
        .await
        .expect("A registers");

    register(&registrations, &engine, "a", 1, &only_task)
        .await
        .expect("B registers");

    assert_eq!(
        declaration(&engine, "a", NOTE).await,
        Some(note_declaration("Note", vec![by_project()], &both))
    );
    assert_eq!(schema(&engine, "a", &both).await, Some(both.clone()));
    assert_eq!(current(&engine, "a").await, Some(sha256hex(&only_task)));
    assert_eq!(
        declaration(&engine, "a", "a.task/v1").await,
        Some(note_declaration("Task", Vec::new(), &only_task))
    );
}

#[tokio::test]
async fn a_registration_writes_only_under_its_bundles_prefix() {
    let (_dir, engine, registrations) = fresh();
    let of_b = |fields: &str| set_of("Note", "b.note/v1", BY_PROJECT, fields);
    register(&registrations, &engine, "a", 1, &set_a())
        .await
        .expect("a registers");
    register(&registrations, &engine, "b", 1, &of_b(NOTE_FIELDS))
        .await
        .expect("b registers");
    let prefix_a = KeyRange {
        start: b"a/".to_vec(),
        end: b"a0".to_vec(),
        ..KeyRange::default()
    };
    let before = entries(&engine, prefix_a.clone()).await;

    register(
        &registrations,
        &engine,
        "b",
        1,
        &of_b("string project_id = 1; string other = 2;"),
    )
    .await
    .expect("b registers again");

    assert!(!before.is_empty());
    assert_eq!(entries(&engine, prefix_a).await, before);
    assert_eq!(current(&engine, "a").await, Some(sha256hex(&set_a())));
}

#[tokio::test]
async fn a_failed_registration_does_not_raise_the_generation() {
    let (_dir, engine, registrations) = fresh();
    let extended = set_a_extended();
    register(&registrations, &engine, "a", 1, &set_a())
        .await
        .expect("A registers");
    // Two notes whose `slug` (2) is "s": B's unique `bySlug` refuses them.
    let header = DocumentHeader {
        revision: 1,
        value_size: 3,
        chunk: vec![0x12, 1, b's'],
        ..DocumentHeader::default()
    }
    .encode_to_vec();
    engine
        .write(move |txn| {
            for id in ["1", "2"] {
                txn.put(&layout::document("a", NOTE, id), &header)?;
            }
            Ok(())
        })
        .await
        .expect("the documents are planted");
    let foreign = set_of("Note", "b.note/v1", BY_PROJECT, NOTE_FIELDS);

    let refused = register(&registrations, &engine, "a", 3, &foreign).await;
    assert_eq!(refused.expect_err("another namespace").code, "not_owner");
    let refused = register(&registrations, &engine, "a", 3, &set_b()).await;
    assert_eq!(refused.expect_err("a shared slug").code, "unique_conflict");
    register(&registrations, &engine, "a", 2, &extended)
        .await
        .expect("A″ registers");

    assert_eq!(
        declaration(&engine, "a", NOTE).await,
        Some(note_declaration("Note", vec![by_project()], &extended))
    );
    assert_eq!(current(&engine, "a").await, Some(sha256hex(&extended)));
}

#[tokio::test]
async fn an_empty_descriptor_set_is_stored_and_made_current() {
    let (_dir, engine, registrations) = fresh();

    register(&registrations, &engine, "a", 1, b"")
        .await
        .expect("an empty set registers");

    assert_eq!(schema(&engine, "a", b"").await, Some(Vec::new()));
    assert_eq!(current(&engine, "a").await, Some(sha256hex(b"")));
}
