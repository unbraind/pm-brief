# Changelog

## 2026.8.24 - 2026-08-24

### Fixed

- Canonicalize the complete-corpus reader and adopt the current pm host contract ([pm-brief-v2ts](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-v2ts.toon))

## 2026.8.16 - 2026-08-16

### Fixed

- The pm CLI compatibility floor was declared only in peerDependencies, which only npm enforces, and not in manifest.json pm_min_version, which is the field the CLI enforces ([pm-brief-mtjj](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-mtjj.toon))
- pm-brief consumes a truncated `pm list-all` answer as if it were complete ([pm-brief-g6ko](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-g6ko.toon))

## 2026.8.14 - 2026-08-14

### Fixed

- Fix release publish ordering ahead of protected main push ([pm-brief-8754](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-8754.toon))
- The brief reported the side a merge requested as the side it kept, which under stable value order is the opposite of what happened ([pm-brief-bjll](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-bjll.toon))
- The pm CLI was a runtime dependency with no peer declaration, so consumers could resolve a second copy ([pm-brief-h7fg](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-h7fg.toon))

## 2026.8.10 - 2026-08-10

### Fixed

- Propagate the docstring gate entry guard fix ([pm-brief-rrmk](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-rrmk.toon))
- The release job generated the changelog in prepend mode and verified it in replace mode on the next line ([pm-brief-s33p](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-s33p.toon))
- The delta budget docstring stated the wrong fallback for a non-positive maxItems ([pm-brief-v4n0](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-v4n0.toon))

### Other

- Adopt the canonical pm-ops docstring gate ([pm-brief-jmnb](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-jmnb.toon))

## 2026.8.7 - 2026-08-07

### Fixed

- Gate durable PM project health in CI on pm CLI 2026.8.6 ([pm-brief-nkfr](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-nkfr.toon))

### Other

- Clear author-attribution health warning for \_workspace and pm-brief-ce55 history events ([pm-brief-3zb6](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/chores/pm-brief-3zb6.toon))

## 2026.8.5 - 2026-08-05

### Other

- Declare renderer ownership so the host enforces scoping the package only applied at runtime ([pm-brief-oir5](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-oir5.toon))

## 2026.8.4 - 2026-08-04

### Other

- Resolve pm-changelog to the release that derives release dates in UTC ([pm-brief-iqbi](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/chores/pm-brief-iqbi.toon))

## 2026.7.29 - 2026-07-29

### Added

- Enforce a real coverage gate by running tests against TypeScript sources ([pm-brief-xiv0](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/features/pm-brief-xiv0.toon))

### Other

- Adopt pm-cli 2026.7.29 ([pm-brief-3luv](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/chores/pm-brief-3luv.toon))

## 2026.7.28 - 2026-07-28

### Added

- Surface pending field-aware merge-decision receipts in pm brief ([pm-brief-nd0k](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/features/pm-brief-nd0k.toon))

### Fixed

- Merge-receipt display cap silently drops item warning markers past the tenth receipt ([pm-brief-8up0](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-8up0.toon))
- Merge-receipt read failures hard-fail every brief command ([pm-brief-a007](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-a007.toon))

### Other

- Adopt pm-cli 2026.7.28 ([pm-brief-owcy](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/chores/pm-brief-owcy.toon))

## 2026.7.27 - 2026-07-27

### Added

- Surface governance findings in agent briefs via sdk/governance ([pm-brief-q325](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/features/pm-brief-q325.toon))

### Fixed

- brief since redeclared host-owned --author global, failing registration on pm-cli 2026.7.27 ([pm-brief-xm71](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-xm71.toon))

### Other

- Adopt pm-cli 2026.7.26 typed authoring SDK: drop the any-cast defineExtension shim and move tests onto the real activation harness ([pm-brief-iapt](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-iapt.toon))

## 2026.7.26 - 2026-07-26

### Added

- Add pm brief duplicates post-merge near-duplicate sweep ([pm-brief-58en](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/features/pm-brief-58en.toon))

### Fixed

- Documented install command fails: pm install github.com/unbraind/pm-brief cannot resolve an entry file ([pm-brief-xd8z](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-xd8z.toon))

### Other

- Enable governance duplicate-detection advisory mode and restore parent_reference=warn ([pm-brief-k39x](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/chores/pm-brief-k39x.toon))

## 2026.7.25 - 2026-07-25

### Added

