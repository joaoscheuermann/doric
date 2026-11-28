//! S77a3b: which entries a page selects and in what order, across pages
//! (Q7–Q11, Q13).

use super::*;
use crate::testing::{PAIR, documents_store, note, pair};

/// Ten notes whose ids run against their titles: `id<9-k>` has `t<k>`.
fn ten_reversed() -> Vec<(&'static str, String, Vec<u8>)> {
    (0..10)
        .map(|k| (NOTE, format!("id{}", 9 - k), note(&format!("t{k}"), "x")))
        .collect()
}

fn ids(names: &[&str]) -> Vec<String> {
    names.iter().map(|&name| name.to_owned()).collect()
}

#[tokio::test]
async fn ten_documents_come_in_pages_of_three_in_key_order() {
    let (_dir, engine) = documents_store().await;
    put_owned(&engine, &ten_reversed()).await;

    let pages = all_pages(&engine, plan(NOTE, "byTitle", 3)).await;

    assert_eq!(
        pages,
        vec![
            (ids(&["id9", "id8", "id7"]), true),
            (ids(&["id6", "id5", "id4"]), true),
            (ids(&["id3", "id2", "id1"]), true),
            (ids(&["id0"]), false),
        ]
    );
}

#[tokio::test]
async fn a_page_that_ends_the_list_exactly_has_no_cursor() {
    let (_dir, engine) = documents_store().await;
    put_owned(&engine, &titles(9)).await;

    let pages = all_pages(&engine, plan(NOTE, "byTitle", 3)).await;

    assert_eq!(
        pages,
        vec![
            (ids(&["n0", "n1", "n2"]), true),
            (ids(&["n3", "n4", "n5"]), true),
            (ids(&["n6", "n7", "n8"]), false),
        ]
    );
}

#[tokio::test]
async fn desc_reads_from_the_last_key_and_its_cursors_continue() {
    let (_dir, engine) = documents_store().await;
    put_owned(&engine, &ten_reversed()).await;

    let pages = all_pages(
        &engine,
        Plan {
            reverse: true,
            ..plan(NOTE, "byTitle", 4)
        },
    )
    .await;

    assert_eq!(
        pages,
        vec![
            (ids(&["id0", "id1", "id2", "id3"]), true),
            (ids(&["id4", "id5", "id6", "id7"]), true),
            (ids(&["id8", "id9"]), false),
        ]
    );
}

#[tokio::test]
async fn equals_and_a_range_select_the_tuples_in_their_bounds() {
    let (_dir, engine) = documents_store().await;
    let mut documents: Vec<_> = (1..=5)
        .map(|n| (PAIR, format!("a{n}"), pair(&n.to_string(), "a", "")))
        .collect();
    documents.push((PAIR, "b3".to_owned(), pair("3", "b", "")));
    documents.push((PAIR, "c1".to_owned(), pair("1", "c", "")));
    put_owned(&engine, &documents).await;
    let s = |text: &str| Some(element(text));
    let cases = [
        (
            Range {
                gt: s("2"),
                ..Range::default()
            },
            ids(&["a3", "a4", "a5"]),
        ),
        (
            Range {
                gte: s("2"),
                ..Range::default()
            },
            ids(&["a2", "a3", "a4", "a5"]),
        ),
        (
            Range {
                lt: s("4"),
                ..Range::default()
            },
            ids(&["a1", "a2", "a3"]),
        ),
        (
            Range {
                lte: s("4"),
                ..Range::default()
            },
            ids(&["a1", "a2", "a3", "a4"]),
        ),
        (
            Range {
                gt: s("1"),
                lt: s("5"),
                ..Range::default()
            },
            ids(&["a2", "a3", "a4"]),
        ),
        (Range::default(), ids(&["a1", "a2", "a3", "a4", "a5"])),
    ];

    for (range, expected) in cases {
        let selection = Plan {
            equals: vec![element("a")],
            range: Some(range.clone()),
            ..plan(PAIR, "byTagTitle", 10)
        };
        let (cursor, selected) = ids_page(&engine, selection).await;
        assert_eq!((cursor, selected), (None, expected), "{range:?}");
    }

    let both = Plan {
        equals: vec![element("a"), element("3")],
        ..plan(PAIR, "byTagTitle", 10)
    };
    assert_eq!(ids_page(&engine, both).await, (None, ids(&["a3"])));
}

#[tokio::test]
async fn a_range_alone_selects_the_first_field() {
    let (_dir, engine) = documents_store().await;
    put_owned(&engine, &titles(5)).await;

    let selection = Plan {
        range: Some(Range {
            gt: Some(element("t1")),
            lte: Some(element("t3")),
            ..Range::default()
        }),
        ..plan(NOTE, "byTitle", 10)
    };

    assert_eq!(
        ids_page(&engine, selection).await,
        (None, ids(&["n2", "n3"]))
    );
}

#[tokio::test]
async fn equal_values_of_a_non_unique_index_sort_by_id_bytewise() {
    let (_dir, engine) = documents_store().await;
    let mut documents: Vec<_> = ["b", "a", "B", "é", "ab"]
        .into_iter()
        .map(|id| (NOTE, id.to_owned(), note(&format!("t-{id}"), "x")))
        .collect();
    documents.push((NOTE, "z".to_owned(), note("t-z", "w")));
    documents.push((NOTE, "0".to_owned(), note("t-0", "y")));
    put_owned(&engine, &documents).await;

    let of_x = Plan {
        equals: vec![element("x")],
        ..plan(NOTE, "byTag", 2)
    };
    assert_eq!(
        all_pages(&engine, of_x).await,
        vec![
            (ids(&["B", "a"]), true),
            (ids(&["ab", "b"]), true),
            (ids(&["é"]), false),
        ]
    );

    assert_eq!(
        ids_page(&engine, plan(NOTE, "byTag", 10)).await,
        (None, ids(&["z", "B", "a", "ab", "b", "é", "0"]))
    );
}

#[tokio::test]
async fn a_cursor_continues_over_documents_committed_between_pages() {
    let (_dir, engine) = documents_store().await;
    let odd: Vec<_> = [1, 3, 5, 7]
        .into_iter()
        .map(|n| (NOTE, format!("n{n}"), note(&format!("t{n}"), "x")))
        .collect();
    put_owned(&engine, &odd).await;
    let (cursor, first) = ids_page(&engine, plan(NOTE, "byTitle", 2)).await;
    assert_eq!(first, ids(&["n1", "n3"]));

    put_all(
        &engine,
        &[(NOTE, "n4", note("t4", "x")), (NOTE, "n2", note("t2", "x"))],
    )
    .await;
    let rest = all_pages(
        &engine,
        Plan {
            cursor: Some(cursor_bytes(&cursor.expect("a third note follows"))),
            ..plan(NOTE, "byTitle", 2)
        },
    )
    .await;

    assert_eq!(
        rest,
        vec![(ids(&["n4", "n5"]), true), (ids(&["n7"]), false)]
    );
}
