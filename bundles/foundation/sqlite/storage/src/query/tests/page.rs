//! S77a3b: a page's checks in the transaction (Q5, Q6, Q12), its items
//! (Q14, Q16, Q17) and its cursor (Q15).

use super::*;
use crate::{
    keys,
    layout::{CHUNK_BYTES, index},
    testing::{PAIR, PLAIN, documents_store, note, pair},
};

const ARITY: &str = "has 1 fields: equality takes the leading ones and a range the next one.";

async fn refused_page(engine: &SqliteEngine, plan: Plan) -> ContractError {
    page_items(engine, plan, usize::MAX)
        .await
        .expect_err("the page is refused")
}

/// The bytes of `index(type, name, values, id)` after `("idx", type, name)`.
fn after_prefix(type_id: &str, name: &str, values: &[Element], id: Option<&str>) -> Vec<u8> {
    let key = index(type_id, name, values, id).expect("an index key");
    let prefix =
        keys::encode(&[element("idx"), element(type_id), element(name)]).expect("a prefix");
    assert!(key.starts_with(&prefix));
    key[prefix.len()..].to_vec()
}

fn unpadded(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[tokio::test]
async fn an_undeclared_type_is_unknown_type() {
    let (_dir, engine) = documents_store().await;

    let error = refused_page(&engine, plan("a.other/v1", "byTag", 10)).await;

    assert_eq!(
        code_and_message(&error),
        ("unknown_type", "Storage type a.other/v1 is not defined.")
    );
    assert_eq!(detail_str(&error, "type").as_deref(), Some("a.other/v1"));
}

#[tokio::test]
async fn an_undeclared_index_is_refused() {
    let (_dir, engine) = documents_store().await;

    let error = refused_page(&engine, plan(NOTE, "byNothing", 10)).await;
    assert_eq!(
        code_and_message(&error),
        (
            "invalid_input",
            "Type a.note/v1 has no declared index \"byNothing\"."
        )
    );

    let error = refused_page(&engine, plan(PLAIN, "byTag", 10)).await;
    assert_eq!(
        code_and_message(&error),
        (
            "invalid_input",
            "Type a.plain/v1 has no declared index \"byTag\"."
        )
    );
}

#[tokio::test]
async fn more_values_than_the_index_takes_are_refused() {
    let (_dir, engine) = documents_store().await;
    let message = format!("The index \"byTag\" of a.note/v1 {ARITY}");

    let two_equals = Plan {
        equals: vec![element("x"), element("y")],
        ..plan(NOTE, "byTag", 10)
    };
    let error = refused_page(&engine, two_equals).await;
    assert_eq!(
        code_and_message(&error),
        ("invalid_input", message.as_str())
    );

    let equals_and_range = Plan {
        equals: vec![element("x")],
        range: Some(Range {
            gt: Some(element("a")),
            ..Range::default()
        }),
        ..plan(NOTE, "byTag", 10)
    };
    let error = refused_page(&engine, equals_and_range).await;
    assert_eq!(
        code_and_message(&error),
        ("invalid_input", message.as_str())
    );

    let equals_and_empty_range = Plan {
        equals: vec![element("x")],
        range: Some(Range::default()),
        ..plan(NOTE, "byTag", 10)
    };
    let error = refused_page(&engine, equals_and_empty_range).await;
    assert_eq!(
        code_and_message(&error),
        ("invalid_input", message.as_str())
    );
}

#[tokio::test]
async fn the_page_checks_run_in_their_order() {
    let (_dir, engine) = documents_store().await;
    let many_equals = vec![element("x"); 5];

    // The type before the index.
    let error = refused_page(&engine, plan("a.other/v1", "byNothing", 10)).await;
    assert_eq!(error.code, "unknown_type");

    // The index before the arity.
    let error = refused_page(
        &engine,
        Plan {
            equals: many_equals.clone(),
            ..plan(NOTE, "byNothing", 10)
        },
    )
    .await;
    assert_eq!(
        error.message,
        "Type a.note/v1 has no declared index \"byNothing\"."
    );

    // The arity before the cursor.
    let error = refused_page(
        &engine,
        Plan {
            equals: many_equals,
            cursor: Some(vec![0xFF]),
            ..plan(NOTE, "byTag", 10)
        },
    )
    .await;
    assert_eq!(
        error.message,
        format!("The index \"byTag\" of a.note/v1 {ARITY}")
    );
}

#[tokio::test]
async fn a_cursor_outside_the_bounds_is_refused() {
    let (_dir, engine) = documents_store().await;
    let tagged: Vec<_> = ["a", "b", "c"]
        .into_iter()
        .map(|id| (NOTE, id.to_owned(), note(&format!("t{id}"), "x")))
        .collect();
    put_owned(&engine, &tagged).await;
    put_all(&engine, &[(NOTE, "d", note("td", "y"))]).await;
    let of_x = Plan {
        equals: vec![element("x")],
        ..plan(NOTE, "byTag", 2)
    };
    let (cursor, _) = ids_page(&engine, of_x).await;
    let cursor = cursor_bytes(&cursor.expect("a third x follows"));

    let error = refused_page(
        &engine,
        Plan {
            equals: vec![element("y")],
            cursor: Some(cursor),
            ..plan(NOTE, "byTag", 2)
        },
    )
    .await;

    assert_eq!(
        code_and_message(&error),
        ("invalid_input", "The cursor is outside the query's bounds.")
    );
}

#[tokio::test]
async fn the_page_item_comes_first_then_each_document_with_its_chunks() {
    let (_dir, engine) = documents_store().await;
    let large = pair("t1", "x", &"b".repeat(CHUNK_BYTES + 10));
    let small = pair("t2", "x", "small");
    assert!(large.len() > CHUNK_BYTES);
    put_all(
        &engine,
        &[(PAIR, "p1", large.clone()), (PAIR, "p2", small.clone())],
    )
    .await;

    let items = page_items(&engine, plan(PAIR, "byTagTitle", 10), usize::MAX)
        .await
        .expect("the page reads");

    assert_eq!(items[0], Item::Page(QueryPage { next_cursor: None }));
    let mut documents: Vec<(StoredDocument, Vec<u8>)> = Vec::new();
    for item in &items[1..] {
        match item {
            Item::Document(document) => documents.push((document.clone(), Vec::new())),
            Item::Chunk(bytes) => {
                assert!(!bytes.is_empty(), "a chunk holds bytes");
                documents
                    .last_mut()
                    .expect("a chunk follows its document")
                    .1
                    .extend_from_slice(bytes);
            }
            Item::Page(_) => panic!("a second page item"),
        }
    }
    let stored = |id: &str| StoredDocument {
        r#type: PAIR.to_owned(),
        id: id.to_owned(),
        revision: 1.0,
    };
    assert_eq!(
        documents,
        vec![(stored("p1"), large), (stored("p2"), small)]
    );
}

#[tokio::test]
async fn the_cursor_of_a_unique_index_is_its_values() {
    let (_dir, engine) = documents_store().await;
    put_owned(&engine, &titles(3)).await;

    let (cursor, ids) = ids_page(&engine, plan(NOTE, "byTitle", 2)).await;

    assert_eq!(ids, ["n0", "n1"]);
    assert_eq!(
        cursor,
        Some(unpadded(&after_prefix(
            NOTE,
            "byTitle",
            &[element("t1")],
            None
        )))
    );
}

#[tokio::test]
async fn the_cursor_of_a_non_unique_index_is_its_values_then_the_id() {
    let (_dir, engine) = documents_store().await;
    put_owned(&engine, &titles(3)).await;

    let (cursor, ids) = ids_page(&engine, plan(NOTE, "byTag", 2)).await;

    assert_eq!(ids, ["n0", "n1"]);
    assert_eq!(
        cursor,
        Some(unpadded(&after_prefix(
            NOTE,
            "byTag",
            &[element("x")],
            Some("n1")
        )))
    );
}

#[tokio::test]
async fn an_emit_that_breaks_after_the_page_item_stops_with_ok() {
    let (_dir, engine) = documents_store().await;
    put_owned(&engine, &titles(3)).await;

    let items = page_items(&engine, plan(NOTE, "byTitle", 2), 1)
        .await
        .expect("a break is Ok");

    assert_eq!(items.len(), 1);
    assert!(matches!(items[0], Item::Page(_)), "{items:?}");
}

#[tokio::test]
async fn an_empty_result_is_one_page_item_with_no_cursor() {
    let (_dir, engine) = documents_store().await;
    put_all(&engine, &[(NOTE, "n1", note("t1", "x"))]).await;

    let none = Plan {
        equals: vec![element("absent")],
        ..plan(NOTE, "byTag", 10)
    };
    let items = page_items(&engine, none, usize::MAX)
        .await
        .expect("the page reads");

    assert_eq!(items, vec![Item::Page(QueryPage { next_cursor: None })]);

    let items = page_items(&engine, plan(PAIR, "byTagTitle", 10), usize::MAX)
        .await
        .expect("the page reads");
    assert_eq!(items, vec![Item::Page(QueryPage { next_cursor: None })]);
}
