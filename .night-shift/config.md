# Night shift configuration

The `night-shift-worker`, `night-shift-coordinator`, and `refining-issues`
skills read this file. Every `##` heading below except `## Branch prefix` is
required. A missing heading is an error, not a default: stop and name the
heading you could not find. Anything that is not one of these headings is
protocol, and protocol lives in the skill.

## Visibility

`public`

There is nothing to withhold here. One sibling repository in this practice is
private, so never carry its contents into an issue or pull request in this one.

## Issue label

`ready`

## Read first

- `CLAUDE.md` — commands, layers, storage implementations, and where the
  Specification-to-SQL translation lives.

## Authority

`none`

## Before you fix

Reproduce first. An issue's repro may have been reconstructed rather than
verified by its reporter, so a repro that fails is a finding, not a failure.
Report it and open no pull request.

Much of this server's behavior comes from the `jinaga` library it depends on.
A defect may live there rather than here, and may already be fixed in a newer
`jinaga` release. Check which side of that boundary the defect is on before
changing code in this repository.

## Verification commands

Green before every push, in this order.

```
npm ci
npm run build
npm test
```

The container starts with no `node_modules`, so `npm ci` is not optional, and a
stale `node_modules` fails the build against types the current `jinaga`
exports. `npm test` type-checks and runs Jest without a database.

`npm run integration` needs Docker and PostgreSQL and is not part of the bar.

## CI workflow

`main.yml`

Read runs for this file; it is the merge gate. **It triggers on `pull_request`
with a `branches: [ main ]` filter**, so only a pull request whose base is
`main` gets check runs from its own pull request event. An upper layer of a
stack, whose base is the layer below, gets none. Treat that the way the skill
treats a layer with no run: dispatch the workflow on that branch and report it
as a finding.

`publish.yml` and `upgrade-jinaga.yml` do not gate a pull request. Address the
workflow by this file name rather than by its display name, `CI`.

## After the pull request

`none`

## What is different about this repository

This is a published npm package whose queue is mostly defects reported against
released versions. An issue may not reproduce at all, and saying so with
evidence is the whole result. Do not manufacture a fix to justify the session.

`upgrade-jinaga.yml` opens a pull request daily when a new `jinaga` is
published, on a branch named `upgrade/jinaga-<version>`. Those pull requests
are not night-shift work and are not prior work for an issue, unless the issue
is the upgrade itself.
