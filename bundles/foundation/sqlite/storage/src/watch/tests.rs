//! S78c: a watch request's checks, and which published changes reach which
//! watcher, the buffer of [`BUFFER`] responses and a dropped watcher (R12).

use std::time::Duration;

use tokio_stream::StreamExt as _;

use super::*;
use crate::testing::{NOTE, PLAIN, detail_str};

const STREAM: &str = "a.s/k";
const OTHER_STREAM: &str = "a.s/other";

fn watching(types: &[&str], streams: &[&str]) -> WatchRequest {
    WatchRequest {
        types: types.iter().map(|&t| t.to_owned()).collect(),
        streams: streams.iter().map(|&s| s.to_owned()).collect(),
    }
}

fn document(type_id: &str, id: &str, revision: f64) -> WatchDocument {
    WatchDocument {
        r#type: type_id.to_owned(),
        id: id.to_owned(),
        revision,
        deleted: false,
    }
}

fn stream(stream: &str, last_sequence: f64) -> WatchStream {
    WatchStream {
        stream: stream.to_owned(),
        last_sequence,
    }
}

fn change(position: f64, documents: Vec<WatchDocument>, streams: Vec<WatchStream>) -> Change {
    Change {
        position,
        documents,
        streams,
    }
}

/// A change at `position` that touches only the watched type [`NOTE`].
fn note_change(position: f64) -> Change {
    change(position, vec![document(NOTE, "n1", position)], vec![])
}

/// The next item of `watch`, failing the test after 5 s instead of hanging.
async fn next<S>(watch: &mut S) -> Option<Result<WatchResponse, ContractError>>
where
    S: Stream<Item = Result<WatchResponse, ContractError>> + Unpin,
{
    tokio::time::timeout(Duration::from_secs(5), watch.next())
        .await
        .expect("the watch answers within 5 s")
}

async fn next_response<S>(watch: &mut S) -> WatchResponse
where
    S: Stream<Item = Result<WatchResponse, ContractError>> + Unpin,
{
    next(watch)
        .await
        .expect("the watch has not ended")
        .expect("the watch has not failed")
}

#[test]
fn a_request_of_the_bundles_types_and_streams_passes_and_so_does_an_empty_one() {
    assert!(check("a", &watching(&[NOTE, PLAIN], &[STREAM, OTHER_STREAM])).is_ok());
    assert!(check("a", &watching(&[], &[])).is_ok());
}

#[test]
fn a_type_of_another_namespace_is_not_owner() {
    let error = check("a", &watching(&[NOTE, "b.note/v1"], &[])).expect_err("refused");

    assert_eq!(error.code, "not_owner");
    assert_eq!(detail_str(&error, "type").as_deref(), Some("b.note/v1"));
}

#[test]
fn a_stream_of_another_bundle_is_not_owner() {
    let error = check("a", &watching(&[], &[STREAM, "b.s/k"])).expect_err("refused");

    assert_eq!(error.code, "not_owner");
    assert_eq!(detail_str(&error, "stream").as_deref(), Some("b.s/k"));
}

#[test]
fn a_stream_id_not_of_the_stream_form_is_invalid_stream() {
    for id in ["a/k", "a.s/", "a.s/x y"] {
        let error = check("a", &watching(&[], &[id])).expect_err("refused");

        assert_eq!(error.code, "invalid_stream", "{id}");
        assert_eq!(detail_str(&error, "stream").as_deref(), Some(id));
    }
}

#[test]
fn the_caller_doric_is_not_owner_even_with_an_empty_request() {
    for request in [
        watching(&[], &[]),
        watching(&["doric.x/v1"], &["doric.s/k"]),
    ] {
        let error = check("doric", &request).expect_err("refused");

        assert_eq!(error.code, "not_owner", "{request:?}");
    }
}

#[tokio::test]
async fn a_watcher_receives_only_the_watched_entries_of_each_touching_change() {
    let watchers = Watchers::default();
    let mut watch = Box::pin(watchers.subscribe("a", watching(&[NOTE], &[STREAM])));

    watchers.publish(
        "a",
        &change(
            7.0,
            vec![document(NOTE, "n1", 2.0), document(PLAIN, "p1", 1.0)],
            vec![stream(STREAM, 3.0), stream(OTHER_STREAM, 9.0)],
        ),
    );

    assert_eq!(
        next_response(&mut watch).await,
        WatchResponse {
            position: 7.0,
            documents: vec![document(NOTE, "n1", 2.0)],
            streams: vec![stream(STREAM, 3.0)],
        }
    );
}

#[tokio::test]
async fn a_change_of_other_types_streams_or_bundles_reaches_no_watcher() {
    let watchers = Watchers::default();
    let mut watch = Box::pin(watchers.subscribe("a", watching(&[NOTE], &[STREAM])));

    watchers.publish("a", &change(1.0, vec![document(PLAIN, "p1", 1.0)], vec![]));
    watchers.publish("a", &change(2.0, vec![], vec![stream(OTHER_STREAM, 1.0)]));
    // Ids match exactly: neither a prefix nor an extension of a watched id.
    watchers.publish(
        "a",
        &change(3.0, vec![document("a.note/v10", "n1", 1.0)], vec![]),
    );
    watchers.publish("a", &change(4.0, vec![], vec![stream("a.s/kk", 1.0)]));
    watchers.publish("b", &change(5.0, vec![document(NOTE, "n1", 1.0)], vec![]));
    watchers.publish("a", &note_change(6.0));

    assert_eq!(next_response(&mut watch).await.position, 6.0);
}

