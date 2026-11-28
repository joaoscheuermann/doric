use std::collections::HashMap;

use doric_bundle::CancellationToken;
use doric_sqlite::KvEngine as _;
use doric_storage::{layout, schema::DESCRIPTOR_SET_BYTES};
use prost::Message as _;

use super::*;
use crate::testing::{TempDir, caller, code_of, detail_str, open_temp, storage_set};

fn call_from(bundle_id: &str) -> Call {
    Call {
        caller: caller(bundle_id, 1),
        scope: HashMap::new(),
        traceparent: String::new(),
        deadline: None,
        cancelled: CancellationToken::new(),
    }
}

fn request(descriptor_set: Vec<u8>) -> RegisterRequest {
    RegisterRequest { descriptor_set }
}

fn valid_set() -> Vec<u8> {
    storage_set(
        "message Note {\n\
           option (doric.platform.v1.storage_type) = { type: \"a.note/v1\" };\n\
           string slug = 1;\n\
         }",
    )
}

#[tokio::test]
async fn the_platform_is_not_owner_before_the_store() {
    let result = Engine::default()
        .register(call_from("doric"), request(valid_set()))
        .await;

    assert_eq!(code_of(result), "not_owner");
}

#[tokio::test]
async fn a_set_over_the_limit_is_refused_before_the_store() {
    let result = Engine::default()
        .register(
            call_from("a"),
            request(vec![0xFF; DESCRIPTOR_SET_BYTES + 1]),
        )
        .await;

    assert_eq!(code_of(result), "limit_exceeded");
}

#[tokio::test]
async fn a_valid_set_before_activation_is_unavailable() {
    let result = Engine::default()
        .register(call_from("a"), request(valid_set()))
        .await;

    assert_eq!(code_of(result), "unavailable");
}

/// The items of the `Read` stream of `engine` for `request` from `bundle_id`.
async fn read_items(
    engine: &Engine,
    bundle_id: &str,
    request: ReadRequest,
) -> Vec<Result<ReadResponse, ContractError>> {
    engine
        .read_stream(call_from(bundle_id), request)
        .collect()
        .await
}

fn read_request(stream: &str) -> ReadRequest {
    ReadRequest {
        stream_read: Some(doric_storage::v2::StreamRead {
            stream: stream.to_owned(),
            after_sequence: 0.0,
            limit: 1,
        }),
    }
}

#[tokio::test]
async fn a_valid_read_before_activation_is_unavailable() {
    let items = read_items(&Engine::default(), "a", read_request("a.s/k")).await;

    assert_eq!(items.len(), 1);
    assert_eq!(
        code_of(items.into_iter().next().expect("one item")),
        "unavailable"
    );
}

#[tokio::test]
async fn a_read_is_checked_before_the_store() {
    for (bundle_id, stream, code) in [
        ("doric", "a.s/k", "not_owner"),
        ("a", "b.s/k", "not_owner"),
        ("a", "a.s/", "invalid_stream"),
    ] {
        let items = read_items(&Engine::default(), bundle_id, read_request(stream)).await;

        assert_eq!(items.len(), 1, "{stream}");
        assert_eq!(code_of(items.into_iter().next().expect("one item")), code);
    }
}

#[tokio::test]
async fn a_read_on_the_open_store_answers_the_page_of_an_absent_stream() {
    let (_dir, store) = open_temp();
    let engine = Engine::default();
    assert!(engine.store.set(store).is_ok(), "the store is set once");

    let items = read_items(&engine, "a", read_request("a.s/k")).await;

    assert_eq!(
        items,
        vec![Ok(ReadResponse {
            item: Some(doric_storage::v2::read_response::Item::Page(
                doric_storage::v2::StreamPage {
                    last_sequence: 0.0,
                    truncations: Vec::new(),
                }
            )),
        })]
    );
}

#[tokio::test]
async fn a_valid_set_registers_on_the_open_store() {
    let (_dir, store) = open_temp();
    let engine = Engine::default();
    assert!(engine.store.set(store).is_ok(), "the store is set once");

    let response = engine.register(call_from("a"), request(valid_set())).await;

    assert_eq!(response, Ok(RegisterResponse {}));
    let key = layout::declaration("a", "a.note/v1");
    let stored = engine
        .store()
        .expect("the store is open")
        .read(move |txn| txn.get(&key))
        .await
        .expect("the read succeeds")
        .expect("the declaration is stored");
    let declaration = layout::TypeDeclaration::decode(stored.0.as_slice()).expect("a declaration");
    assert_eq!(declaration.message_type, "fixture.v1.Note");
}

