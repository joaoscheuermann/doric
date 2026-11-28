//! S77a3b: `check`, a query's checks before any I/O, in their order, and the
//! plan it answers (Q1–Q4b).

use super::*;

#[test]
fn an_absent_storage_query_is_refused() {
    let error = check("a", &QueryRequest::default()).expect_err("no storage_query");

    assert_eq!(
        code_and_message(&error),
        ("invalid_input", "A query request holds a storage_query.")
    );
    assert_eq!(error.details, None);
}

#[test]
fn a_type_of_another_namespace_or_too_long_is_refused() {
    let error = refused(query("b.x/v1", "byTag"));
    assert_eq!(error.code, "not_owner");
    assert_eq!(detail_str(&error, "type").as_deref(), Some("b.x/v1"));

    let long_type = format!("a.{}", "x".repeat(127));
    assert_eq!(long_type.len(), 129);
    let error = refused(query(&long_type, "byTag"));
    assert_eq!(error.code, "invalid_input");
    assert_eq!(
        detail_str(&error, "type").as_deref(),
        Some(long_type.as_str())
    );
}

#[test]
fn a_limit_out_of_1_to_1000_is_refused() {
    for limit in [0, 1001, -1] {
        let error = refused(StorageQuery {
            limit,
            ..query(NOTE, "byTag")
        });
        assert_eq!(
            code_and_message(&error),
            (
                "invalid_input",
                format!("A query's limit is 1 to 1000; {limit} is not.").as_str()
            )
        );
    }
    for limit in [1, 1000] {
        check(
            "a",
            &request(StorageQuery {
                limit,
                ..query(NOTE, "byTag")
            }),
        )
        .expect("a limit of 1 to 1000 passes");
    }
}

#[test]
fn an_order_other_than_asc_or_desc_is_refused() {
    let error = refused(StorageQuery {
        order: Some("up".to_owned()),
        ..query(NOTE, "byTag")
    });

    assert_eq!(
        code_and_message(&error),
        (
            "invalid_input",
            "A query's order is \"asc\" or \"desc\"; \"up\" is not."
        )
    );
}

#[test]
fn the_checks_run_in_their_order() {
    // The type's length, then its namespace, before the limit.
    let error = refused(StorageQuery {
        limit: 0,
        ..query("b.x/v1", "byTag")
    });
    assert_eq!(error.code, "not_owner");
    let long_type = format!("a.{}", "x".repeat(127));
    let error = refused(StorageQuery {
        limit: 0,
        ..query(&long_type, "byTag")
    });
    assert_eq!(
        detail_str(&error, "type").as_deref(),
        Some(long_type.as_str())
    );

    // The limit before the order.
    let error = refused(StorageQuery {
        limit: 0,
        order: Some("up".to_owned()),
        ..query(NOTE, "byTag")
    });
    assert_eq!(error.message, "A query's limit is 1 to 1000; 0 is not.");

    // The order before the values.
    let error = refused(StorageQuery {
        order: Some("up".to_owned()),
        equals: vec![struct_value()],
        ..query(NOTE, "byTag")
    });
    assert_eq!(
        error.message,
        "A query's order is \"asc\" or \"desc\"; \"up\" is not."
    );

    // The values before the pairs.
    let error = refused(StorageQuery {
        range: Some(StorageRange {
            gt: Some(struct_value()),
            gte: Some(string("a")),
            ..StorageRange::default()
        }),
        ..query(NOTE, "byTitle")
    });
    assert_eq!(error.code, "invalid_index_value");

    // The pairs before the cursor.
    let error = refused(StorageQuery {
        range: Some(StorageRange {
            gt: Some(string("a")),
            gte: Some(string("a")),
            ..StorageRange::default()
        }),
        cursor: Some("AA==".to_owned()),
        ..query(NOTE, "byTitle")
    });
    assert_eq!(error.message, "A range takes either gt or gte, not both.");
}

#[test]
fn a_struct_or_list_value_is_refused_in_equals_and_in_a_bound() {
    let struct_message = "A query value is a string, a number, a boolean or null, not a struct.";
    let list_message = "A query value is a string, a number, a boolean or null, not a list.";
    for (value, message) in [
        (struct_value(), struct_message),
        (list_value(), list_message),
    ] {
        let error = refused(StorageQuery {
            equals: vec![string("x"), value.clone()],
            ..query(NOTE, "byTag")
        });
        assert_eq!(
            code_and_message(&error),
            ("invalid_index_value", message),
            "in equals"
        );

        let error = refused(StorageQuery {
            range: Some(StorageRange {
                lte: Some(value),
                ..StorageRange::default()
            }),
            ..query(NOTE, "byTitle")
        });
        assert_eq!(
            code_and_message(&error),
            ("invalid_index_value", message),
            "in a bound"
        );
    }
}