- pm brief diverge: pre-merge multi-agent item collision preview ([pm-brief-vj2y](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/features/pm-brief-vj2y.toon))

### Fixed

- CHANGELOG mislabels shipped 2026.7.23 work as Unreleased, leaving changelog:check red ([pm-brief-edam](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-edam.toon))

### Other

- Adopt --respect-item-release so release attribution matches the rest of the fleet ([pm-brief-ce55](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/chores/pm-brief-ce55.toon))

## 2026.7.23 - 2026-07-23

### Added

- Add pm brief since delta command for agent re-orientation after parallel/merge work ([pm-brief-da2c](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/features/pm-brief-da2c.toon))

### Fixed

- Recommend pm merge reconcile (2026.7.22) over raw history-repair in Multi-agent merge safety docs ([pm-brief-lizi](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-lizi.toon))

### Other

- Adopt pm field-aware merge driver for multi-agent branch-merge safety ([pm-brief-m2gp](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/chores/pm-brief-m2gp.toon))

## 2026.7.14-1 - 2026-07-14

### Other

- brief next: delegate ranking to SDK next() so it agrees with pm next ([pm-brief-wxzm](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-wxzm.toon))

## 2026.7.14 - 2026-07-14

### Fixed

- brief: blocked_by edges doubled in blockers/risks (dependencies + blocked_by both parsed) ([pm-brief-o4s9](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/issues/pm-brief-o4s9.toon))

## 2026.7.11-2 - 2026-07-11

### Other

- Ecosystem release readiness pass 2026-07-06 ([pm-brief-blz3](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-blz3.toon))

## 2026.7.11-1 - 2026-07-11

### Added

- brief momentum: velocity + cycle-time context from closed_at ([pm-brief-gza2](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/features/pm-brief-gza2.toon))

## 2026.7.10-1 - 2026-07-10

### Added

- Add stale context section to Slack brief and refresh toolchain deps ([pm-brief-tuj7](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-tuj7.toon))
- Full pm ecosystem production pass for pm-brief ([pm-brief-n4lw](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/features/pm-brief-n4lw.toon))

### Other

- Adversarial review pass 2026-07-10 ([pm-brief-kk7m](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/chores/pm-brief-kk7m.toon))
- Full-cycle hardening wave: pm-brief ([pm-brief-0dru](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-0dru.toon))
- Align pm-brief with pm CLI 2026.6.12 release readiness ([pm-brief-352i](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-352i.toon))
- Harden release bun-verify so registry-mirror lag cannot block the GitHub release ([pm-brief-93z7](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/chores/pm-brief-93z7.toon))

## 2026.7.6 - 2026-07-06

### Fixed

- Fix release CI ordering (publish-before-tag) ([pm-brief-5a57](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-5a57.toon))

### Other

- Align Node engine with pm CLI runtime ([pm-brief-7z60](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-7z60.toon))
- Align pm-brief changelog check with full changelog output ([pm-brief-v32p](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-v32p.toon))
- Refresh pm-brief to latest pm CLI and changelog toolchain ([pm-brief-93zx](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-93zx.toon))

## 2026.6.14 - 2026-06-14

### Other

- Regenerate CHANGELOG to drop the duplicate Unreleased section from pm-changelog issue 47 ([pm-brief-wo7u](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/chores/pm-brief-wo7u.toon))

## 2026.6.13 - 2026-06-13

### Added

- Add max-tokens alias and dependency-aware ordering ([pm-brief-nu7u](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/features/pm-brief-nu7u.toon))
- Add agent handoff prompt command to pm-brief ([pm-brief-am6l](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/features/pm-brief-am6l.toon))
- Add evidence-weighted next-action ranking ([pm-brief-6xr0](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/features/pm-brief-6xr0.toon))

### Fixed

- Fix release workflow staging when dist is gitignored ([pm-brief-bald](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-bald.toon))

### Other

- Daily Release publish step runs prepublishOnly post-tag: align npm publish with --ignore-scripts ([pm-brief-k5em](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-k5em.toon))

## 2026.6.7 - 2026-06-06

### Added

- Build pm-brief MVP ([pm-brief-ogmd](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/features/pm-brief-ogmd.toon))

### Other

- Verify pm-brief release readiness ([pm-brief-sub4](https://github.com/unbraind/pm-brief/blob/main/.agents/pm/tasks/pm-brief-sub4.toon))