#[tokio::test]
async fn an_invalid_cache_setting_is_refused_before_the_open() {
    let dir = TempDir::new();
    let engine = Engine::default();

    let error = engine
        .activate_from(Some(dir.path().into()), Some("2".into()))
        .await
        .expect_err("the setting is refused");

    assert_eq!(error.code, "invalid_input");
    assert_eq!(
        detail_str(&error, "variable").as_deref(),
        Some(CACHE_VARIABLE)
    );
    assert_eq!(code_of(engine.store().map(|_| ())), "unavailable");
    assert!(
        !dir.path().join("doric.sqlite3").exists(),
        "the store was opened"
    );
}

#[tokio::test]
async fn a_cache_setting_of_0_activates_with_no_cache() {
    let dir = TempDir::new();
    let engine = Engine::default();

    let activated = engine
        .activate_from(Some(dir.path().into()), Some("0".into()))
        .await;

    assert_eq!(activated, Ok(()));
    assert_eq!(engine.headers().bound(), 0);
    engine.stop().await;
}

// S78b: `Health` and the blob methods before activation, and `Health` after
// it (R14).

const UNKNOWN_HASH: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";

/// The one chunk `[1, 2, 3]` of a `PutBlob` stream.
fn blob_chunks() -> impl Stream<Item = Result<PutBlobRequest, ContractError>> + Unpin + Send {
    tokio_stream::iter(vec![Ok(PutBlobRequest {
        chunk: vec![1, 2, 3],
    })])
}

/// The code of the one item of the `GetBlob` stream of `engine` for
/// `UNKNOWN_HASH` from `bundle_id`.
async fn get_blob_code(engine: &Engine, bundle_id: &str) -> String {
    let items: Vec<_> = engine
        .get_blob(
            call_from(bundle_id),
            GetBlobRequest {
                hash: UNKNOWN_HASH.to_owned(),
            },
        )
        .collect()
        .await;
    assert_eq!(items.len(), 1, "{bundle_id}");
    code_of(items.into_iter().next().expect("one item"))
}

#[tokio::test]
async fn health_and_the_blob_methods_before_activation_are_unavailable() {
    let engine = Engine::default();

    assert_eq!(
        code_of(engine.health(call_from("a"), HealthRequest {}).await),
        "unavailable"
    );
    assert_eq!(
        code_of(engine.put_blob(call_from("a"), blob_chunks()).await),
        "unavailable"
    );
    assert_eq!(get_blob_code(&engine, "a").await, "unavailable");
    assert_eq!(
        code_of(
            engine
                .delete_blob(
                    call_from("a"),
                    DeleteBlobRequest {
                        hash: UNKNOWN_HASH.to_owned(),
                    },
                )
                .await
        ),
        "unavailable"
    );
}

#[tokio::test]
async fn the_platform_is_not_owner_of_health_and_the_blob_methods_before_the_store() {
    let engine = Engine::default();

    assert_eq!(
        code_of(engine.health(call_from("doric"), HealthRequest {}).await),
        "not_owner"
    );
    assert_eq!(
        code_of(engine.put_blob(call_from("doric"), blob_chunks()).await),
        "not_owner"
    );
    assert_eq!(get_blob_code(&engine, "doric").await, "not_owner");
    assert_eq!(
        code_of(
            engine
                .delete_blob(
                    call_from("doric"),
                    DeleteBlobRequest {
                        hash: UNKNOWN_HASH.to_owned(),
                    },
                )
                .await
        ),
        "not_owner"
    );
}

#[tokio::test]
async fn health_after_activation_measures_the_storage_path() {
    let dir = TempDir::new();
    let engine = Engine::default();
    engine
        .activate_from(Some(dir.path().into()), None)
        .await
        .expect("the activation succeeds");

    let response = engine
        .health(call_from("a"), HealthRequest {})
        .await
        .expect("health answers");

    let health = response.storage_health.expect("a storage health");
    assert_eq!(health.status, "ok");
    assert!(health.writable);
    assert!(health.disk.is_some(), "a measured disk");
    engine.stop().await;
}
