# Validation of the bundle integration — 2026-10-12

## Result

The migration and the boundary review were integrated, including extensible
credentials, configuration and transport as installed bundles, declared
exposure in the bridge, grouping of the directories and recovery of the Docker
sandbox. The defects found in the E2E were fixed and the affected scenarios
repeated.

| Check                                                           | Result                                                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Workspace typecheck                                             | 47 projects passed                                                                             |
| Workspace build                                                 | 48 projects passed                                                                             |
| Workspace tests with PostgreSQL and Docker                      | 48 projects checked; three initial failures fixed and the three projects repeated successfully |
| Real PostgreSQL, including the credentials migration            | 110/110                                                                                        |
| Docker sandbox, including reattachment and configuration change | 60 tests passed                                                                                |
| Electron application, unit tests after the fixes                | 108/108                                                                                        |
| Integration with real Electron                                  | 42/42                                                                                          |
| API E2E                                                         | 21/21                                                                                          |
| Interface E2E over CDP                                          | 18/18, consolidating the full run and the targeted fixes                                       |
| Navigation, windows, recovery and composition                   | 8/8                                                                                            |
| Host restart with SSH, normal and abrupt                        | Same container, one sandbox per Project, file preserved and terminal operational               |
| Nx sync, formatting, lint and diff whitespace                   | Passed                                                                                         |

The optional recording of a new fixture of the old adapter was not enabled in
the workspace suite. The database and sandbox tests were run with their flags
enabled.

## Docker image

Tag: `doric-host:boundary-final`.

Image ID:
`sha256:2799f4c6dfbc543300dbaf81d5b4be12ad5c866a7c83353f986e4388c9094072`.

Final build:

```sh
DOCKER_BUILDKIT=0 docker build --network host -f agents/doric/.Dockerfile --target docker-runtime -t doric-host:boundary-final .
```

The image compiles and ships the host, desktop and client parts of the
bundles. The host network was used after npm registry timeouts in the Docker
environment. The final image was started in the isolated stack and served the
bundles of the repeated interface scenarios. The stack for normal use was not
replaced.

## Defects fixed during validation

- The distributed catalog dropped `optional` and `desktopScope`.
- The desktop notification and history services did not declare exposure.
- Chat did not declare history as an optional dependency.
- The generic storage migration service was not announced to the process of
  the desktop generation. The regression test failed before the fix.
- App exit did not wait for the last route to be written. The previous route
  could reappear when the app was opened again.
- Fixture paths and test providers still reflected the previous layout of the
  packages.

The history cache was observed on disk during the CDP run. Notifications were
checked for an observed Thread, an unselected Thread and an unfocused window.
The selection and the conversation were checked after closing and reopening
the app.

## Comparison with the baseline

Baseline: `eda9171`, with the adjustment of the host address used by the
harness.

- API: 20 identical normalized snapshots. The rest differ only by the port of
  the fake model, `3310` versus `3313`, inside a fragment of streaming
  arguments.
- Interface: the 16 scenarios passed in the full run had identical structural
  snapshots; the notifications one was also identical after the fix.
- The persistence scenario passed after the fix. Its snapshot contains an
  additional prompt because the notifications scenario was repeated over the
  same state. The difference is in the conversation and in the corresponding
  entry of the trail; the other fields of the snapshot match. The original
  snapshot was preserved.
- The pixel comparison was inspected. In the common captures, the deviations
  were between 0% and 0.257%, involving the random color of the Project,
  resource measurements and a tooltip. It is evidence complementary to the
  checks of content, accessible roles and interaction.
- The terminal probe now observed one sandbox after restart, against two in
  the baseline. This is the duplication fix approved by the user.

A full run was made at the end of the integration. After it, only the affected
scenarios and targeted checks were repeated; the assertions were not weakened
nor the baseline replaced.

## Local evidence

The harness and the snapshots are in the session scratchpad:
`d9356596-617b-42da-9431-4460753976c9/scratchpad/e2e-boundary-final`.

- `final-evidence.json`: consolidated result, with the sources of the
  scenarios.
- `snapshots/boundary-final`: full run of API, interface and step 9.
- `snapshots/boundary-corrections`: notifications and persistence after the
  fix.
- `snapshots/boundary-terminal/probe-term.json`: recovery with SSH.
- `/tmp/doric-final-docker6.log`: build of the final image.
- `/tmp/doric-final-tests2.log` and `/tmp/doric-final-tests-fixed.log`: broad
  run and repetition of the fixed projects.
- `/tmp/doric-final-electron2.log`: Electron integration.
- `/tmp/doric-final-ui-corrections3.log`: fixed scenarios.

External installation of bundles and verification against published versions
remain deferred, per an earlier decision of the user; they were not part of
the existing functionality used as reference.