#[test]
fn a_value_with_no_kind_is_refused() {
    let error = refused(StorageQuery {
        equals: vec![no_kind()],
        ..query(NOTE, "byTag")
    });
    assert_eq!(
        code_and_message(&error),
        ("invalid_input", "A query value has no kind.")
    );

    let error = refused(StorageQuery {
        range: Some(StorageRange {
            gt: Some(no_kind()),
            ..StorageRange::default()
        }),
        ..query(NOTE, "byTitle")
    });
    assert_eq!(
        code_and_message(&error),
        ("invalid_input", "A query value has no kind.")
    );
}

#[test]
fn a_number_that_is_not_finite_is_refused() {
    let error = refused(StorageQuery {
        equals: vec![number(f64::NAN)],
        ..query(NOTE, "byTag")
    });
    assert_eq!(
        code_and_message(&error),
        (
            "invalid_index_value",
            "An indexed number must be finite, not NaN."
        )
    );

    let error = refused(StorageQuery {
        range: Some(StorageRange {
            lt: Some(number(f64::NEG_INFINITY)),
            ..StorageRange::default()
        }),
        ..query(NOTE, "byTitle")
    });
    assert_eq!(
        code_and_message(&error),
        (
            "invalid_index_value",
            "An indexed number must be finite, not -Infinity."
        )
    );
}

#[test]
fn both_bounds_of_a_pair_are_refused() {
    let error = refused(StorageQuery {
        range: Some(StorageRange {
            gt: Some(string("a")),
            gte: Some(string("a")),
            ..StorageRange::default()
        }),
        ..query(NOTE, "byTitle")
    });
    assert_eq!(
        code_and_message(&error),
        ("invalid_input", "A range takes either gt or gte, not both.")
    );

    let error = refused(StorageQuery {
        range: Some(StorageRange {
            lt: Some(string("z")),
            lte: Some(string("z")),
            ..StorageRange::default()
        }),
        ..query(NOTE, "byTitle")
    });
    assert_eq!(
        code_and_message(&error),
        ("invalid_input", "A range takes either lt or lte, not both.")
    );
}

#[test]
fn a_cursor_that_is_not_unpadded_base64url_is_refused() {
    for cursor in ["AA==", "+/"] {
        let error = refused(StorageQuery {
            cursor: Some(cursor.to_owned()),
            ..query(NOTE, "byTitle")
        });
        assert_eq!(
            code_and_message(&error),
            ("invalid_input", "A cursor is unpadded base64url."),
            "{cursor}"
        );
    }
}

#[test]
fn a_valid_cursor_decodes_into_the_plan() {
    let plan = check(
        "a",
        &request(StorageQuery {
            cursor: Some("-_8".to_owned()),
            ..query(NOTE, "byTitle")
        }),
    )
    .expect("a valid cursor");

    assert_eq!(plan.cursor, Some(vec![0xFB, 0xFF]));
}

#[test]
fn a_valid_query_gives_its_plan() {
    let plan = check(
        "a",
        &request(StorageQuery {
            equals: vec![
                string("x"),
                Value {
                    kind: Some(Kind::NullValue(0)),
                },
                Value {
                    kind: Some(Kind::BoolValue(true)),
                },
            ],
            range: Some(StorageRange {
                gt: Some(number(1.5)),
                lte: Some(string("z")),
                ..StorageRange::default()
            }),
            order: Some("desc".to_owned()),
            limit: 5,
            ..query(NOTE, "byTitle")
        }),
    )
    .expect("a valid query");

    assert_eq!(
        plan,
        Plan {
            type_id: NOTE.to_owned(),
            index: "byTitle".to_owned(),
            equals: vec![element("x"), Element::Null, Element::Bool(true)],
            range: Some(Range {
                gt: Some(Element::Number(1.5)),
                lte: Some(element("z")),
                ..Range::default()
            }),
            reverse: true,
            limit: 5,
            cursor: None,
        }
    );
}

#[test]
fn an_absent_range_and_an_empty_range_differ_in_the_plan() {
    let absent = check("a", &request(query(NOTE, "byTitle"))).expect("no range");
    assert_eq!(absent, plan(NOTE, "byTitle", 10));

    let empty = check(
        "a",
        &request(StorageQuery {
            range: Some(StorageRange::default()),
            order: Some("asc".to_owned()),
            ..query(NOTE, "byTitle")
        }),
    )
    .expect("an empty range");
    assert_eq!(
        empty,
        Plan {
            range: Some(Range::default()),
            ..plan(NOTE, "byTitle", 10)
        }
    );
}