#[tokio::test]
async fn an_empty_request_receives_nothing() {
    let watchers = Watchers::default();
    let mut empty = Box::pin(watchers.subscribe("a", watching(&[], &[])));
    let mut notes = Box::pin(watchers.subscribe("a", watching(&[NOTE], &[])));

    watchers.publish("a", &note_change(1.0));
    assert_eq!(next_response(&mut notes).await.position, 1.0);

    let item = tokio::time::timeout(Duration::from_millis(100), empty.next()).await;
    assert!(item.is_err(), "the empty watch answered {item:?}");
}

#[tokio::test]
async fn each_watcher_receives_the_changes_in_publication_order() {
    let watchers = Watchers::default();
    let mut first = Box::pin(watchers.subscribe("a", watching(&[NOTE], &[])));
    let mut second = Box::pin(watchers.subscribe("a", watching(&[NOTE], &[STREAM])));

    for position in 1..=3 {
        watchers.publish("a", &note_change(f64::from(position)));
    }

    for watch in [&mut first, &mut second] {
        for position in 1..=3 {
            assert_eq!(next_response(watch).await.position, f64::from(position));
        }
    }
}

#[tokio::test]
async fn a_watcher_subscribed_after_a_change_does_not_receive_it() {
    let watchers = Watchers::default();
    watchers.publish("a", &note_change(1.0));
    let mut watch = Box::pin(watchers.subscribe("a", watching(&[NOTE], &[])));

    watchers.publish("a", &note_change(2.0));

    assert_eq!(next_response(&mut watch).await.position, 2.0);
}

#[tokio::test]
async fn a_watcher_with_a_full_buffer_that_reads_it_stays_open() {
    let watchers = Watchers::default();
    let mut watch = Box::pin(watchers.subscribe("a", watching(&[NOTE], &[])));

    for position in 1..=BUFFER {
        watchers.publish("a", &note_change(position as f64));
    }
    for position in 1..=BUFFER {
        assert_eq!(next_response(&mut watch).await.position, position as f64);
    }
    watchers.publish("a", &note_change((BUFFER + 1) as f64));

    assert_eq!(
        next_response(&mut watch).await.position,
        (BUFFER + 1) as f64
    );
}

#[tokio::test]
async fn a_watcher_that_falls_behind_gets_its_buffer_then_unavailable_then_ends() {
    let watchers = Watchers::default();
    let mut watch = Box::pin(watchers.subscribe("a", watching(&[NOTE], &[])));

    for position in 1..=BUFFER + 1 {
        watchers.publish("a", &note_change(position as f64));
    }

    for position in 1..=BUFFER {
        assert_eq!(next_response(&mut watch).await.position, position as f64);
    }
    let error = next(&mut watch)
        .await
        .expect("an error ends the watch")
        .expect_err("the watch fell behind");
    assert_eq!(error.code, "unavailable");
    assert_eq!(error.message, "Watch fell behind.");
    assert!(next(&mut watch).await.is_none(), "the watch has ended");
}

#[tokio::test]
async fn a_watcher_that_falls_behind_does_not_end_the_others() {
    let watchers = Watchers::default();
    let mut slow = Box::pin(watchers.subscribe("a", watching(&[NOTE], &[])));
    let mut fast = Box::pin(watchers.subscribe("a", watching(&[NOTE], &[])));

    for position in 1..=BUFFER + 2 {
        watchers.publish("a", &note_change(position as f64));
        assert_eq!(next_response(&mut fast).await.position, position as f64);
    }

    for _ in 0..BUFFER {
        assert!(next_response(&mut slow).await.position <= BUFFER as f64);
    }
    let ended = next(&mut slow).await.expect("an error ends the watch");
    assert_eq!(ended.expect_err("fell behind").code, "unavailable");
}

#[tokio::test]
async fn a_dropped_watcher_is_unsubscribed_and_the_others_still_receive() {
    let watchers = Watchers::default();
    let dropped = Box::pin(watchers.subscribe("a", watching(&[NOTE], &[])));
    let mut kept = Box::pin(watchers.subscribe("a", watching(&[NOTE], &[])));
    drop(dropped);

    // More publishes than the dropped watcher's buffer holds: had it stayed
    // subscribed, nothing would read them.
    for position in 1..=BUFFER + 1 {
        watchers.publish("a", &note_change(position as f64));
        assert_eq!(next_response(&mut kept).await.position, position as f64);
    }
}

#[tokio::test]
async fn clones_share_their_watchers() {
    let watchers = Watchers::default();
    let mut watch = Box::pin(watchers.subscribe("a", watching(&[NOTE], &[])));

    watchers.clone().publish("a", &note_change(1.0));

    assert_eq!(next_response(&mut watch).await.position, 1.0);
}
